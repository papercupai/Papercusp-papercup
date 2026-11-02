/** Exact work-item/spec-revision coverage and immutable evidence bindings (P-005). */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hostname } from 'node:os';
import fastGlob from 'fast-glob';
import pLimit from 'p-limit';
import type { Sql } from 'postgres';
import { z } from 'zod';
import ts from 'typescript';
import { detectBroadRepoTreeScanOffThread, TREE_SCAN_MAX_REQUESTS } from '../../cpu-task-worker';
import { mapWithConcurrency } from '../../gym/concurrency';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { withWorkspace } from '@papercusp/db-org';
import {
  parseTestRunExecutionDetails,
  passedCaseTitlesIncomplete,
  stableRecordedRuntimeEnvironment,
} from '@papercusp/test-config/execution-details';
import { CALIBRATION_LEGS } from '@papercusp/test-config/mutation-descriptor';
import { listRuntimeVintage } from '../../runtime-vintage';
import { measureRuntimeEnvironment } from '../../remote-runtime-identity';
import { defaultEvidenceRoot, legacyEvidenceRoot } from '@papercusp/verification-harness';
import { pgTimestampToIso } from '../../pg-timestamp';
import { areAcceptanceLineageRelated, resolvePlanImplementerIdentities } from '../../acceptance-author-identity';
import { planItemRef } from '../../issue-blocks-merge';
import { planItemProvenanceFromRow } from '../../plan-item-provenance';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';
import { ADHOC_WORK_ITEM_SPEC_SCOPE, resolveSpecScopeSlug } from './adhoc-spec-scope';
import type { SpecClauseSql } from './spec-clauses-store';
// Type-only: spec-test-adequacy imports this module, so its runtime is loaded lazily below.
import type { FixtureAbsencePairingKey } from './spec-test-adequacy';
import { declaredConfigurationFingerprint, parseProductionConfiguration } from './declared-configuration';
import type { resolvePlanScope as ResolvePlanScope } from './source';
import { trackDetached } from '../../detached-imports';
import { measurePackagedArtifactEnvironment } from './packaged-artifact-evidence';
import { measureNativeColdEnvironment, nativeColdInstrumentKeySchema } from '../../storage/cold-tier-evidence';
import { foldTreeInstrumentFingerprint, measureTreeInstrumentAtCommit, treeInstrumentKeySchema, type TreeInstrumentKey } from './tree-instruments';
import { ensureBootstrap, getTxPool, readQueue } from '../locks/su-lock-store';
import {
  createCommittedTreeDiagnostics,
  defaultBlobBatchReader,
  fingerprintRepoFileSetAtCommit,
  listCommittedGlobMatches,
  locateCommittedBlobs,
  readCommittedFiles,
  repoFileSetFingerprint,
  REPO_FILE_SET_READ_LIMITS,
  REPO_FIXTURE_READ_LIMITS,
  resolveMeasurementCommit,
  type CommittedTreeDeps,
  type CommittedTreeDiagnostics,
  type RepoFileSetReadLimits,
} from './committed-tree-reader';
import {
  MEASUREMENT_PIN_DETAILS_KEY,
  defaultGitRunner,
  buildMeasurementPin,
  diffMeasuredFiles,
  readMeasurementPin,
  type GitRunner,
  type MeasuredRepoFile,
  type MeasurementPin,
  type MovedPath,
} from './evidence-measurement-pin';

export { ADHOC_WORK_ITEM_SPEC_SCOPE, MEASUREMENT_PIN_DETAILS_KEY };
export type { MeasurementPin, MovedPath };

// Scope resolution reaches the plan/event runtime, which imports testing evidence.
// Loading it with this store evaluates that consumer before our schemas initialize
// (EI-27689464176702417). Operations need scope; schema construction does not.
async function resolvePlanScope(...args: Parameters<typeof ResolvePlanScope>) {
  return (await import('./source')).resolvePlanScope(...args);
}

export const SPEC_EVIDENCE_KINDS = [
  'test',
  'fixture',
  'coverage-census',
  'mutation',
  'counterexample',
  'check',
  'manual',
  'operational',
  // verification-system-improvements-2026-10-10 P-008 (D-005): a non-implementer's
  // re-observation of an implementer binding. Always cites that binding
  // (verifiesBindingId) and must match its source + environment fingerprints.
  'independent-verification',
] as const;
export type SpecEvidenceKind = (typeof SPEC_EVIDENCE_KINDS)[number];

// The case-title matching rule lives in the shared {file, testName} resolver
// (test-rubric-unification-2026-10-12 P-002) so rubric tests checks and spec
// evidence bindings cannot drift apart. Re-exported for existing importers.
import {
  hasSameCaseTitleIdentity,
  hasMatchingDeclaredCaseTitle,
  resolveTestCaseFilter,
  type RecordedTestCase,
} from '../../testing-case-filter';
export { hasSameCaseTitleIdentity, hasMatchingDeclaredCaseTitle };

/**
 * The per-case ledger rows (test_case_runs, migration 1478) of one test run, or null when
 * none are recorded — a run before 1478, or a reporter that never saw the module. Runs
 * inside the binding transaction, so the table's presence is probed with to_regclass
 * rather than by catching 42P01 (a caught error would still abort the transaction).
 */
async function readRecordedTestCases(
  tx: Sql,
  testRunId: number,
): Promise<{ file: string; cases: RecordedTestCase[] } | null> {
  const present = (await tx`SELECT to_regclass('harness_shared.test_case_runs') IS NOT NULL AS present`) as Array<{
    present: boolean;
  }>;
  if (!present[0]?.present) return null;
  const rows = (await tx`
    SELECT c.case_key, c.occurrence, c.status, c.duration_ms, r.file_path
      FROM harness_shared.test_case_runs c
      JOIN harness_shared.test_runs r ON r.id = c.test_run_id
     WHERE c.test_run_id = ${testRunId}
     ORDER BY c.case_index`) as Array<{
    case_key: string;
    occurrence: number;
    status: RecordedTestCase['status'];
    duration_ms: number | null;
    file_path: string | null;
  }>;
  if (rows.length === 0) return null;
  return {
    file: rows[0]!.file_path ?? `test-run ${testRunId}`,
    cases: rows.map((r) => ({
      caseKey: r.case_key,
      occurrence: r.occurrence,
      status: r.status,
      durationMs: r.duration_ms,
    })),
  };
}

type UniqueMeasuredCaseTitle =
  | { status: 'unmatched' }
  | { status: 'unique'; title: string }
  | { status: 'ambiguous'; matchingCaseTitles: string[] };

/**
 * Resolve the exact measured title to persist when a binding used a title suffix.
 * An exact identity wins over longer titles of which it is also a suffix; otherwise
 * a suffix is canonical only when it identifies one distinct measured title.
 */
function uniqueMeasuredCaseTitle(
  testName: string,
  matchedCaseTitles: readonly string[],
): UniqueMeasuredCaseTitle {
  if (matchedCaseTitles.length === 0) return { status: 'unmatched' };

  const exactMatches = matchedCaseTitles.filter((title) => hasSameCaseTitleIdentity(testName, title));
  const candidates = exactMatches.length > 0 ? exactMatches : matchedCaseTitles;
  const distinctTitles: string[] = [];
  for (const title of candidates) {
    if (!distinctTitles.some((existing) => hasSameCaseTitleIdentity(existing, title))) {
      distinctTitles.push(title);
    }
  }

  return distinctTitles.length === 1
    ? { status: 'unique', title: distinctTitles[0]! }
    : { status: 'ambiguous', matchingCaseTitles: distinctTitles };
}

function ambiguousCaseTitlesMessage(
  testRunId: number,
  source: string,
  ambiguousTestCases: Array<{ testCase: string; matchingCaseTitles: string[] }>,
): string {
  const rendered = ambiguousTestCases
    .map(({ testCase, matchingCaseTitles }) =>
      `${JSON.stringify(testCase)} -> ${matchingCaseTitles.map((title) => JSON.stringify(title)).join(', ')}`)
    .join('; ');
  return `${ambiguousTestCases.length} declared details.adequacy.testCases entries resolve to multiple ` +
    `distinct measured full case titles in ${source} for test-run ${testRunId} (${rendered}). ` +
    `Bind the full title or a suffix unique in the recorded source.`;
}

const MAX_CASE_TITLES_IN_ERROR_MESSAGE = 5;
const MAX_CASE_TITLE_CHARS_IN_ERROR_MESSAGE = 512;

function quoteBoundedCaseTitle(title: string): string {
  const characters = Array.from(title);
  return JSON.stringify(
    characters.length > MAX_CASE_TITLE_CHARS_IN_ERROR_MESSAGE
      ? `${characters.slice(0, MAX_CASE_TITLE_CHARS_IN_ERROR_MESSAGE - 1).join('')}…`
      : title,
  );
}

function formatBoundedCaseTitleList(titles: readonly string[]): string {
  const rendered = titles.slice(0, MAX_CASE_TITLES_IN_ERROR_MESSAGE).map(quoteBoundedCaseTitle);
  const omitted = titles.length - rendered.length;
  const omittedSuffix = omitted > 0 ? `${rendered.length > 0 ? ', ' : ''}${omitted} more omitted` : '';
  return `[${rendered.join(', ')}${omittedSuffix}]`;
}

async function hasLedgerProvenPassingSelection(
  row: EvidenceRow,
  execution: NonNullable<ReturnType<typeof parseTestRunExecutionDetails>>,
  workspaceId: string,
): Promise<boolean> {
  if (!row.test_run_id || execution.failed !== 0
    || (execution.skipped !== 0 && !execution.testNamePattern)) return false;
  try {
    const pattern = execution.skipped !== 0 ? new RegExp(execution.testNamePattern!) : null;
    const recorded = await withWorkspace(workspaceId, tx => readRecordedTestCases(tx, row.test_run_id!));
    return recorded !== null
      && recorded.cases.length === execution.passed + execution.skipped
      && recorded.cases.filter(c => c.status === 'pass').length === execution.passed
      && recorded.cases.filter(c => c.status === 'skip').length === execution.skipped
      && (!pattern || recorded.cases.every(c =>
        pattern.test(c.caseKey.replaceAll(' > ', ' ')) === (c.status === 'pass')));
  } catch { return false; }
}

const MAX_REPO_MEASUREMENT_SOURCE_GLOBS = 16;
const MAX_REPO_MEASUREMENT_GLOB_MATCHES = 128;
const MAX_REPO_MEASUREMENT_FIXTURE_GLOB_MATCHES = 4096;
const MAX_REPO_MEASUREMENT_GLOB_DEPTH = 16;
const MAX_REPO_MEASUREMENT_IMPORTED_FIXTURE_PATHS = 128;

const evidenceFingerprintSchema = z.string().trim().min(1).max(256);
const repoMeasurementPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !value.startsWith('./') &&
      !value.includes('\\') &&
      !value.split('/').some((part) => part === '' || part === '.' || part === '..'),
    'measurement paths must be normalized repo-relative POSIX file paths',
  );
const repoMeasurementGlobSchema = repoMeasurementPathSchema
  .refine((value) => !value.startsWith('!'), 'measurement globs must be positive patterns');
const runtimeUnitsSchema = z.array(z.string().trim().min(1).max(120)).min(1).max(32)
  .refine(units => new Set(units).size === units.length, 'runtime units must be unique');

/**
 * The current evidence-measurement schema version. A binding that omits `schemaVersion` is
 * stored at this version (P-005 of plan-verification-friction-reduction-2026-10-11); any
 * other explicit value is refused, so an unsupported version still fails loudly.
 */
export const EVIDENCE_MEASUREMENT_SCHEMA_VERSION = 1 as const;
const measurementSchemaVersionSchema = z
  .literal(EVIDENCE_MEASUREMENT_SCHEMA_VERSION)
  .default(EVIDENCE_MEASUREMENT_SCHEMA_VERSION);

export const repoFilesEvidenceMeasurementSchema = z
  .object({
    schemaVersion: measurementSchemaVersionSchema,
    kind: z.literal('repo-files'),
    /**
     * Optional workspace-registry slug for a source/test checkout other than the
     * plan's owning harness.  Cross-repository plans already resolve citations
     * through these registered roots; keeping the selector to a slug (never an
     * absolute path) gives evidence currentness the same bounded admission rule.
     */
    rootHarnessSlug: z.string().trim().min(1).max(120).optional(),
    sourcePaths: z.array(repoMeasurementPathSchema).min(1).max(32),
    sourceGlobs: z.array(repoMeasurementGlobSchema).min(1).max(MAX_REPO_MEASUREMENT_SOURCE_GLOBS)
      .refine((patterns) => new Set(patterns).size === patterns.length, 'measurement globs must be unique').optional(),
    testPaths: z.array(repoMeasurementPathSchema).min(1).max(32).optional(),
    /** Files a fixture was calibrated against; tracked independently from the test and product source. */
    fixturePaths: z.array(repoMeasurementPathSchema).min(1).max(32).optional(),
    /** Bounded calibration corpus; membership and bytes participate in the fixture digest. */
    fixtureGlobs: z.array(repoMeasurementGlobSchema).min(1).max(MAX_REPO_MEASUREMENT_SOURCE_GLOBS)
      .refine((patterns) => new Set(patterns).size === patterns.length, 'measurement globs must be unique').optional(),
    /** Optional registered harness root for fixturePaths when calibration sources live elsewhere. */
    fixtureRootHarnessSlug: z.string().trim().min(1).max(120).optional(),
    /** Local runtime units observed around execution; evidence reads independently remeasure them. */
    runtimeUnits: runtimeUnitsSchema.optional(),
    /** Final package environment, independently rehashed from a measured operational receipt. */
    artifactReceiptPath: repoMeasurementPathSchema.optional(),
    /** Native physical storage observations re-run their registered instrument on this host. */
    nativeInstrumentKey: nativeColdInstrumentKeySchema.optional(),
    /**
     * A whole-tree test (a shrink-only census) re-runs its registered tree instrument over the
     * files committed at the measurement commit; the output's digest joins the source
     * fingerprint (tree-instruments.ts, WI-6554700010018633). Committed measurements only.
     */
    treeInstrumentKey: treeInstrumentKeySchema.optional(),
    /** Completed isolated tests certify retained source/lifecycle artifacts, not a live deployment. */
    completedRuntime: z.discriminatedUnion('kind', [z.object({
      kind: z.literal('verification-harness'),
      verifierRunId: z.string().regex(/^\d{8}T\d{6}Z-\d+(?:\.\d+)?$/),
      journeyHarness: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
      journeyRunId: z.string().regex(/^\d{8}T\d{6}Z-\d+(?:\.\d+)?$/),
      /** Static model-facing metadata may differ; the full raw file still participates in currentness. */
      guidanceOnlySourcePaths: z.array(repoMeasurementPathSchema).min(1).max(8)
        .refine(paths => new Set(paths).size === paths.length, 'guidance paths must be unique').optional(),
    }).strict(), z.object({ kind: z.literal('llm-in-process') }).strict(), z.object({
      kind: z.literal('isolated-integration'),
      runIds: z.array(z.string().regex(/^\d{8}T\d{6}Z-\d+(?:\.\d+)?$/)).min(1).max(32)
        .refine(ids => new Set(ids).size === ids.length, 'integration run ids must be unique'),
    }).strict()]).optional(),
  })
  .strict()
  .superRefine((measurement, ctx) => {
    if (measurement.nativeInstrumentKey && (measurement.runtimeUnits || measurement.completedRuntime || measurement.artifactReceiptPath)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nativeInstrumentKey'],
        message: 'native instrument environment cannot also select a process runtime or packaged artifact' });
    }
    if (measurement.artifactReceiptPath && (!measurement.artifactReceiptPath.startsWith('docs/evidence/') ||
      !measurement.sourcePaths.includes(measurement.artifactReceiptPath) ||
      measurement.runtimeUnits || measurement.completedRuntime)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['artifactReceiptPath'],
        message: 'artifact receipt must be an explicit docs/evidence source path and cannot also select a process runtime' });
    }
    if (measurement.completedRuntime && !measurement.runtimeUnits) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completedRuntime'],
        message: 'completedRuntime requires original execution runtimeUnits' });
    }
    if (measurement.completedRuntime?.kind === 'verification-harness'
      && measurement.completedRuntime.guidanceOnlySourcePaths?.some(path => !measurement.sourcePaths.includes(path))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completedRuntime', 'guidanceOnlySourcePaths'],
        message: 'guidance classification requires an explicit measured source path' });
    }
    if (measurement.fixtureRootHarnessSlug && !hasRepoFixturePaths(measurement)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fixtureRootHarnessSlug'],
        message: 'fixtureRootHarnessSlug requires fixturePaths or fixtureGlobs',
      });
    }
  });

export type RepoFilesEvidenceMeasurement = z.infer<typeof repoFilesEvidenceMeasurementSchema>;

const ledgerMeasurementIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Z]+-[A-Za-z0-9._-]+$/, 'ledger measurement ids are work-item refs such as WI-1234 or EI-5678');

/**
 * A LEDGER-STATE measurement basis (WI-10002087).
 *
 * WHY THIS EXISTS. `source` currentness had exactly ONE basis — a repo file-set hash — so a
 * binding whose SUBJECT is not a file set had no basis at all and was pinned at `unknown`
 * forever, whatever its `evidenceKind`. (The kind is a red herring: most `operational` rows
 * measure fine because their subject happens to be repo files.) That made every non-code plan
 * outcome unshippable, because the ship gate demands current proof and no current proof was
 * reachable for a claim about ledger state — e.g. "each of these five rows reached a recorded
 * disposition".
 *
 * WHY A DIGEST AND NOT A RECENCY WINDOW. Both a recency window and mapping non-file kinds to
 * `not-applicable` would REMOVE the check rather than satisfy it: a caller could mint freshness
 * from an assertion it authored itself, which is the whole failure the attested-current guard
 * below exists to prevent. Hashing the named rows' disposition keeps the rail exactly as strong
 * as the file-set hash — the server re-reads and re-hashes on every read, so a row that reopens
 * or is deleted correctly goes `stale` instead of staying provably "current".
 */
export const workItemsEvidenceMeasurementSchema = z
  .object({
    schemaVersion: measurementSchemaVersionSchema,
    kind: z.literal('work-items'),
    /**
     * The census population. Bounded like `sourcePaths`: a measurement basis has to stay cheap
     * enough to recompute on every evidence read.
     */
    workItemIds: z.array(ledgerMeasurementIdSchema).min(1).max(64),
    /** Optional local runtime units; live/deployed evidence remeasures them independently of ledger state. */
    runtimeUnits: runtimeUnitsSchema.optional(),
  })
  .strict();

export type WorkItemsEvidenceMeasurement = z.infer<typeof workItemsEvidenceMeasurementSchema>;

/** Every server-re-measurable evidence basis. Discriminated on `kind`; add a case, not a parallel surface. */
export const evidenceMeasurementSchema = z.discriminatedUnion('kind', [
  repoFilesEvidenceMeasurementSchema,
  workItemsEvidenceMeasurementSchema,
]);

export type EvidenceMeasurement = z.infer<typeof evidenceMeasurementSchema>;

export interface MeasuredRepoEvidenceFingerprints {
  sourceFingerprint: string;
  testFingerprint: string | null;
  fixtureFingerprint?: string | null;
  environmentFingerprint?: string | null;
}


function containedBy(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

async function fingerprintRepoFileSet(
  repoRoot: string,
  declaredPaths: readonly string[],
  limits: Readonly<RepoFileSetReadLimits> = REPO_FILE_SET_READ_LIMITS,
): Promise<{ fingerprint: string; files: Array<{ path: string; sha256: string; gitBlob: string }> }> {
  const root = await realpath(repoRoot);
  const paths = [...new Set(declaredPaths)].sort();
  const entries: Array<{ path: string; sha256: string }> = [];
  const files: Array<{ path: string; sha256: string; gitBlob: string }> = [];
  let totalBytes = 0;
  for (const path of paths) {
    const candidate = resolve(root, path);
    if (!containedBy(root, candidate)) throw new Error(`repo_measurement_path_outside_root:${path}`);
    const canonical = await realpath(candidate);
    if (!containedBy(root, canonical)) throw new Error(`repo_measurement_symlink_outside_root:${path}`);
    const info = await stat(canonical);
    if (!info.isFile()) throw new Error(`repo_measurement_not_file:${path}`);
    totalBytes += info.size;
    if (info.size > limits.maxFileBytes || totalBytes > limits.maxTotalBytes) {
      throw new Error(`repo_measurement_too_large:${info.size > limits.maxFileBytes ? info.size : totalBytes}>${info.size > limits.maxFileBytes ? limits.maxFileBytes : limits.maxTotalBytes}`);
    }
    // Reuse the artifact measurer's streaming/stat fence, retaining the exact digest
    // formulas. A fixture corpus may exceed a batch, while resident payload stays 64KiB.
    const file = await open(canonical, 'r');
    let sha256: string;
    let gitBlob: string;
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size !== BigInt(info.size)) throw new Error(`repo_measurement_changed_during_read:${path}`);
      const hash = createHash('sha256');
      const blobHash = createHash('sha1').update(`blob ${info.size}\0`);
      let readBytes = 0;
      for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
        readBytes += chunk.length;
        if (readBytes > info.size) throw new Error(`repo_measurement_changed_during_read:${path}`);
        hash.update(chunk);
        blobHash.update(chunk);
      }
      const after = await file.stat({ bigint: true });
      const current = await stat(canonical, { bigint: true });
      const pin = (value: typeof before) => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
      if (readBytes !== info.size || pin(before) !== pin(after) || pin(after) !== pin(current) || await realpath(candidate) !== canonical) {
        throw new Error(`repo_measurement_changed_during_read:${path}`);
      }
      sha256 = hash.digest('hex');
      gitBlob = blobHash.digest('hex');
    } finally { await file.close(); }
    // The digest input stays exactly `{ path, sha256 }` so every existing fingerprint is
    // byte-identical; the git blob id rides alongside for the P-018 commit pin only.
    entries.push({ path, sha256 });
    files.push({ path, sha256, gitBlob });
  }
  // One formula for the working-tree and the committed measurement (D-001), so a binding
  // reads current at commit M exactly when its stored fingerprint equals the bytes at M.
  return { fingerprint: repoFileSetFingerprint(entries), files };
}

async function expandRepoMeasurementGlobsAtRoot(root: string, globs: readonly string[], maxMatches = MAX_REPO_MEASUREMENT_GLOB_MATCHES): Promise<string[]> {
  if (globs.length === 0) return [];
  const matches = new Set<string>();
  const stream = fastGlob.stream([...globs], {
    cwd: root,
    absolute: false,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    unique: true,
    deep: MAX_REPO_MEASUREMENT_GLOB_DEPTH,
  });
  for await (const matched of stream as AsyncIterable<string>) {
    const path = matched.split(sep).join('/');
    matches.add(path);
    if (matches.size > maxMatches) {
      throw new Error(`repo_measurement_too_many_glob_files:${matches.size}>${maxMatches}`);
    }
  }
  return [...matches].sort();
}

function hasRepoFixturePaths(recipe: RepoFilesEvidenceMeasurement): boolean {
  return Boolean(recipe.fixturePaths || recipe.fixtureGlobs);
}

async function expandedRepoFixturePathsAtRoot(
  root: string,
  recipe: RepoFilesEvidenceMeasurement,
  importedFixturePaths: readonly string[] = [],
): Promise<string[]> {
  const matches = await expandRepoMeasurementGlobsAtRoot(root, recipe.fixtureGlobs ?? [], MAX_REPO_MEASUREMENT_FIXTURE_GLOB_MATCHES);
  return [...new Set([...(recipe.fixturePaths ?? []), ...matches, ...importedFixturePaths])].sort();
}

/**
 * Resolve the bounded, direct relative `.fixture.ts` imports named by testPaths.
 * The source/test measurement already has an 8 MiB per-file and total read bound;
 * keep the extra parse pass under the same byte budget and cap its output set.
 */
async function inferRelativeRepoFixtureImportsAtRoot(
  root: string,
  testPaths: readonly string[],
  readTestSource: (path: string) => Promise<string | null>,
): Promise<string[]> {
  const fixturePaths = new Set<string>();
  let totalBytes = 0;
  for (const testPath of testPaths) {
    const source = await readTestSource(testPath);
    if (source === null) throw new Error(`repo_measurement_test_import_source_unavailable:${testPath}`);
    totalBytes += Buffer.byteLength(source);
    if (totalBytes > REPO_FILE_SET_READ_LIMITS.maxTotalBytes) {
      throw new Error(`repo_measurement_test_import_sources_too_large:${totalBytes}>${REPO_FILE_SET_READ_LIMITS.maxTotalBytes}`);
    }

    const sourceFile = ts.createSourceFile(
      testPath,
      source,
      ts.ScriptTarget.Latest,
      true,
      testPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const addSpecifier = (specifier: ts.Expression | undefined) => {
      if (!specifier || !ts.isStringLiteralLike(specifier)) return;
      const modulePath = specifier.text;
      if ((!modulePath.startsWith('./') && !modulePath.startsWith('../'))
        || (!modulePath.endsWith('.fixture') && !modulePath.endsWith('.fixture.ts'))) return;
      const resolvedModule = modulePath.endsWith('.fixture.ts') ? modulePath : `${modulePath}.ts`;
      const candidate = resolve(root, dirname(testPath), resolvedModule);
      if (!containedBy(root, candidate)) {
        throw new Error(`repo_measurement_fixture_import_outside_root:${testPath}:${modulePath}`);
      }
      const path = relative(root, candidate).split(sep).join('/');
      const validPath = repoMeasurementPathSchema.safeParse(path);
      if (!validPath.success) throw new Error(`repo_measurement_invalid_fixture_import_path:${testPath}:${modulePath}`);
      fixturePaths.add(path);
      if (fixturePaths.size > MAX_REPO_MEASUREMENT_IMPORTED_FIXTURE_PATHS) {
        throw new Error(`repo_measurement_too_many_imported_fixture_files:${fixturePaths.size}>${MAX_REPO_MEASUREMENT_IMPORTED_FIXTURE_PATHS}`);
      }
    };

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
        addSpecifier(statement.moduleSpecifier);
      } else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
        addSpecifier(statement.moduleReference.expression);
      }
    }
  }
  return [...fixturePaths].sort();
}

async function inferRepoFixtureImportsAtWorkingTree(root: string, testPaths: readonly string[]): Promise<string[]> {
  const canonicalRoot = await realpath(root);
  return inferRelativeRepoFixtureImportsAtRoot(canonicalRoot, testPaths, async (testPath) => {
    const candidate = resolve(canonicalRoot, testPath);
    if (!containedBy(canonicalRoot, candidate)) throw new Error(`repo_measurement_path_outside_root:${testPath}`);
    const canonical = await realpath(candidate);
    if (!containedBy(canonicalRoot, canonical)) throw new Error(`repo_measurement_symlink_outside_root:${testPath}`);
    const info = await stat(canonical);
    if (!info.isFile()) throw new Error(`repo_measurement_not_file:${testPath}`);
    if (info.size > REPO_FILE_SET_READ_LIMITS.maxFileBytes) {
      throw new Error(`repo_measurement_too_large:${info.size}>${REPO_FILE_SET_READ_LIMITS.maxFileBytes}`);
    }
    return readFile(canonical, 'utf8');
  });
}

async function inferRepoFixtureImportsAtCommit(
  root: string,
  commit: string,
  testPaths: readonly string[],
): Promise<string[]> {
  return inferRelativeRepoFixtureImportsAtRoot(root, testPaths, (path) =>
    readCommittedMeasurementText(root, commit, path, REPO_FILE_SET_READ_LIMITS.maxFileBytes));
}

async function expandedRepoSourcePathsAtRoot(
  root: string,
  parsed: RepoFilesEvidenceMeasurement,
): Promise<string[]> {
  const globPaths = await expandRepoMeasurementGlobsAtRoot(root, parsed.sourceGlobs ?? []);
  return [...new Set([...parsed.sourcePaths, ...globPaths])].sort();
}

/**
 * Detect the narrow class of tests whose subject is a repository tree rather than the
 * first-ring imports from the test file.  A directory read alone is not enough: ordinary
 * fixtures often inspect one directory.  The detector requires all three signals of a
 * broad census: a root collection (`APP_ROOTS`, `REPO_ROOT`, `SCAN_DIRS`, ...), a directory
 * or glob read, and a traversal helper (`walk`, `scanTree`, ...).  AST identifiers keep
 * comments and string fixtures from self-triggering this guard.
 */
export const detectBroadRepoTreeScan = detectBroadRepoTreeScanOffThread;

// Evidence reads and replays share one worker budget. Wait for a slot before
// loading source text so queued jobs retain paths, not source strings. The
// worker still enforces its own source, request and deadline bounds.
const limitRepoTreeScan = pLimit(TREE_SCAN_MAX_REQUESTS);

async function readCommittedMeasurementText(
  root: string,
  commit: string,
  path: string,
  maxBytes?: number,
): Promise<string | null> {
  const locations = await locateCommittedBlobs(root, commit, [path]);
  const location = locations.get(path);
  if (!location || !location.isFile) return null;
  const repoPath = location.repo === '.' ? path : path.slice(location.repo.length + 1);
  const committedRef = `${location.commitSha}:${repoPath}`;
  const repoRoot = join(root, location.repo);
  if (maxBytes !== undefined) {
    const sizeText = await defaultGitRunner(repoRoot, ['cat-file', '-s', committedRef]);
    const size = Number(sizeText.trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`repo_measurement_invalid_committed_test_size:${path}`);
    if (size > maxBytes) throw new Error(`repo_measurement_too_large:${size}>${maxBytes}`);
  }
  return defaultGitRunner(repoRoot, ['show', committedRef]);
}

/**
 * A tree-plane repo-files measurement must name the files its test-side tree walk can see.
 * Without explicit sourceGlobs or a registered tree instrument (which re-runs the scan over
 * the committed tree), the normal first-ring source derivation is a false witness for a
 * broad scanner, so the read path fails closed instead of reporting current proof.
 */
async function broadRepoTreeScanGuard(
  root: string,
  recipe: RepoFilesEvidenceMeasurement,
  commit: string | null,
  committedScans: Map<string, Promise<boolean>>,
): Promise<string | null> {
  if (recipe.sourceGlobs?.length || recipe.treeInstrumentKey || !recipe.testPaths?.length) return null;
  for (const path of recipe.testPaths) {
    const key = commit ? JSON.stringify([root, commit, path]) : null;
    let scan = key ? committedScans.get(key) : undefined;
    if (!scan) {
      scan = limitRepoTreeScan(async () => {
        const source = await (commit
          ? readCommittedMeasurementText(root, commit, path)
          : readFile(resolve(root, path), 'utf8')).catch(() => null);
        return source !== null && await detectBroadRepoTreeScan(source);
      });
      if (key) committedScans.set(key, scan);
    }
    if (await scan) {
      return `repo_measurement_broad_tree_scan_requires_source_globs:${path}`;
    }
  }
  return null;
}

/** Resolve the bounded source file set recorded by a repo-files measurement. */
export async function expandRepoFilesEvidenceSourcePathsAtRoot(
  repoRoot: string,
  measurement: RepoFilesEvidenceMeasurement,
): Promise<string[]> {
  const parsed = repoFilesEvidenceMeasurementSchema.parse(measurement);
  return expandedRepoSourcePathsAtRoot(await realpath(repoRoot), parsed);
}

/** The fingerprint tuple plus the per-file hashes it was computed from (P-018). */
export interface DetailedRepoEvidenceMeasurement extends MeasuredRepoEvidenceFingerprints {
  files: MeasuredRepoFile[];
}

async function nearestRepositoryRoot(root: string, file: string): Promise<string> {
  let current = dirname(file);
  while (containedBy(root, current)) {
    if (existsSync(join(current, '.git'))) return realpath(current);
    if (current === root) break;
    current = dirname(current);
  }
  return root;
}

/** A declared path's repository (the lock coordination domain) and its path inside it. */
interface ProbePath {
  domain: string;
  repoPath: string;
}

async function resolveProbePaths(
  root: string,
  declaredPaths: Iterable<string>,
  onUnresolvable: 'throw' | 'skip',
): Promise<Map<string, ProbePath>> {
  const resolved = new Map<string, ProbePath>();
  for (const path of new Set(declaredPaths)) {
    let canonical: string;
    try {
      const candidate = resolve(root, path);
      if (!containedBy(root, candidate)) throw new Error(`repo_measurement_path_outside_root:${path}`);
      canonical = await realpath(candidate);
      if (!containedBy(root, canonical)) throw new Error(`repo_measurement_symlink_outside_root:${path}`);
    } catch (error) {
      if (onUnresolvable === 'throw') throw error;
      continue;
    }
    const domain = await nearestRepositoryRoot(root, canonical);
    resolved.set(path, { domain, repoPath: relative(domain, canonical).split(sep).join('/') });
  }
  return resolved;
}

/**
 * JS mirror of the lock store's SQL `lock_path_overlaps`: equal paths, or one a
 * directory prefix of the other. Pinned to the newest SQL definition by
 * spec-evidence-store-batch-fence.test.ts so the two cannot drift.
 */
export function lockPathOverlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** Live mutation-probe locks overlapping any resolved path: one lock-queue read per repository. */
async function readMutationProbeLocks(resolved: ReadonlyMap<string, ProbePath>): Promise<ProbePath[]> {
  const groups = new Map<string, Set<string>>();
  for (const { domain, repoPath } of resolved.values()) {
    groups.set(domain, (groups.get(domain) ?? new Set<string>()).add(repoPath));
  }
  await ensureBootstrap();
  const probes: ProbePath[] = [];
  for (const [coordinationDomain, paths] of groups) {
    const queue = await readQueue(getTxPool(), { coordinationDomain, paths: [...paths], includeWaiting: false });
    for (const lock of queue.active_locks) {
      if (String(lock.intent ?? '').trim().toLowerCase() === 'mutation probe') {
        probes.push({ domain: coordinationDomain, repoPath: lock.path });
      }
    }
  }
  return probes;
}

/** The refusal a probe snapshot implies for one binding's paths, or null when none overlaps. */
function mutationProbeRefusal(
  resolved: ReadonlyMap<string, ProbePath>,
  probes: readonly ProbePath[],
  declaredPaths: readonly string[],
): string | null {
  for (const path of declaredPaths) {
    const own = resolved.get(path);
    if (!own) continue;
    const probe = probes.find((lock) => lock.domain === own.domain && lockPathOverlaps(lock.repoPath, own.repoPath));
    if (probe) return `repo_measurement_mutation_probe_active:${probe.domain}:${probe.repoPath}`;
  }
  return null;
}

async function refuseMutationProbePaths(root: string, declaredPaths: readonly string[]): Promise<void> {
  const resolved = await resolveProbePaths(root, declaredPaths, 'throw');
  const refusal = mutationProbeRefusal(resolved, await readMutationProbeLocks(resolved), declaredPaths);
  if (refusal) throw new Error(refusal);
}

/**
 * One mutation-probe snapshot for every binding a listSpecEvidence batch measures
 * under `root`. Fencing per binding re-read the lock queue twice per binding: a
 * ~233-binding plan issued 466 reads per call, which alone pushed the GOAL portfolio
 * read past the obligation reader's 900ms budget. A batch reads it once per
 * repository before the reads and once after, and decides each binding locally.
 * Unresolvable paths are left out: their own fingerprint read refuses them with the
 * same error the strict fence would raise. null = the queue could not be read; the
 * caller falls back to the per-binding fence.
 */
interface MutationProbeSnapshot {
  resolved: Map<string, ProbePath>;
  probes: ProbePath[];
}

async function readMutationProbeSnapshot(
  root: string,
  declaredPaths: Iterable<string>,
  resolved?: Map<string, ProbePath>,
): Promise<MutationProbeSnapshot | null> {
  try {
    const paths = resolved ?? (await resolveProbePaths(root, declaredPaths, 'skip'));
    return { resolved: paths, probes: await readMutationProbeLocks(paths) };
  } catch {
    return null;
  }
}

/** Pre-read snapshots, one per measurement root, over the union of its bindings' paths. */
async function readRepoFilesProbeSnapshots(
  recipes: ReadonlyArray<EvidenceMeasurement | null>,
  rootFor: (recipe: RepoFilesEvidenceMeasurement, dimension?: 'source' | 'fixture') => Promise<string>,
): Promise<Map<string, MutationProbeSnapshot>> {
  const unions = new Map<string, Set<string>>();
  await Promise.all(
    recipes.map(async (recipe) => {
      if (!recipe || recipe.kind === 'work-items') return;
      const primaryRoot = await rootFor(recipe, 'source').catch(() => null);
      if (!primaryRoot) return;
      const fixtureRoot = hasRepoFixturePaths(recipe)
        ? await rootFor(recipe, 'fixture').catch(() => null)
        : primaryRoot;
      const importedFixturePaths = fixtureRoot === primaryRoot
        ? await inferRepoFixtureImportsAtWorkingTree(primaryRoot, recipe.testPaths ?? []).catch(() => null)
        : [];
      if (!importedFixturePaths) return;
      const fixturePaths = fixtureRoot
        ? await expandedRepoFixturePathsAtRoot(fixtureRoot, recipe, importedFixturePaths).catch(() => null)
        : [];
      if (!fixturePaths) return;
      const primaryPaths = await repoFilesPrimaryPathsAtRoot(primaryRoot, recipe).catch(() => null);
      if (!primaryPaths) return;
      const groups: Array<[string, string[]]> = [[
        primaryRoot,
        [...primaryPaths, ...(fixtureRoot === primaryRoot ? fixturePaths : [])],
      ]];
      if (fixtureRoot && fixtureRoot !== primaryRoot && hasRepoFixturePaths(recipe)) {
        groups.push([fixtureRoot, fixturePaths]);
      }
      for (const [root, paths] of groups) {
        if (paths.length === 0) continue;
        const union = unions.get(root) ?? new Set<string>();
        for (const path of paths) union.add(path);
        unions.set(root, union);
      }
    }),
  );
  const snapshots = new Map<string, MutationProbeSnapshot>();
  for (const [root, union] of unions) {
    const snapshot = await readMutationProbeSnapshot(root, union);
    if (snapshot) snapshots.set(root, snapshot);
  }
  return snapshots;
}

/** Measure a repo-files recipe and keep the per-file hashes, in ONE read of each file. */
export async function measureRepoFilesEvidenceDetailedAtRoot(
  repoRoot: string,
  measurement: RepoFilesEvidenceMeasurement,
  options: { fixtureRoot?: string; fixtureRootHarnessSlug?: string } = {},
): Promise<DetailedRepoEvidenceMeasurement> {
  const parsed = repoFilesEvidenceMeasurementSchema.parse(measurement);
  const root = await realpath(repoRoot);
  const fixtureRoot = await realpath(options.fixtureRoot ?? root);
  const fixtureRootHarnessSlug = options.fixtureRootHarnessSlug ?? parsed.fixtureRootHarnessSlug;
  if (parsed.fixtureRootHarnessSlug && !options.fixtureRoot) {
    throw new Error(`repo_measurement_fixture_root_required:${parsed.fixtureRootHarnessSlug}`);
  }
  if (fixtureRoot !== root && !fixtureRootHarnessSlug) {
    throw new Error('repo_measurement_fixture_root_identity_required');
  }
  const sourcePaths = await expandedRepoSourcePathsAtRoot(root, parsed);
  const importedFixturePaths = fixtureRoot === root
    ? await inferRepoFixtureImportsAtWorkingTree(root, parsed.testPaths ?? [])
    : [];
  const fixturePaths = await expandedRepoFixturePathsAtRoot(fixtureRoot, parsed, importedFixturePaths);
  const measuredPaths = [
    ...sourcePaths,
    ...(parsed.testPaths ?? []),
    ...(fixtureRoot === root ? fixturePaths : []),
  ];
  await refuseMutationProbePaths(root, measuredPaths);
  if (fixtureRoot !== root && hasRepoFixturePaths(parsed)) {
    await refuseMutationProbePaths(fixtureRoot, fixturePaths);
  }
  const detailed = await fingerprintRepoFilesMeasurement(
    root,
    parsed,
    sourcePaths,
    fixtureRoot,
    fixtureRootHarnessSlug,
    fixturePaths,
  );
  await refuseMutationProbePaths(root, measuredPaths);
  if (fixtureRoot !== root && hasRepoFixturePaths(parsed)) {
    await refuseMutationProbePaths(fixtureRoot, fixturePaths);
  }
  return detailed;
}

/**
 * Measure a repo-files recipe from the bytes COMMITTED at `commit` (D-001): the commit-side
 * twin of measureRepoFilesEvidenceDetailedAtRoot, with the same digest, the same glob bounds
 * and the same per-file `{ path, sha256, gitBlob }`. It needs no mutation-probe fence: a
 * probe's mutant is an uncommitted working-tree edit, so it is in no commit's objects.
 */
export async function measureRepoFilesEvidenceDetailedAtCommit(
  repoRoot: string,
  measurement: RepoFilesEvidenceMeasurement,
  commit: string,
  options: {
    repoPrefix?: string | null;
    deps?: CommittedTreeDeps;
    fixtureRoot?: string;
    fixtureCommit?: string | null;
    fixtureRootHarnessSlug?: string;
  } = {},
): Promise<DetailedRepoEvidenceMeasurement> {
  const parsed = repoFilesEvidenceMeasurementSchema.parse(measurement);
  const root = await realpath(repoRoot);
  const deps = options.deps ?? {};
  // `commit` belongs to the repository at `repoPrefix` ('' / null = the root repository).
  // An as-committed run inside a submodule records the SUBMODULE's commit, so its files are
  // read in that repository while the digest keeps root-relative paths, exactly as stored.
  const prefix = options.repoPrefix || null;
  const repoDir = prefix ? join(root, prefix) : root;
  const fixtureRoot = await realpath(options.fixtureRoot ?? root);
  const fixtureRootHarnessSlug = options.fixtureRootHarnessSlug ?? parsed.fixtureRootHarnessSlug;
  if (parsed.fixtureRootHarnessSlug && !options.fixtureRoot) {
    throw new Error(`repo_measurement_fixture_root_required:${parsed.fixtureRootHarnessSlug}`);
  }
  if (fixtureRoot !== root && !fixtureRootHarnessSlug) {
    throw new Error('repo_measurement_fixture_root_identity_required');
  }
  const fixtureCommit = options.fixtureCommit === undefined
    ? (fixtureRoot === root ? commit : null)
    : options.fixtureCommit;
  const inRepo = (path: string) => {
    if (!prefix) return path;
    if (!path.startsWith(`${prefix}/`)) throw new Error(`repo_measurement_outside_run_repository:${path}`);
    return path.slice(prefix.length + 1);
  };
  const fromRepo = (path: string) => (prefix ? `${prefix}/${path}` : path);
  const importedFixturePaths = fixtureRoot === root && parsed.testPaths?.length
    ? (await inferRepoFixtureImportsAtCommit(repoDir, commit, parsed.testPaths.map(inRepo))).map(fromRepo)
    : [];
  const fileSetAt = async (baseRoot: string, paths: readonly string[], atCommit: string, prefixPaths = false, limits = REPO_FILE_SET_READ_LIMITS) => {
    const measured = await fingerprintRepoFileSetAtCommit(
      prefixPaths ? repoDir : baseRoot,
      atCommit,
      prefixPaths ? paths.map(inRepo) : paths,
      deps,
      limits,
    );
    const files = measured.files.map((file) => ({ ...file, path: prefixPaths ? fromRepo(file.path) : file.path }));
    return { fingerprint: repoFileSetFingerprint(files), files };
  };
  const globPaths = (
    await listCommittedGlobMatches(
      repoDir,
      commit,
      (parsed.sourceGlobs ?? []).map(inRepo),
      { maxMatches: MAX_REPO_MEASUREMENT_GLOB_MATCHES, maxDepth: MAX_REPO_MEASUREMENT_GLOB_DEPTH },
      deps,
    )
  ).map(fromRepo);
  const sourcePaths = [...new Set([...parsed.sourcePaths, ...globPaths])].sort();
  const fixtureGlobPaths = fixtureCommit
    ? (await listCommittedGlobMatches(
        fixtureRoot === root ? repoDir : fixtureRoot,
        fixtureCommit,
        (parsed.fixtureGlobs ?? []).map((path) => fixtureRoot === root ? inRepo(path) : path),
        { maxMatches: MAX_REPO_MEASUREMENT_FIXTURE_GLOB_MATCHES, maxDepth: MAX_REPO_MEASUREMENT_GLOB_DEPTH },
        deps,
      )).map((path) => fixtureRoot === root ? fromRepo(path) : path)
    : await expandRepoMeasurementGlobsAtRoot(fixtureRoot, parsed.fixtureGlobs ?? [], MAX_REPO_MEASUREMENT_FIXTURE_GLOB_MATCHES);
  const fixturePaths = [...new Set([...(parsed.fixturePaths ?? []), ...fixtureGlobPaths, ...importedFixturePaths])].sort();
  const fixtureIsWorkingTree = Boolean(fixturePaths.length && !fixtureCommit);
  if (fixtureIsWorkingTree) await refuseMutationProbePaths(fixtureRoot, fixturePaths);
  const [source, test, fixture] = await Promise.all([
    fileSetAt(root, sourcePaths, commit, true),
    parsed.testPaths ? fileSetAt(root, parsed.testPaths, commit, true) : Promise.resolve(null),
    fixturePaths.length > 0
      ? fixtureCommit
        ? fileSetAt(fixtureRoot, fixturePaths, fixtureCommit, fixtureRoot === root, REPO_FIXTURE_READ_LIMITS)
        : fingerprintRepoFileSet(fixtureRoot, fixturePaths, REPO_FIXTURE_READ_LIMITS)
      : Promise.resolve(null),
  ]);
  if (fixtureIsWorkingTree) await refuseMutationProbePaths(fixtureRoot, fixturePaths);
  const fixtureIdentity = fixtureRootHarnessSlug ? { rootHarnessSlug: fixtureRootHarnessSlug } : {};
  let sourceFingerprint = source.fingerprint;
  if (parsed.treeInstrumentKey) {
    // The instruments scan superproject roots; a submodule's own commit has no such tree.
    if (prefix) throw new Error(`repo_measurement_tree_instrument_requires_root_repository:${parsed.treeInstrumentKey}`);
    const output = await measureTreeInstrumentAtCommit(parsed.treeInstrumentKey, root, commit, deps);
    sourceFingerprint = foldTreeInstrumentFingerprint(source.fingerprint, parsed.treeInstrumentKey, output);
  }
  return {
    sourceFingerprint,
    testFingerprint: test?.fingerprint ?? null,
    ...(fixture ? { fixtureFingerprint: fixture.fingerprint } : {}),
    files: [
      ...source.files.map((file) => ({ ...file, dimension: 'source' as const })),
      ...(test?.files ?? []).map((file) => ({ ...file, dimension: 'test' as const })),
      ...(fixture?.files ?? []).map((file) => ({ ...file, ...fixtureIdentity, dimension: 'fixture' as const })),
    ],
  };
}

/** A working-tree read cannot reproduce a tree instrument's basis: refuse instead of under-measuring. */
function refuseWorkingTreeInstrument(key: TreeInstrumentKey | undefined): void {
  if (key) throw new Error(`repo_measurement_tree_instrument_requires_commit:${key}`);
}

async function repoFilesPrimaryPathsAtRoot(root: string, parsed: RepoFilesEvidenceMeasurement): Promise<string[]> {
  return [...(await expandedRepoSourcePathsAtRoot(root, parsed)), ...(parsed.testPaths ?? [])];
}

/** The UNFENCED read. Callers own the mutation-probe fence on both sides of it. */
async function fingerprintRepoFilesMeasurement(
  root: string,
  parsed: RepoFilesEvidenceMeasurement,
  expandedSourcePaths?: readonly string[],
  fixtureRoot: string = root,
  fixtureRootHarnessSlug?: string,
  expandedFixturePaths?: readonly string[],
): Promise<DetailedRepoEvidenceMeasurement> {
  refuseWorkingTreeInstrument(parsed.treeInstrumentKey);
  const sourcePaths = expandedSourcePaths ?? (await expandedRepoSourcePathsAtRoot(root, parsed));
  const fixturePaths = expandedFixturePaths ?? (await expandedRepoFixturePathsAtRoot(fixtureRoot, parsed));
  const [source, test, fixture] = await Promise.all([
    fingerprintRepoFileSet(root, sourcePaths),
    parsed.testPaths ? fingerprintRepoFileSet(root, parsed.testPaths) : Promise.resolve(null),
    fixturePaths.length > 0 ? fingerprintRepoFileSet(fixtureRoot, fixturePaths, REPO_FIXTURE_READ_LIMITS) : Promise.resolve(null),
  ]);
  const fixtureIdentity = fixtureRootHarnessSlug ? { rootHarnessSlug: fixtureRootHarnessSlug } : {};
  return {
    sourceFingerprint: source.fingerprint,
    testFingerprint: test?.fingerprint ?? null,
    ...(fixture ? { fixtureFingerprint: fixture.fingerprint } : {}),
    files: [
      ...source.files.map((file) => ({ ...file, dimension: 'source' as const })),
      ...(test?.files ?? []).map((file) => ({ ...file, dimension: 'test' as const })),
      ...(fixture?.files ?? []).map((file) => ({ ...file, ...fixtureIdentity, dimension: 'fixture' as const })),
    ],
  };
}

/** Recompute a bounded repository-backed evidence tuple from the current harness tree. */
export async function measureRepoFilesEvidenceAtRoot(
  repoRoot: string,
  measurement: RepoFilesEvidenceMeasurement,
  options: { fixtureRoot?: string; fixtureRootHarnessSlug?: string } = {},
): Promise<MeasuredRepoEvidenceFingerprints> {
  const detailed = await measureRepoFilesEvidenceDetailedAtRoot(repoRoot, measurement, options);
  const { sourceFingerprint, testFingerprint, fixtureFingerprint } = detailed;
  return {
    sourceFingerprint,
    testFingerprint,
    ...(fixtureFingerprint !== undefined ? { fixtureFingerprint } : {}),
    ...(measurement.artifactReceiptPath ? { environmentFingerprint: await measurePackagedArtifactEnvironment(
      repoRoot, measurement.artifactReceiptPath,
      detailed.files.find(file => file.path === measurement.artifactReceiptPath && file.dimension === 'source')!.sha256,
      { verifyExpectations: true }) } : {}),
  };
}

/**
 * Measure a repo-files recipe AND pin it to the commit(s) it was measured against
 * (P-018). The fingerprints come from the same single read the pin's per-file hashes
 * do, so the two can never describe different bytes. Pinning never fails the
 * measurement: a git probe that fails is recorded inside the pin.
 */
export async function measureAndPinRepoFilesEvidenceAtRoot(
  repoRoot: string,
  measurement: RepoFilesEvidenceMeasurement,
  options: { git?: GitRunner; fixtureRoot?: string; fixtureRootHarnessSlug?: string } = {},
): Promise<MeasuredRepoEvidenceFingerprints & { pin: MeasurementPin }> {
  const root = await realpath(repoRoot);
  const fixtureRoot = await realpath(options.fixtureRoot ?? root);
  const fixtureRootHarnessSlug = options.fixtureRootHarnessSlug ?? measurement.fixtureRootHarnessSlug;
  const detailed = await measureRepoFilesEvidenceDetailedAtRoot(root, measurement, {
    fixtureRoot,
    ...(fixtureRootHarnessSlug ? { fixtureRootHarnessSlug } : {}),
  });
  const pin = await buildMeasurementPin(root, detailed.files, {
    ...(options.git ? { git: options.git } : {}),
    ...(fixtureRootHarnessSlug ? { roots: { [fixtureRootHarnessSlug]: fixtureRoot } } : {}),
  });
  await retainCompletedRuntimeArtifacts(measurement);
  return {
    sourceFingerprint: detailed.sourceFingerprint,
    testFingerprint: detailed.testFingerprint,
    ...(detailed.fixtureFingerprint !== undefined ? { fixtureFingerprint: detailed.fixtureFingerprint } : {}),
    ...(measurement.artifactReceiptPath ? { environmentFingerprint: await measurePackagedArtifactEnvironment(
      root, measurement.artifactReceiptPath,
      detailed.files.find(file => file.path === measurement.artifactReceiptPath && file.dimension === 'source')!.sha256,
      { verifyExpectations: true }) } : {}),
    pin,
  };
}

/**
 * Measure and pin a repo-files recipe from the bytes committed at the commit an
 * as-committed test run executed (D-001 (b)): the bind stores what actually ran, so the
 * shared checkout moving past that commit neither refuses the bind nor leaks into its
 * fingerprint. The pin's per-file sha256 (what names moved paths later) comes from that
 * commit; its head/clean fields still describe the checkout's HEAD at bind time.
 */
export async function measureAndPinRepoFilesEvidenceAtCommitForScope(
  workspaceId: string,
  harnessSlug: string,
  measurement: RepoFilesEvidenceMeasurement,
  at: { commitSha: string; repoPrefix: string | null },
  options: { git?: GitRunner } = {},
): Promise<MeasuredRepoEvidenceFingerprints & { pin: MeasurementPin }> {
  if (measurement.nativeInstrumentKey) {
    throw new Error('Native storage observations cannot certify a historical test commit; bind a new live observation.');
  }
  const root = await realpath(await resolveMeasurementRoot(workspaceId, harnessSlug, measurement));
  const fixtureRootHarnessSlug = measurement.fixtureRootHarnessSlug;
  const fixtureRoot = hasRepoFixturePaths(measurement)
    ? await realpath(await resolveMeasurementRoot(workspaceId, harnessSlug, measurement, 'fixture'))
    : root;
  const fixtureCommit = fixtureRoot === root ? at.commitSha : await resolveMeasurementCommit(fixtureRoot);
  const detailed = await measureRepoFilesEvidenceDetailedAtCommit(root, measurement, at.commitSha, {
    repoPrefix: at.repoPrefix,
    ...(hasRepoFixturePaths(measurement) ? { fixtureRoot, fixtureCommit, fixtureRootHarnessSlug } : {}),
    ...(options.git ? { deps: { git: options.git } } : {}),
  });
  const pin = await buildMeasurementPin(root, detailed.files, {
    ...(options.git ? { git: options.git } : {}),
    ...(hasRepoFixturePaths(measurement) && fixtureRootHarnessSlug ? { roots: { [fixtureRootHarnessSlug]: fixtureRoot } } : {}),
  });
  await retainCompletedRuntimeArtifacts(measurement);
  return {
    sourceFingerprint: detailed.sourceFingerprint,
    testFingerprint: detailed.testFingerprint,
    ...(detailed.fixtureFingerprint !== undefined ? { fixtureFingerprint: detailed.fixtureFingerprint } : {}),
    ...(measurement.artifactReceiptPath ? { environmentFingerprint: await measurePackagedArtifactEnvironment(
      root, measurement.artifactReceiptPath,
      detailed.files.find(file => file.path === measurement.artifactReceiptPath && file.dimension === 'source')!.sha256,
      { verifyExpectations: true }) } : {}),
    pin,
  };
}

export async function resolveMeasurementRoot(
  workspaceId: string,
  harnessSlug: string,
  measurement?: Pick<RepoFilesEvidenceMeasurement, 'rootHarnessSlug' | 'fixtureRootHarnessSlug'>,
  dimension: 'source' | 'fixture' = 'source',
): Promise<string> {
  const registry = await loadHarnessRegistry(workspaceId);
  const primaryRootHarnessSlug = measurement?.rootHarnessSlug ?? harnessSlug;
  const rootHarnessSlug = dimension === 'fixture'
    ? measurement?.fixtureRootHarnessSlug ?? primaryRootHarnessSlug
    : primaryRootHarnessSlug;
  const root = resolveHarnessContentPath(registry, rootHarnessSlug);
  if (!root) throw new Error(`repo_measurement_harness_root_unavailable:${rootHarnessSlug}`);
  return root;
}

/** Resolve the canonical harness checkout and measure the declared file sets there. */
export async function measureRepoFilesEvidence(
  workspaceId: string,
  harnessSlug: string,
  measurement: RepoFilesEvidenceMeasurement,
): Promise<MeasuredRepoEvidenceFingerprints> {
  const root = await resolveMeasurementRoot(workspaceId, harnessSlug, measurement);
  const fixtureRoot = hasRepoFixturePaths(measurement)
    ? await resolveMeasurementRoot(workspaceId, harnessSlug, measurement, 'fixture')
    : root;
  const fixtureRootHarnessSlug = measurement.fixtureRootHarnessSlug;
  const measured = await measureRepoFilesEvidenceAtRoot(root, measurement, {
    ...(hasRepoFixturePaths(measurement) ? { fixtureRoot, fixtureRootHarnessSlug } : {}),
  });
  return { ...measured, ...(measurement.nativeInstrumentKey
    ? await liveRuntimeEnvironment(workspaceId, harnessSlug, measurement) : {}) };
}

/**
 * Observe a live repo-files recipe's named runtimes NOW, exactly as the read path re-measures
 * them, so a manual live probe stores the runtime it was observed against instead of NULL
 * (WI-6554700010008521). A completedRuntime recipe belongs to a test run's execution witness,
 * and bindSpecEvidence replaces any testRunId binding's input with that witness, so neither
 * is restamped from the binding-time runtime here.
 */
async function liveRuntimeEnvironment(
  workspaceId: string,
  harnessSlug: string,
  measurement: RepoFilesEvidenceMeasurement,
): Promise<{ environmentFingerprint?: string | null }> {
  if (measurement.nativeInstrumentKey) return {
    environmentFingerprint: await measureNativeColdEnvironment(workspaceId, harnessSlug, measurement.nativeInstrumentKey, true),
  };
  if (!measurement.runtimeUnits || measurement.completedRuntime) return {};
  return {
    environmentFingerprint: await measureRuntimeEnvironment(
      await listRuntimeVintage(workspaceId), measurement.runtimeUnits),
  };
}

/**
 * A working-tree bind must be reproducible by listSpecEvidence, which reads committed files
 * whenever the measurement root has a HEAD. buildMeasurementPin records whether each
 * fingerprinted file matches that HEAD; refuse instead of storing a dirty-tree digest that
 * can become falsely current as soon as the dirty bytes are committed.
 */
function refuseUnreproducibleWorkingTreeMeasurement(
  pin: MeasurementPin,
  measurement: RepoFilesEvidenceMeasurement,
  harnessSlug: string,
): void {
  const repoByKey = new Map(pin.repos.map((repo) => [`${repo.rootHarnessSlug ?? ''}\0${repo.repo}`, repo]));
  const mismatched = pin.files.filter((file) => {
    const repo = repoByKey.get(`${file.rootHarnessSlug ?? ''}\0${file.repo}`);
    return repo?.head != null && file.clean !== true;
  });
  if (mismatched.length === 0) return;
  const paths = mismatched.map((file) => {
    const rootHarnessSlug = file.rootHarnessSlug ?? measurement.rootHarnessSlug ?? harnessSlug;
    const state = file.clean === false ? 'dirty' : 'clean-state-unavailable';
    return `${rootHarnessSlug}:${file.path}:${state}`;
  }).sort();
  throw new Error(`repo_measurement_not_clean_at_head:${paths.join(',')}`);
}

/** Resolve both registered roots when fixture calibration lives outside the tested checkout. */
export async function measureAndPinRepoFilesEvidence(
  workspaceId: string,
  harnessSlug: string,
  measurement: RepoFilesEvidenceMeasurement,
  options: { git?: GitRunner } = {},
): Promise<MeasuredRepoEvidenceFingerprints & { pin: MeasurementPin }> {
  const root = await resolveMeasurementRoot(workspaceId, harnessSlug, measurement);
  const fixtureRoot = hasRepoFixturePaths(measurement)
    ? await resolveMeasurementRoot(workspaceId, harnessSlug, measurement, 'fixture')
    : root;
  const fixtureRootHarnessSlug = measurement.fixtureRootHarnessSlug ?? measurement.rootHarnessSlug ?? harnessSlug;
  const measured = await measureAndPinRepoFilesEvidenceAtRoot(root, measurement, {
    ...options,
    ...(hasRepoFixturePaths(measurement) ? { fixtureRoot, fixtureRootHarnessSlug } : {}),
  });
  refuseUnreproducibleWorkingTreeMeasurement(measured.pin, measurement, harnessSlug);
  // Spread last: like the read path, named runtimes take precedence over an artifact receipt.
  return { ...measured, ...(await liveRuntimeEnvironment(workspaceId, harnessSlug, measurement)) };
}

/**
 * Recompute a bounded ledger-state evidence tuple from the CURRENT work-item rows.
 *
 * Only the disposition-bearing column is hashed. Hashing the whole row would make the binding
 * go stale on any incidental touch (a comment, a re-checkpoint), which would train readers to
 * ignore staleness; hashing `status` alone means the digest changes exactly when the claim
 * "these rows reached a recorded disposition" stops being true.
 *
 * A row that is ABSENT is hashed as an explicit `null` rather than skipped, so a deleted row —
 * or a typo'd id that never existed — cannot silently produce the same digest as a present one.
 */
export async function measureWorkItemsEvidenceForScope(
  workspaceId: string,
  harnessSlug: string,
  measurement: WorkItemsEvidenceMeasurement,
  runtimeRows?: Awaited<ReturnType<typeof listRuntimeVintage>>,
): Promise<MeasuredRepoEvidenceFingerprints> {
  const parsed = workItemsEvidenceMeasurementSchema.parse(measurement);
  const ids = [...new Set(parsed.workItemIds)].sort();
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<{ feature_id: string; status: string | null }[]>`
      SELECT feature_id, status
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${harnessSlug}
         AND feature_id = ANY(${ids}::text[])`;
  });
  const statusById = new Map(rows.map((row) => [row.feature_id, row.status]));
  const entries = ids.map((id) => ({ id, status: statusById.get(id) ?? null }));
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  const environmentFingerprint = parsed.runtimeUnits
    ? await measureRuntimeEnvironment(runtimeRows ?? await listRuntimeVintage(workspaceId), parsed.runtimeUnits)
    : undefined;
  return {
    sourceFingerprint: `sha256-work-item-set-v1:${digest}`,
    testFingerprint: null,
    ...(parsed.runtimeUnits ? { environmentFingerprint } : {}),
  };
}

/** Dispatch a measurement recipe to its basis. Both bases are server-measured, never caller-attested. */
export async function measureEvidenceForScope(
  workspaceId: string,
  harnessSlug: string,
  measurement: EvidenceMeasurement,
): Promise<MeasuredRepoEvidenceFingerprints> {
  return measurement.kind === 'work-items'
    ? measureWorkItemsEvidenceForScope(workspaceId, harnessSlug, measurement)
    : measureRepoFilesEvidence(workspaceId, harnessSlug, measurement);
}

/**
 * `measureEvidenceForScope` plus the P-018 commit pin for a repo-files basis. A ledger
 * (`work-items`) basis has no checkout, so it carries no pin.
 */
export async function measureAndPinEvidenceForScope(
  workspaceId: string,
  harnessSlug: string,
  measurement: EvidenceMeasurement,
): Promise<MeasuredRepoEvidenceFingerprints & { pin: MeasurementPin | null }> {
  if (measurement.kind === 'work-items') {
    return { ...(await measureWorkItemsEvidenceForScope(workspaceId, harnessSlug, measurement)), pin: null };
  }
  return measureAndPinRepoFilesEvidence(workspaceId, harnessSlug, measurement);
}

const MAX_OPERATIONAL_ARTIFACT_BYTES = 8 * 1024 * 1024;

export type OperationalEvidenceDisclosureRow = {
  id?: number;
  evidenceKind: SpecEvidenceKind;
  evidenceRef: string;
  details: Record<string, unknown>;
  currentness: { overall: string };
  serverMeasurement?: { status: string; measuredAtCommit?: string };
};

export type OperationalArtifactRead =
  | { artifact: Record<string, unknown>; sha256: string; measuredAtCommit: string | null }
  | { error: string };

/**
 * Read explicit coverage disclosures from a current, server-measured operational
 * evidence artifact. Opaque/manual bindings and caller-attested fingerprints are
 * deliberately excluded: only a file included in the repo-files measurement and
 * measured current by listSpecEvidence can contribute artifact disclosures.
 */
export async function readCurrentOperationalArtifacts(
  workspaceId: string,
  harnessSlug: string,
  rows: readonly OperationalEvidenceDisclosureRow[],
): Promise<Map<number, OperationalArtifactRead>> {
  const candidates = rows.flatMap((row) => {
    if (
      row.id === undefined ||
      !Number.isSafeInteger(row.id) ||
      row.evidenceKind !== 'operational' ||
      row.currentness.overall !== 'current' ||
      row.serverMeasurement?.status !== 'measured'
    ) return [];
    const measurement = evidenceMeasurementSchema.safeParse(row.details.currentMeasurement);
    return measurement.success &&
      measurement.data.kind === 'repo-files' &&
      measurement.data.sourcePaths.includes(row.evidenceRef)
      ? [{ row, measurement: measurement.data }]
      : [];
  });
  if (candidates.length === 0) return new Map();

  const roots = new Map<string, Promise<string>>();
  const byReference = new Map<string, Promise<OperationalArtifactRead>>();
  const readOne = (
    evidenceRef: string,
    measurement: RepoFilesEvidenceMeasurement,
    measuredAtCommit: string | undefined,
  ): Promise<OperationalArtifactRead> => {
    const rootKey = measurement.rootHarnessSlug ?? harnessSlug;
    const key = JSON.stringify([rootKey, evidenceRef, measuredAtCommit ?? null]);
    const existing = byReference.get(key);
    if (existing) return existing;
    const task = (async () => {
      let root: string;
      try {
        let rootPromise = roots.get(rootKey);
        if (!rootPromise) {
          rootPromise = realpath(await resolveMeasurementRoot(workspaceId, harnessSlug, measurement));
          roots.set(rootKey, rootPromise);
        }
        root = await rootPromise;
      } catch (error) {
        const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
        return { error: `The measured operational evidence repository could not be resolved: ${reason.slice(0, 180)}` };
      }
      const pathParts = evidenceRef.split('/');
      if (
        isAbsolute(evidenceRef) ||
        evidenceRef.includes('\\') ||
        pathParts.some((part) => part === '' || part === '.' || part === '..')
      ) return { error: 'The current operational evidence artifact path is unsafe.' };
      const candidate = resolve(root, evidenceRef);
      if (!containedBy(root, candidate)) {
        return { error: 'The current operational evidence artifact resolves outside its repository root.' };
      }
      try {
        const canonical = await realpath(candidate);
        if (!containedBy(root, canonical)) {
          return { error: 'The current operational evidence artifact follows a path outside its repository root.' };
        }
        const info = await stat(canonical);
        if (!info.isFile() || info.size > MAX_OPERATIONAL_ARTIFACT_BYTES) {
          return { error: 'The current operational evidence artifact is not a bounded regular file.' };
        }
        const bytes = await readFile(canonical);
        if (bytes.length > MAX_OPERATIONAL_ARTIFACT_BYTES) {
          return { error: 'The current operational evidence artifact exceeds the read bound.' };
        }
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (measuredAtCommit) {
          if (!/^[a-f0-9]{40,64}$/.test(measuredAtCommit)) {
            return { error: 'The operational evidence measurement commit is invalid.' };
          }
          const committed = (await readCommittedFiles(root, measuredAtCommit, [evidenceRef], {},
            REPO_FILE_SET_READ_LIMITS)).get(evidenceRef);
          if (!committed || committed.sha256 !== digest) {
            return { error: 'The operational evidence artifact differs from its server-measured committed bytes.' };
          }
        }
        const parsed: unknown = JSON.parse(bytes.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { error: 'The current operational evidence artifact is not a JSON object.' };
        }
        return { artifact: parsed as Record<string, unknown>, sha256: digest,
          measuredAtCommit: measuredAtCommit ?? null };
      } catch (error) {
        const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
        return { error: `The current operational evidence artifact could not be read: ${reason.slice(0, 180)}` };
      }
    })();
    byReference.set(key, task);
    return task;
  };

  const output = new Map<number, OperationalArtifactRead>();
  await Promise.all(candidates.map(async ({ row, measurement }) => {
    output.set(row.id!, await readOne(row.evidenceRef, measurement, row.serverMeasurement?.measuredAtCommit));
  }));
  return output;
}

/** Disclosure and runtime-acceptance consumers share the same artifact admission/read fence. */
export async function readCurrentOperationalArtifactDisclosures(
  workspaceId: string,
  harnessSlug: string,
  rows: readonly OperationalEvidenceDisclosureRow[],
): Promise<Map<number, string[]>> {
  const output = new Map<number, string[]>();
  for (const [id, result] of await readCurrentOperationalArtifacts(workspaceId, harnessSlug, rows)) {
    if ('error' in result) {
      output.set(id, [result.error]);
    } else if (result.artifact.kind === 'operational-test-evidence') {
        const artifact = result.artifact;
        const gaps: string[] = [];
        for (const field of ['disclosures', 'couldNotDetermine'] as const) {
          const value = artifact[field];
          if (Array.isArray(value)) {
            for (const entry of value) {
              const detail = typeof entry === 'string'
                ? entry.trim()
                : JSON.stringify(entry);
              gaps.push(detail
                ? `Artifact ${field}: ${detail}`
                : `Artifact ${field} contains an entry whose disclosure could not be read.`);
            }
          } else if (value !== undefined && value !== null) {
            gaps.push(`Artifact ${field} is malformed, so its disclosure could not be verified.`);
          }
        }
        if (gaps.length > 0) output.set(id, gaps);
    }
  }
  return output;
}

function measurementFromDetails(details: Record<string, unknown>): EvidenceMeasurement | null {
  const parsed = evidenceMeasurementSchema.safeParse(details.currentMeasurement);
  return parsed.success ? parsed.data : null;
}
/** Shared wire contract for an explicit comparison with currently measured proof. */
export const evidenceCurrentInputSchema = z.object({
  planSlug: z.string().trim().min(1).max(2000).optional(),
  specId: z.string().trim().min(1).max(2000).optional(),
  specRevision: z.number().int().positive().optional(),
  specFingerprint: evidenceFingerprintSchema.optional(),
  evidenceKind: z.enum(SPEC_EVIDENCE_KINDS),
  evidenceRef: z.string().trim().min(1).max(2000),
  sourceFingerprint: evidenceFingerprintSchema,
  testFingerprint: evidenceFingerprintSchema.nullable().optional(),
  fixtureFingerprint: evidenceFingerprintSchema.nullable().optional(),
  rubricFingerprint: evidenceFingerprintSchema.nullable().optional(),
  environmentFingerprint: evidenceFingerprintSchema.nullable().optional(),
}).superRefine((input, ctx) => {
  const identity = [input.planSlug, input.specId, input.specRevision, input.specFingerprint];
  if (identity.some((value) => value !== undefined) && !identity.every((value) => value !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['planSlug'],
      message: 'planSlug, specId, specRevision, and specFingerprint must be supplied together',
    });
  }
});

export interface EvidenceFingerprints {
  sourceFingerprint: string;
  testFingerprint?: string | null;
  fixtureFingerprint?: string | null;
  rubricFingerprint?: string | null;
  environmentFingerprint?: string | null;
}

export interface DuplicateLiveTestRunBindingAdvisory {
  code: 'duplicate_live_test_run_bindings';
  testRunId: number;
  bindingIds: number[];
  message: string;
}

export interface BindSpecEvidenceInput extends EvidenceFingerprints {
  harnessSlug?: string;
  /** Explicit workspace for internal callers such as plan promotion; public tool calls use the active workspace. */
  workspaceId?: string;
  /**
   * The plan whose spec clause this evidence binds to. OPTIONAL as of P-022: omit it for
   * an ad-hoc work-item that belongs to no plan, and the binding is scoped to
   * {@link ADHOC_WORK_ITEM_SPEC_SCOPE} instead.
   *
   * D-018 records why this is resolved rather than made nullable: `plan_slug` is a PRIMARY
   * KEY column in all four tables of the spec chain and carries a composite FK that
   * terminates at `harness_plans`, so it can never hold NULL. The blocker was never the
   * column — it was that the API forced a caller with no plan to invent one.
  */
  planSlug?: string;
  workItemId: string;
  specId?: string;
  sourceValId?: string;
  specRevision?: number;
  evidenceKind: SpecEvidenceKind;
  evidenceRef: string;
  coverageEvidenceRef?: number | null;
  testRunId?: number | null;
  /**
   * P-008: the implementer binding an `independent-verification` row re-observed.
   * Required for that kind, refused for every other kind.
   */
  verifiesBindingId?: number | null;
  details?: Record<string, unknown>;
  observedAt?: string;
  actorId: string;
}

/**
 * P-008 (D-005) bind-time refusals at plans:bind-spec-evidence. Named on its own so the
 * verification-system map can register exactly these contract refusals
 * (CONTRACT_GATE_CODE_TYPES) without the result union's non-refusal statuses. The
 * union below uses Extract<> over this alias, so a member renamed in one place and
 * not the other fails the typecheck.
 */
export type IndependentVerificationRefusalStatus =
  | 'verified_binding_required'
  | 'verified_binding_not_allowed'
  | 'verified_binding_not_found'
  | 'independent_fingerprint_mismatch'
  // WI-6554700010018061: a fixture-free review fixture-absence certification would never pair.
  | 'fixture_absence_pairing_mismatch';

/** Refuse evidence that targets a work-item not promoted from this clause's plan item. */
export type WorkItemPlanItemRefusalStatus = 'work_item_plan_item_mismatch';
export type MutationCaughtCaseClaimRefusalStatus = 'mutation_caught_case_claim_mismatch';

/**
 * EI-27081440896857039: a test-run binding takes its environment ONLY from that run's own
 * execution-time witness. A run that recorded none for the declared runtimeUnits is still
 * stored (environment unproven, by design), but a live/deployed claim on it can never read
 * environment=current — so the binder says so at bind time instead of leaving the caller to
 * discover a NULL environment_fingerprint later.
 */
export interface TestRunEnvironmentUnprovenWarning {
  reason: 'test_run_runtime_witness_missing';
  testRunId: number;
  runtimeUnits: string[];
  evidencePlane: 'live' | 'deployed';
  message: string;
}

/** Pure: the bind-time warning for a stored test-run row whose live/deployed environment is unprovable. */
export function testRunEnvironmentUnprovenWarning(input: {
  testRunId: number | null | undefined;
  runtimeUnits: readonly string[] | undefined;
  completedRuntime: boolean;
  environmentFingerprint: string | null | undefined;
  details: Record<string, unknown>;
}): TestRunEnvironmentUnprovenWarning | undefined {
  if (input.testRunId == null || !input.runtimeUnits?.length || input.completedRuntime) return undefined;
  if (input.environmentFingerprint != null) return undefined;
  const plane = readSpecEvidencePlane(input.details);
  const normalizedPlane = typeof plane === 'string' ? plane.trim().toLowerCase() : null;
  if (normalizedPlane !== 'live' && normalizedPlane !== 'deployed') return undefined;
  return {
    reason: 'test_run_runtime_witness_missing',
    testRunId: input.testRunId,
    runtimeUnits: [...input.runtimeUnits],
    evidencePlane: normalizedPlane,
    message:
      `Stored, but environment is UNPROVEN: test-run ${input.testRunId} recorded no stable execution-time ` +
      `runtime witness for runtimeUnits ${JSON.stringify(input.runtimeUnits)}, so this ${normalizedPlane}-plane ` +
      'binding can never read environment=current or satisfy that plane. Retract it and either omit testRunId ' +
      'so the server stamps the binding-time runtime of the declared units (a live probe), or record a new run ' +
      'whose execution carries runtimeEnvironmentBefore/After for exactly these units.',
  };
}

export type BindSpecEvidenceResult =
  | {
      status: 'created' | 'unchanged';
      id: number;
      workItemId: string;
      planSlug: string;
      specId: string;
      sourceValId: string | null;
      specRevision: number;
      specFingerprint: string;
      bindingFingerprint: string;
      advisory?: DuplicateLiveTestRunBindingAdvisory;
      /** EI-27081440896857039: the stored live/deployed row can never read environment=current. */
      environmentUnproven?: TestRunEnvironmentUnprovenWarning;
    }
  | { status: 'work_item_not_found'; workItemId: string }
  | {
      status: WorkItemPlanItemRefusalStatus;
      workItemId: string;
      planSlug: string;
      specId: string;
      planItemId: string;
      actualPlanSlug: string | null;
      actualPlanItemIds: string[];
      message: string;
    }
  | { status: 'spec_not_found'; specId?: string; sourceValId?: string; message?: string }
  | { status: 'spec_revision_not_found'; specId: string; specRevision: number }
  | { status: 'coverage_evidence_not_found'; coverageEvidenceRef: number }
  // P-008 (D-005): independent-verification refusals.
  | { status: Extract<IndependentVerificationRefusalStatus, 'verified_binding_required' | 'verified_binding_not_allowed'>; message: string }
  | { status: Extract<IndependentVerificationRefusalStatus, 'verified_binding_not_found'>; verifiesBindingId: number; message: string }
  | {
      status: Extract<IndependentVerificationRefusalStatus, 'independent_fingerprint_mismatch'>;
      verifiesBindingId: number;
      mismatched: Array<'source' | 'environment'>;
      /** The cited binding's test run, when its proof is a recorded execution (EI-25847620673275477). */
      citedTestRunId?: number;
      message: string;
    }
  | {
      status: Extract<IndependentVerificationRefusalStatus, 'fixture_absence_pairing_mismatch'>;
      verifiesBindingId: number;
      /** Each key on which resolveFixtureAbsenceVerifications would skip this review. */
      mismatched: FixtureAbsencePairingKey[];
      message: string;
    }
  | {
      status: 'test_cases_ambiguous_in_run';
      testRunId: number;
      declaredCaseCount: number;
      source: 'case-ledger' | 'passed-case-titles';
      ambiguousTestCases: Array<{ testCase: string; matchingCaseTitles: string[] }>;
      message: string;
    }
  | {
      status: 'test_cases_not_in_run';
      testRunId: number;
      declaredCaseCount: number;
      failedCaseTitleCount: number;
      source: 'mutation-failed-case-titles';
      /** Declared titles that are not exact identities in this mutant run's measured failures. */
      unmatchedTestCases: string[];
      message: string;
    }
  | {
      status: 'test_cases_not_in_run';
      testRunId: number;
      declaredCaseCount: number;
      passedCaseTitleCount: number;
      /** Which record judged the declared cases: the per-case ledger, or the run's capped title list. */
      source?: 'case-ledger' | 'passed-case-titles';
      /** Declared titles that matched no executed recorded case (case-ledger source only). */
      unmatchedTestCases?: string[];
      message: string;
    }
  | {
      status: MutationCaughtCaseClaimRefusalStatus;
      testRunId: number;
      field: 'observations' | 'calibration';
      failedCaseTitles?: string[];
      message: string;
    }
  | {
      status: 'test_run_measurement_recipe_changed' | 'test_run_measurement_recipe_unverified';
      testRunId: number;
      previousSpecRevision: number;
      specRevision: number;
      message: string;
    }
  // An isolated integration run's retained source receipt is the execution-time
  // witness for the repo-files source set. Refuse a hand-built recipe that names
  // source paths the run never recorded, instead of persisting proof whose later
  // environment re-measurement can only return unknown.
  | {
      status: 'completed_runtime_source_not_in_receipt';
      gaps: Array<{ runId: string; missingSourcePaths: string[] }>;
      message: string;
    }
  // The test-run lookup is tenant-scoped, so a row that EXISTS but carries a
  // different (or NULL) harness_slug is indistinguishable from a fabricated id
  // — both surface as a bare `test_run_not_found`, which reads as "you invented
  // that id" and sends the caller hunting for the wrong bug. harness_slug is
  // stamped from the runner's environment, so it is legitimately NULL whenever a
  // run was started without a harness (for example `testing:run` called without
  // its optional `harness` arg), and those rows are then permanently unbindable
  // with no signal at the point of failure. `scopeMismatch` distinguishes the two
  // cases and names the row's actual tenancy so the fix is obvious.
  | {
      status: 'test_run_not_found';
      testRunId: number;
      scopeMismatch?: {
        foundOutsideScope: true;
        rowHarnessSlug: string | null;
        rowWorkspaceId: string | null;
        expectedHarnessSlug: string;
        expectedWorkspaceId: string;
        hint: string;
      };
    };

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalJson(nested)]),
    );
  }
  return value;
}

const nullableTrimmed = (value: string | null | undefined): string | null => value?.trim() || null;

interface CanonicalBinding {
  workspaceId: string;
  harnessSlug: string;
  workItemId: string;
  planSlug: string;
  specId: string;
  specRevision: number;
  specFingerprint: string;
  evidenceKind: SpecEvidenceKind;
  evidenceRef: string;
  sourceFingerprint: string;
  testFingerprint: string | null;
  fixtureFingerprint: string | null;
  rubricFingerprint: string | null;
  environmentFingerprint: string | null;
  coverageEvidenceRef: number | null;
  testRunId: number | null;
  /** P-008: present ONLY for independent-verification rows, so legacy fingerprints are unchanged. */
  verifiesBindingId?: number;
  details: Record<string, unknown>;
}

export function specEvidenceBindingFingerprint(input: CanonicalBinding): string {
  // P-018: the commit pin describes WHERE the bytes were measured, not the proof. A HEAD
  // sha moves with every unrelated commit, so fingerprinting it would turn a re-bind of
  // byte-identical proof into a fresh row instead of `unchanged`. Rows that predate the
  // pin carry no such key, so their fingerprints are unchanged by this omission.
  const { [MEASUREMENT_PIN_DETAILS_KEY]: _pin, ...fingerprintedDetails } = input.details;
  return createHash('sha256')
    .update(JSON.stringify(canonicalJson({ ...input, details: fingerprintedDetails })))
    .digest('hex');
}

interface SpecIdentityRow {
  spec_id: string;
  source_val_id: string | null;
  current_revision: number;
}

interface SpecRevisionRow {
  content_hash: string;
  plan_item_id: string;
}

interface PriorTestRunBindingRow {
  spec_revision: number;
  source_fingerprint: string;
  test_fingerprint: string | null;
  fixture_fingerprint: string | null;
  rubric_fingerprint: string | null;
  environment_fingerprint: string | null;
  details: Record<string, unknown>;
}

/** Resolve the selector and append one idempotent exact evidence binding. */
export async function bindSpecEvidence(input: BindSpecEvidenceInput): Promise<BindSpecEvidenceResult> {
  const scope = await resolvePlanScope({ harnessSlug: input.harnessSlug, workspaceId: input.workspaceId });
  const writeBinding = (): Promise<BindSpecEvidenceResult> => withWorkspace(scope.workspaceId, async (tx) => {
    // P-022 / D-018: a caller with no plan gets the harness's shared ad-hoc spec scope
    // rather than being forced to invent a plan slug. Everything downstream then runs
    // unchanged, which is the point: no PK, FK, index or freshness invariant moves.
    const planSlug = await resolveSpecScopeSlug(tx, scope.workspaceId, scope.harnessSlug, input.planSlug);
    const lockKey = `${scope.workspaceId}:${scope.harnessSlug}:${input.workItemId}:${planSlug}:${input.specId ?? input.sourceValId}`;
    await tx`SELECT pg_advisory_xact_lock(hashtext('spec_evidence_binding'), hashtext(${lockKey}))`;

    const workItems = await tx<{
      feature_id: string;
      source_plan_slug: string | null;
      source_plan_item_ids: string[] | null;
      stamped_plan_slug: string | null;
      stamped_item_id: string | null;
    }[]>`
      SELECT feature_id, source_plan_slug, source_plan_item_ids,
             payload -> 'plan_item' ->> 'plan_slug' AS stamped_plan_slug,
             payload -> 'plan_item' ->> 'item_id' AS stamped_item_id
        FROM harness_shared.work_items
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND feature_id = ${input.workItemId}`;
    if (!workItems[0]) return { status: 'work_item_not_found', workItemId: input.workItemId };

    const identities = await tx<SpecIdentityRow[]>`
      SELECT spec_id, source_val_id, current_revision
        FROM harness_shared.plan_spec_clauses
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND plan_slug = ${planSlug}
         AND (${input.specId ?? null}::text IS NULL OR spec_id = ${input.specId ?? null})
         AND (${input.sourceValId ?? null}::text IS NULL OR source_val_id = ${input.sourceValId ?? null})`;
    const identity = identities[0];
    if (!identity) {
      return {
        status: 'spec_not_found',
        ...(input.specId ? { specId: input.specId } : {}),
        ...(input.sourceValId ? { sourceValId: input.sourceValId } : {}),
        ...(!input.planSlug?.trim()
          ? {
              message:
                `spec_not_found in ${planSlug} (no slug supplied; defaulted to the ad-hoc scope). ` +
                'For a clause on a named plan, pass slug to plans:bind-spec-evidence.',
            }
          : {}),
      };
    }

    const specRevision = input.specRevision ?? Number(identity.current_revision);
    const revisions = await tx<SpecRevisionRow[]>`
      SELECT content_hash, plan_item_id
        FROM harness_shared.plan_spec_clause_revisions
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND plan_slug = ${planSlug}
         AND spec_id = ${identity.spec_id}
         AND revision = ${specRevision}`;
    const revision = revisions[0];
    if (!revision) return { status: 'spec_revision_not_found', specId: identity.spec_id, specRevision };

    // Named clauses require either their promoted work-item provenance or an
    // existing explicit behavior-contract edge. The resolver follows that same
    // clause identity to its current revision, including for standalone items;
    // requiring promotion here made their enforced obligations impossible to prove.
    // Historical edges remain authority for that identity (their immutable revision
    // and fingerprint are verified by the edge table's composite foreign key).
    // Check BEFORE the insert below: a binding must never authorize its own edge.
    if (planSlug !== ADHOC_WORK_ITEM_SPEC_SCOPE) {
      const provenance = planItemProvenanceFromRow(workItems[0]);
      if (provenance.planSlug !== planSlug || !provenance.itemIds.includes(revision.plan_item_id)) {
        const [contractEdge] = await tx<{ present: number }[]>`
          SELECT 1 AS present FROM harness_shared.work_item_spec_revision_edges
           WHERE workspace_id = ${scope.workspaceId}
             AND harness_slug = ${scope.harnessSlug}
             AND work_item_id = ${input.workItemId}
             AND plan_slug = ${planSlug}
             AND spec_id = ${identity.spec_id}
           LIMIT 1`;
        if (!contractEdge) {
          return {
            status: 'work_item_plan_item_mismatch',
            workItemId: input.workItemId,
            planSlug,
            specId: identity.spec_id,
            planItemId: revision.plan_item_id,
            actualPlanSlug: provenance.planSlug,
            actualPlanItemIds: provenance.itemIds,
            message:
              `work item ${input.workItemId} is not promoted from ${planSlug} plan item ${revision.plan_item_id}; ` +
              `its provenance resolves to ${provenance.planSlug ?? 'no plan'} ` +
              `[${provenance.itemIds.join(', ') || 'no plan items'}] and has no existing behavior-contract edge to this clause.`,
          };
        }
      }
    }

    if (input.coverageEvidenceRef != null) {
      const rows = await tx<{ id: number }[]>`
        SELECT e.id
          FROM harness_shared.coverage_evidence e
          JOIN harness_shared.testing_surfaces s ON s.id = e.surface_ref
         WHERE e.id = ${input.coverageEvidenceRef}
           AND s.workspace_id = ${scope.workspaceId}
           AND s.harness_slug = ${scope.harnessSlug}`;
      if (!rows[0]) {
        return { status: 'coverage_evidence_not_found', coverageEvidenceRef: input.coverageEvidenceRef };
      }
    }
    // EI-25847620673275477: an independent-verification row re-observes the SAME proof the
    // implementer bound. When that proof is a recorded test execution, its environment
    // fingerprint was derived from THAT run's receipts, so a re-observation that omits the
    // run could never match it (independent_fingerprint_mismatch [environment]). Adopt the
    // cited binding's run when the caller names none; its plane and run identity are copied
    // onto the row below so the read side certifies the same execution.
    let citedProof: { test_run_id: string | number | null; details: Record<string, unknown> | null } | undefined;
    if (input.evidenceKind === 'independent-verification' && input.verifiesBindingId != null) {
      [citedProof] = await tx<{ test_run_id: string | number | null; details: Record<string, unknown> | null }[]>`
        SELECT test_run_id, details
          FROM harness_shared.spec_evidence_bindings
         WHERE id = ${input.verifiesBindingId}
           AND workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}
           AND plan_slug = ${planSlug}
           AND spec_id = ${identity.spec_id}
           AND retracted_at IS NULL
           AND evidence_kind <> 'independent-verification'`;
      if (citedProof?.test_run_id != null && input.testRunId == null) {
        input = { ...input, testRunId: Number(citedProof.test_run_id) };
      }
    }
    const citedTestRunId = citedProof?.test_run_id != null ? Number(citedProof.test_run_id) : null;
    let executionRuntimeFingerprint: string | null = null;
    const runtimeRecipe = measurementFromDetails(input.details ?? {});
    const runtimeUnits = runtimeRecipe?.runtimeUnits;
    let canonicalizedTestCases: string[] | undefined;
    if (input.testRunId != null) {
      const rows = await tx<{ id: number; status: string | null; source: string | null; execution_details?: unknown }[]>`
        SELECT id, status, source, execution_details FROM harness_shared.test_runs
         WHERE id = ${input.testRunId}
           AND workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}`;
      if (!rows[0]) {
        // Re-probe by id ALONE before reporting absence. The scoped miss above
        // cannot tell a fabricated id from a real row in another tenancy, and the
        // most common cause here is the latter: harness_slug is env-stamped, so a
        // run started without a harness lands NULL and can never match.
        const unscoped = await tx<{ harness_slug: string | null; workspace_id: string | null }[]>`
          SELECT harness_slug, workspace_id FROM harness_shared.test_runs
           WHERE id = ${input.testRunId}`;
        const found = unscoped[0];
        if (!found) return { status: 'test_run_not_found', testRunId: input.testRunId };
        return {
          status: 'test_run_not_found',
          testRunId: input.testRunId,
          scopeMismatch: {
            foundOutsideScope: true,
            rowHarnessSlug: found.harness_slug,
            rowWorkspaceId: found.workspace_id,
            expectedHarnessSlug: scope.harnessSlug,
            expectedWorkspaceId: scope.workspaceId,
            hint:
              found.harness_slug === null
                ? `test-run ${input.testRunId} EXISTS but its harness_slug is NULL, so it can never match this harness-scoped lookup. harness_slug is stamped from the runner's environment: re-run the test with the harness supplied (for example testing:run { harness: '${scope.harnessSlug}', files: [...] }, or PAPERCUSP_TEST_RUN_HARNESS=${scope.harnessSlug} for a shell runner) and bind the NEW run id. The id you passed is real — it is simply unbindable.`
                : `test-run ${input.testRunId} EXISTS but belongs to harness '${found.harness_slug}' (workspace '${found.workspace_id ?? 'null'}'), not '${scope.harnessSlug}'. Bind a run recorded under this harness, or bind against the owning harness.`,
          },
        };
      }
      const parsedRunExecution = parseTestRunExecutionDetails(rows[0].execution_details);
      const passedCaseTitles = parsedRunExecution?.passedCaseTitles;
      const rawAdequacy = input.details?.adequacy;
      const rawTestCases =
        rawAdequacy !== null && typeof rawAdequacy === 'object' && !Array.isArray(rawAdequacy)
          ? (rawAdequacy as Record<string, unknown>).testCases
          : undefined;
      const declaredTestCases = Array.isArray(rawTestCases)
        ? rawTestCases
            .filter((title): title is string => typeof title === 'string' && title.trim().length > 0)
            .map((title) => title.trim())
        : [];
      const mutationCases =
        (input.evidenceKind === 'mutation' || input.evidenceKind === 'counterexample') &&
        rows[0].source === 'mutation-probe' &&
        parsedRunExecution?.mutationPhase === 'mutant'
          ? mutationFailedCaseTitles(rows[0].execution_details)
          : undefined;
      const caughtCaseClaim = mutationCaughtCaseProseMismatch(input.details ?? {}, mutationCases);
      if (caughtCaseClaim) {
        return {
          status: 'mutation_caught_case_claim_mismatch',
          testRunId: input.testRunId,
          ...caughtCaseClaim,
          message: mutationCaughtCaseClaimMessage(input.testRunId, caughtCaseClaim),
        };
      }
      // A mutation binding claims a measured failing assertion, so its adequacy.testCases
      // must name the failed mutant's canonical case identities. The evaluator already uses
      // these same identities; checking only evidenceKind='test' here let a binder attach an
      // unrelated passing title and have it accepted as mutation evidence.
      if (mutationCases !== undefined && declaredTestCases.length > 0) {
        const unmatched = declaredTestCases.filter(
          (testName) => !mutationCases.some((measuredTitle) => hasSameCaseTitleIdentity(testName, measuredTitle)),
        );
        if (unmatched.length > 0) {
          const nearMatches = unmatched.flatMap((declaredTitle) =>
            mutationCases.flatMap((measuredTitle) => {
              const separator = measuredTitle.lastIndexOf(' > ');
              return separator >= 0 && measuredTitle.slice(separator + 3) === declaredTitle
                ? [{ declaredTitle, measuredTitle }]
                : [];
            }),
          );
          const nearMatchHint = nearMatches.length > 0
            ? `Near match: ${nearMatches
                .slice(0, MAX_CASE_TITLES_IN_ERROR_MESSAGE)
                .map(({ declaredTitle, measuredTitle }) =>
                  `${quoteBoundedCaseTitle(declaredTitle)} is the final " > " segment of measured title ${quoteBoundedCaseTitle(measuredTitle)}`,
                )
                .join('; ')}${nearMatches.length > MAX_CASE_TITLES_IN_ERROR_MESSAGE
                ? `; ${nearMatches.length - MAX_CASE_TITLES_IN_ERROR_MESSAGE} more near matches omitted`
                : ''}. Use the full measured title.`
            : '';
          return {
            status: 'test_cases_not_in_run',
            testRunId: input.testRunId,
            declaredCaseCount: declaredTestCases.length,
            failedCaseTitleCount: mutationCases.length,
            source: 'mutation-failed-case-titles',
            unmatchedTestCases: unmatched,
            message:
              unmatched.length + ' of ' + declaredTestCases.length +
              ' declared details.adequacy.testCases entries matched no exact measured failed case. Mutation test-run ' +
              input.testRunId + ' measured failedCaseTitles: ' + formatBoundedCaseTitleList(mutationCases) +
              '. Unmatched declared titles: ' + formatBoundedCaseTitleList(unmatched) + '. ' +
              (nearMatchHint ? nearMatchHint + ' ' : '') +
              'A mutation binding must name a measured failing case; correct the title or bind a run that failed it.',
          };
        }
      }
      // P-002 / R-2: when the per-case ledger (migration 1478) recorded this run's cases,
      // EVERY declared case must resolve to an executed recorded case through the shared
      // resolver. Accepted suffixes are rewritten to their unique measured full title so
      // later falsifiability checks compare the same case identity. The capped passedCaseTitles
      // fallback below remains non-authoritative whenever the list is incomplete.
      let judgedByCaseLedger = false;
      if (input.evidenceKind === 'test' && declaredTestCases.length > 0) {
        const recordedCases = await readRecordedTestCases(tx, input.testRunId);
        if (recordedCases !== null) {
          judgedByCaseLedger = true;
          const resolved = declaredTestCases.map((testName) => {
            const filter = resolveTestCaseFilter({ file: recordedCases.file, testName }, recordedCases.cases);
            return {
              testName,
              filter,
              canonical: filter.ok
                ? uniqueMeasuredCaseTitle(testName, filter.matched.map((testCase) => testCase.caseKey))
                : { status: 'unmatched' as const },
            };
          });
          const unmatched = resolved.filter(({ filter }) => !filter.ok).map(({ testName }) => testName);
          if (unmatched.length > 0) {
            return {
              status: 'test_cases_not_in_run',
              testRunId: input.testRunId,
              declaredCaseCount: declaredTestCases.length,
              passedCaseTitleCount: recordedCases.cases.filter((c) => c.status === 'pass').length,
              source: 'case-ledger',
              unmatchedTestCases: unmatched,
              message:
                unmatched.length + ' of ' + declaredTestCases.length +
                ' declared details.adequacy.testCases entries matched no executed case among the ' +
                recordedCases.cases.length + ' recorded cases of test-run ' + input.testRunId + ' (' +
                unmatched.map((t) => JSON.stringify(t)).join(', ') + '). A declared case that matches ' +
                'nothing is refused rather than counted; correct the label (full describe/it path, or a ' +
                "suffix at a ' > ' boundary) or bind a run that executed it.",
            };
          }
          const ambiguousTestCases = resolved.flatMap(({ testName, canonical }) =>
            canonical.status === 'ambiguous'
              ? [{ testCase: testName, matchingCaseTitles: canonical.matchingCaseTitles.slice(0, 5) }]
              : [],
          );
          if (ambiguousTestCases.length > 0) {
            return {
              status: 'test_cases_ambiguous_in_run',
              testRunId: input.testRunId,
              declaredCaseCount: declaredTestCases.length,
              source: 'case-ledger',
              ambiguousTestCases,
              message: ambiguousCaseTitlesMessage(input.testRunId, 'the case ledger', ambiguousTestCases),
            };
          }
          canonicalizedTestCases = resolved.map(({ testName, canonical }) =>
            canonical.status === 'unique' ? canonical.title : testName,
          );
        }
      }
      if (
        !judgedByCaseLedger &&
        input.evidenceKind === 'test' &&
        declaredTestCases.length > 0 &&
        rows[0].status === 'pass' &&
        parsedRunExecution !== undefined &&
        parsedRunExecution.testLayer !== 'llm' &&
        parsedRunExecution.collectionFailed === false &&
        parsedRunExecution.failed === 0 &&
        parsedRunExecution.skipped === 0 &&
        parsedRunExecution.passed > 0 &&
        passedCaseTitles !== undefined &&
        passedCaseTitles.length === parsedRunExecution.passed &&
        !passedCaseTitlesIncomplete(parsedRunExecution)
      ) {
        const resolved = declaredTestCases.map((testName) => {
          const matchingCaseTitles = passedCaseTitles.filter((title) =>
            hasMatchingDeclaredCaseTitle(testName, [title]),
          );
          return {
            testName,
            matchingCaseTitles,
            canonical: uniqueMeasuredCaseTitle(testName, matchingCaseTitles),
          };
        });
        const unmatched = resolved
          .filter(({ canonical }) => canonical.status === 'unmatched')
          .map(({ testName }) => testName);
        if (unmatched.length > 0) {
          return {
            status: 'test_cases_not_in_run',
            testRunId: input.testRunId,
            declaredCaseCount: declaredTestCases.length,
            passedCaseTitleCount: passedCaseTitles.length,
            source: 'passed-case-titles',
            unmatchedTestCases: unmatched,
            message:
              unmatched.length + ' of ' + declaredTestCases.length +
              ' declared details.adequacy.testCases entries matched no recorded passed case among the ' +
              passedCaseTitles.length + ' complete passedCaseTitles in test-run ' + input.testRunId +
              ' (' + unmatched.map((title) => JSON.stringify(title)).join(', ') +
              '). Bind a run that executed each claimed case or correct the case labels.',
          };
        }
        const ambiguousTestCases = resolved.flatMap(({ testName, canonical }) =>
          canonical.status === 'ambiguous'
            ? [{ testCase: testName, matchingCaseTitles: canonical.matchingCaseTitles.slice(0, 5) }]
            : [],
        );
        if (ambiguousTestCases.length > 0) {
          return {
            status: 'test_cases_ambiguous_in_run',
            testRunId: input.testRunId,
            declaredCaseCount: declaredTestCases.length,
            source: 'passed-case-titles',
            ambiguousTestCases,
            message: ambiguousCaseTitlesMessage(input.testRunId, 'the complete passed-case title list', ambiguousTestCases),
          };
        }
        canonicalizedTestCases = resolved.map(({ testName, canonical }) =>
          canonical.status === 'unique' ? canonical.title : testName,
        );
      }
      if (runtimeUnits) {
        const execution = parsedRunExecution;
        const witness = stableRecordedRuntimeEnvironment(
          execution?.runtimeEnvironmentBefore, execution?.runtimeEnvironmentAfter);
        if (witness && JSON.stringify([...witness.units].sort()) === JSON.stringify([...runtimeUnits].sort())) {
          executionRuntimeFingerprint = witness.fingerprint;
        }
        if ((execution?.testLayer === 'integration' || execution?.testLayer === 'e2e') && execution.isolatedRuntimeReceipts
          && JSON.stringify(runtimeUnits.slice().sort()) === JSON.stringify(execution.isolatedRuntimeReceipts
            .map(receipt => `isolated-integration:${receipt.runId}`).sort())) {
          executionRuntimeFingerprint = isolatedIntegrationFingerprint(execution.isolatedRuntimeReceipts);
        }
      }
    }

    if (input.testRunId != null && runtimeRecipe?.kind === 'repo-files'
      && runtimeRecipe.completedRuntime?.kind === 'isolated-integration') {
      const gaps = await isolatedIntegrationSourceReceiptGaps(runtimeRecipe);
      if (gaps.length > 0) {
        const rendered = gaps
          .map(({ runId, missingSourcePaths }) => `${runId}: ${missingSourcePaths.join(', ')}`)
          .join('; ');
        return {
          status: 'completed_runtime_source_not_in_receipt',
          gaps,
          message:
            'Cannot bind isolated-integration evidence because its retained source receipt does not cover ' +
            `every declared source path (${rendered}). Re-run the integration with a complete source receipt ` +
            'or correct the measurement.sourcePaths before binding.',
        };
      }
    }

    const evidenceRef = input.evidenceRef.trim();
    let sourceFingerprint = input.sourceFingerprint.trim();
    let testFingerprint = nullableTrimmed(input.testFingerprint);
    let fixtureFingerprint = nullableTrimmed(input.fixtureFingerprint);
    let rubricFingerprint = nullableTrimmed(input.rubricFingerprint);
    // Test runs must retain their execution-time witness. A manual live probe has
    // no test run; keep the server-measured runtime of that observation instead.
    let environmentFingerprint = runtimeUnits && input.testRunId != null
      ? executionRuntimeFingerprint : nullableTrimmed(input.environmentFingerprint);
    const priorTestRunBinding = input.testRunId == null
      ? undefined
      : (
          await tx<PriorTestRunBindingRow[]>`
        SELECT spec_revision, source_fingerprint, test_fingerprint, fixture_fingerprint,
               rubric_fingerprint, environment_fingerprint, details
          FROM harness_shared.spec_evidence_bindings
         WHERE workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}
           AND work_item_id = ${input.workItemId}
           AND plan_slug = ${planSlug}
           AND spec_id = ${identity.spec_id}
           AND evidence_kind = ${input.evidenceKind}
           AND evidence_ref = ${evidenceRef}
           AND coverage_evidence_ref IS NOT DISTINCT FROM ${input.coverageEvidenceRef ?? null}
           AND test_run_id = ${input.testRunId}
           AND retracted_at IS NULL
         ORDER BY created_at ASC, id ASC
         LIMIT 1`
        )[0];
    // A replay that omits details is a partial update of an existing logical
    // binding, not a request to replace executable proof metadata with `{}`.
    // Explicit details (including `{}`) remain authoritative and retain the
    // append-only changed-proof behavior of binding_fingerprint.
    const priorDetails =
      input.details === undefined
        ? (
            await tx<{ details: Record<string, unknown> }[]>`
          SELECT details
            FROM harness_shared.spec_evidence_bindings
           WHERE workspace_id = ${scope.workspaceId}
             AND harness_slug = ${scope.harnessSlug}
             AND work_item_id = ${input.workItemId}
             AND plan_slug = ${planSlug}
             AND spec_id = ${identity.spec_id}
             AND spec_revision = ${specRevision}
             AND spec_fingerprint = ${revision.content_hash}
             AND evidence_kind = ${input.evidenceKind}
             AND evidence_ref = ${evidenceRef}
             AND source_fingerprint = ${sourceFingerprint}
             AND test_fingerprint IS NOT DISTINCT FROM ${testFingerprint}
             AND fixture_fingerprint IS NOT DISTINCT FROM ${fixtureFingerprint}
             AND rubric_fingerprint IS NOT DISTINCT FROM ${rubricFingerprint}
             AND environment_fingerprint IS NOT DISTINCT FROM ${environmentFingerprint}
             AND coverage_evidence_ref IS NOT DISTINCT FROM ${input.coverageEvidenceRef ?? null}
             AND test_run_id IS NOT DISTINCT FROM ${input.testRunId ?? null}
           ORDER BY observed_at DESC, id DESC
           LIMIT 1`
          )[0]?.details
        : undefined;

    let details = (input.details ?? priorDetails ?? priorTestRunBinding?.details ?? {}) as Record<string, unknown>;
    if (canonicalizedTestCases !== undefined) {
      const rawAdequacy = details.adequacy;
      if (rawAdequacy !== null && typeof rawAdequacy === 'object' && !Array.isArray(rawAdequacy)) {
        details = {
          ...details,
          adequacy: { ...(rawAdequacy as Record<string, unknown>), testCases: canonicalizedTestCases },
        };
      }
    }
    if (priorTestRunBinding) {
      const previousMeasurement = measurementFromDetails(priorTestRunBinding.details);
      const currentMeasurement = measurementFromDetails(details);
      if (previousMeasurement || currentMeasurement) {
        if (!previousMeasurement || !currentMeasurement) {
          return {
            status: 'test_run_measurement_recipe_unverified',
            testRunId: input.testRunId!,
            previousSpecRevision: Number(priorTestRunBinding.spec_revision),
            specRevision,
            message:
              `Cannot safely rebind test-run ${input.testRunId} at spec revision ${specRevision}: ` +
              `the earliest live binding at revision ${priorTestRunBinding.spec_revision} has no matching ` +
              'verifiable currentMeasurement recipe. Re-run the test or use its original recipe.',
          };
        }
        const previousRecipe = JSON.stringify(canonicalJson(previousMeasurement));
        const currentRecipe = JSON.stringify(canonicalJson(currentMeasurement));
        if (previousRecipe !== currentRecipe) {
          return {
            status: 'test_run_measurement_recipe_changed',
            testRunId: input.testRunId!,
            previousSpecRevision: Number(priorTestRunBinding.spec_revision),
            specRevision,
            message:
              `Cannot safely rebind test-run ${input.testRunId} at spec revision ${specRevision}: ` +
              `the measurement recipe differs from its earliest live binding at revision ` +
              `${priorTestRunBinding.spec_revision}. Re-run the test with the new recipe.`,
          };
        }

        // The same recorded execution must keep the state measured for that execution.
        // Re-measuring at bind time would let a later spec revision reset the source pin
        // and turn old, source-stale test evidence into source-current evidence.
        sourceFingerprint = priorTestRunBinding.source_fingerprint;
        testFingerprint = priorTestRunBinding.test_fingerprint;
        fixtureFingerprint = priorTestRunBinding.fixture_fingerprint;
        rubricFingerprint = priorTestRunBinding.rubric_fingerprint;
        environmentFingerprint = priorTestRunBinding.environment_fingerprint;
        details = { ...details, currentMeasurement: previousMeasurement };
        const previousPin = readMeasurementPin(priorTestRunBinding.details);
        if (previousPin) details[MEASUREMENT_PIN_DETAILS_KEY] = previousPin;
        else delete details[MEASUREMENT_PIN_DETAILS_KEY];
      }
    }

    // EI-25847620673275477: a re-observation of the cited run carries that run's plane and
    // identity, which completed-runtime certification requires to read environment=current.
    if (citedTestRunId != null && input.testRunId === citedTestRunId) {
      const cited = citedProof?.details ?? {};
      if (details.evidencePlane === undefined && cited.evidencePlane !== undefined) {
        details = { ...details, evidencePlane: cited.evidencePlane };
      }
      if (details.testRun === undefined && cited.testRun !== undefined) {
        details = { ...details, testRun: cited.testRun };
      }
    }

    // EI-27081440896857039: completed-runtime recipes are exempt — their environment is
    // certified from the completed runtime at read time, not from a bind-time witness.
    const environmentUnproven = testRunEnvironmentUnprovenWarning({
      testRunId: input.testRunId,
      runtimeUnits,
      completedRuntime: Boolean(runtimeRecipe?.kind === 'repo-files' && runtimeRecipe.completedRuntime),
      environmentFingerprint,
      details,
    });

    // P-008 (D-005): an independent-verification row is a non-implementer re-observing the
    // SAME thing the implementer bound. It must cite a live, non-independent binding on the
    // same clause, and both fingerprints must match that row exactly — a re-observation of a
    // different source tree or a different environment verifies nothing about the cited proof.
    const verifiesBindingId = input.verifiesBindingId ?? null;
    if (input.evidenceKind === 'independent-verification' && verifiesBindingId == null) {
      return {
        status: 'verified_binding_required',
        message: "evidenceKind 'independent-verification' requires verifiesBindingId: the implementer binding it re-observed.",
      };
    }
    if (input.evidenceKind !== 'independent-verification' && verifiesBindingId != null) {
      return {
        status: 'verified_binding_not_allowed',
        message: "verifiesBindingId is only valid with evidenceKind 'independent-verification'.",
      };
    }
    if (verifiesBindingId != null) {
      const cited = (
        await tx<{
          source_fingerprint: string;
          environment_fingerprint: string | null;
          created_by: string | null;
          evidence_kind: string;
          spec_revision: number | string;
          spec_fingerprint: string;
          test_run_id: number | string | null;
          test_fingerprint: string | null;
          fixture_fingerprint: string | null;
          rubric_fingerprint: string | null;
          details: Record<string, unknown> | null;
        }[]>`
          SELECT source_fingerprint, environment_fingerprint, created_by, evidence_kind,
                 spec_revision, spec_fingerprint, test_run_id, test_fingerprint,
                 fixture_fingerprint, rubric_fingerprint, details
            FROM harness_shared.spec_evidence_bindings
           WHERE id = ${verifiesBindingId}
             AND workspace_id = ${scope.workspaceId}
             AND harness_slug = ${scope.harnessSlug}
             AND plan_slug = ${planSlug}
             AND spec_id = ${identity.spec_id}
             AND retracted_at IS NULL
             AND evidence_kind <> 'independent-verification'`
      )[0];
      if (!cited) {
        return {
          status: 'verified_binding_not_found',
          verifiesBindingId,
          message:
            `verifiesBindingId ${verifiesBindingId} is not a live, non-independent binding on clause ` +
            `${identity.spec_id} of ${planSlug}. Cite the implementer binding you re-observed.`,
        };
      }
      const mismatched: Array<'source' | 'environment'> = [];
      if (cited.source_fingerprint !== sourceFingerprint) mismatched.push('source');
      if ((cited.environment_fingerprint ?? null) !== (environmentFingerprint ?? null)) mismatched.push('environment');
      if (mismatched.length > 0) {
        return {
          status: 'independent_fingerprint_mismatch',
          verifiesBindingId,
          mismatched,
          message:
            `independent-verification refused: ${mismatched.join(' and ')} fingerprint differs from cited binding ` +
            `${verifiesBindingId}. Re-observe the same source and environment the implementer bound, or re-bind ` +
            'the implementer proof first.' +
            (mismatched.includes('environment') && citedTestRunId != null && input.testRunId !== citedTestRunId
              ? ` The cited binding is backed by test-run ${citedTestRunId}; omit testRunId (it is adopted) or ` +
                `pass ${citedTestRunId}, so the environment is derived from that same execution.`
              : ''),
          ...(citedTestRunId != null ? { citedTestRunId } : {}),
        };
      }
      // WI-6554700010018061: a review claiming fixture absence is useful ONLY if the evaluator
      // pairs it with the cited proof. Apply the evaluator's own pairing rule here, so a review
      // it would skip is refused with every disqualifying key instead of binding 'created' and
      // silently never counting. Scoped to the fixture-free claim: a live-bar re-observation
      // (plans:bind-independent-verification) legitimately differs on these keys.
      const { claimsFixtureAbsence, fixtureAbsencePairingMismatches } = await import('./spec-test-adequacy');
      if (claimsFixtureAbsence(details)) {
        const citedRevision = Number(cited.spec_revision);
        const citedRun = cited.test_run_id == null ? null : Number(cited.test_run_id);
        const pairingMismatches = fixtureAbsencePairingMismatches(
          {
            evidenceKind: cited.evidence_kind as SpecEvidenceKind,
            createdBy: cited.created_by ?? undefined,
            planSlug,
            specId: identity.spec_id,
            specRevision: citedRevision,
            specFingerprint: cited.spec_fingerprint,
            testRunId: citedRun,
            fingerprints: {
              sourceFingerprint: cited.source_fingerprint,
              testFingerprint: cited.test_fingerprint,
              fixtureFingerprint: cited.fixture_fingerprint,
              rubricFingerprint: cited.rubric_fingerprint,
              environmentFingerprint: cited.environment_fingerprint ?? null,
            },
            details: cited.details ?? {},
          },
          {
            evidenceKind: 'independent-verification',
            createdBy: input.actorId,
            planSlug,
            specId: identity.spec_id,
            specRevision,
            specFingerprint: revision.content_hash,
            testRunId: input.testRunId ?? null,
            fingerprints: {
              sourceFingerprint,
              testFingerprint,
              fixtureFingerprint,
              rubricFingerprint,
              environmentFingerprint: environmentFingerprint ?? null,
            },
            details,
          },
        );
        if (pairingMismatches.length > 0) {
          return {
            status: 'fixture_absence_pairing_mismatch',
            verifiesBindingId,
            mismatched: pairingMismatches,
            message:
              `independent-verification refused: details.adequacy.fixtureFree=true claims fixture absence, but ` +
              `fixture-absence certification would never pair this review with cited binding ${verifiesBindingId} ` +
              `(mismatched: ${pairingMismatches.join(', ')}). Re-observe exactly the cited proof: spec revision ` +
              `${citedRevision}, test run ${citedRun ?? '(none — the cited proof must be a recorded run)'}, its ` +
              'test fingerprint, every one of its details.adequacy.testCases, and an author other than the ' +
              "cited binding's. If this review does not certify fixture absence, omit details.adequacy.fixtureFree.",
          };
        }
      }
    }

    const canonical: CanonicalBinding = {
      ...(verifiesBindingId != null ? { verifiesBindingId } : {}),
      workspaceId: scope.workspaceId,
      harnessSlug: scope.harnessSlug,
      workItemId: input.workItemId,
      planSlug: planSlug,
      specId: identity.spec_id,
      specRevision,
      specFingerprint: revision.content_hash,
      evidenceKind: input.evidenceKind,
      evidenceRef,
      sourceFingerprint,
      testFingerprint,
      fixtureFingerprint,
      rubricFingerprint,
      environmentFingerprint,
      coverageEvidenceRef: input.coverageEvidenceRef ?? null,
      testRunId: input.testRunId ?? null,
      details: (canonicalJson(details) ?? {}) as Record<string, unknown>,
    };
    const bindingFingerprint = specEvidenceBindingFingerprint(canonical);

    await tx`
      INSERT INTO harness_shared.work_item_spec_revision_edges (
        workspace_id, harness_slug, work_item_id, plan_slug, spec_id,
        spec_revision, spec_fingerprint, created_by
      ) VALUES (
        ${scope.workspaceId}, ${scope.harnessSlug}, ${input.workItemId}, ${planSlug},
        ${identity.spec_id}, ${specRevision}, ${revision.content_hash}, ${input.actorId}
      ) ON CONFLICT DO NOTHING`;

    const observedAt = input.observedAt ? new Date(input.observedAt) : new Date();
    const inserted = await tx<{ id: number }[]>`
      INSERT INTO harness_shared.spec_evidence_bindings (
        workspace_id, harness_slug, work_item_id, plan_slug, spec_id,
        spec_revision, spec_fingerprint, evidence_kind, evidence_ref,
        source_fingerprint, test_fingerprint, fixture_fingerprint,
        rubric_fingerprint, environment_fingerprint, coverage_evidence_ref,
        test_run_id, details, observed_at, binding_fingerprint, created_by,
        verifies_binding_id
      ) VALUES (
        ${scope.workspaceId}, ${scope.harnessSlug}, ${input.workItemId}, ${planSlug},
        ${identity.spec_id}, ${specRevision}, ${revision.content_hash}, ${input.evidenceKind},
        ${canonical.evidenceRef}, ${canonical.sourceFingerprint}, ${canonical.testFingerprint},
        ${canonical.fixtureFingerprint}, ${canonical.rubricFingerprint},
        ${canonical.environmentFingerprint}, ${canonical.coverageEvidenceRef},
        ${canonical.testRunId}, ${JSON.stringify(canonical.details)}::text::jsonb,
        ${observedAt}, ${bindingFingerprint}, ${input.actorId},
        ${verifiesBindingId}
      ) ON CONFLICT (
        workspace_id, harness_slug, work_item_id,
        plan_slug, spec_id, spec_revision, binding_fingerprint
      ) WHERE retracted_at IS NULL DO NOTHING
      RETURNING id`;

    const existing =
      inserted[0] ??
      (
        await tx<{ id: number }[]>`
      SELECT id FROM harness_shared.spec_evidence_bindings
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND work_item_id = ${input.workItemId}
         AND plan_slug = ${planSlug}
         AND spec_id = ${identity.spec_id}
         AND spec_revision = ${specRevision}
         AND binding_fingerprint = ${bindingFingerprint}
         AND retracted_at IS NULL`
      )[0];
    // The retraction filter is load-bearing, not defensive. This lookup only runs when the
    // INSERT above conflicted, and it reports the row the caller is told it now has bound.
    // Returning a RETRACTED row here would answer 'unchanged' while every reader excludes
    // that row by default — silent success with zero live evidence, which is precisely the
    // failure D-011's repair path exists to remove. Migration 1175 scopes the dedup index to
    // live rows so a retracted binding no longer blocks its replacement's insert; with both
    // halves in place a conflict can only mean a LIVE duplicate, and this lookup finds it.
    // If it does not, throwing is correct: a loud failure beats a wrong id.
    if (!existing) throw new Error(`spec_evidence_binding_insert_failed:${bindingFingerprint}`);

    const duplicateLiveTestRunBindingIds = inserted[0] && canonical.testRunId != null
      ? (
          await tx<{ id: number }[]>`
        SELECT id
          FROM harness_shared.spec_evidence_bindings
         WHERE workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}
           AND work_item_id = ${input.workItemId}
           AND plan_slug = ${planSlug}
           AND spec_id = ${identity.spec_id}
           AND spec_revision = ${specRevision}
           AND evidence_kind = ${input.evidenceKind}
           AND evidence_ref = ${evidenceRef}
           AND coverage_evidence_ref IS NOT DISTINCT FROM ${input.coverageEvidenceRef ?? null}
           AND test_run_id = ${canonical.testRunId}
           AND retracted_at IS NULL
           AND id <> ${existing.id}
         ORDER BY id ASC`
        ).map((row) => Number(row.id))
      : [];
    const duplicateLiveTestRunAdvisory = duplicateLiveTestRunBindingIds.length > 0
      ? {
          code: 'duplicate_live_test_run_bindings' as const,
          testRunId: canonical.testRunId!,
          bindingIds: duplicateLiveTestRunBindingIds,
          message:
            `Test run ${canonical.testRunId} is already live in binding(s) ${duplicateLiveTestRunBindingIds.join(', ')} ` +
            `for ${input.evidenceKind} evidence '${evidenceRef}' on ${identity.spec_id}@${specRevision}. ` +
            'This new binding remains live as well. If it replaces the earlier proof, re-bind with ' +
            'supersedeAtRevision:true; otherwise retract the stale binding(s) with ' +
            'plans:bind-spec-evidence retract.',
        }
      : undefined;

    return {
      status: inserted[0] ? 'created' : 'unchanged',
      id: Number(existing.id),
      workItemId: input.workItemId,
      planSlug: planSlug,
      specId: identity.spec_id,
      sourceValId: identity.source_val_id,
      specRevision,
      specFingerprint: revision.content_hash,
      bindingFingerprint,
      ...(duplicateLiveTestRunAdvisory ? { advisory: duplicateLiveTestRunAdvisory } : {}),
      ...(environmentUnproven ? { environmentUnproven } : {}),
    };
  });
  // Pin explicitly retained bytes before accepting a receipt binding. The
  // standing cleaner renews this same finite lease while the item stays open.
  if (/^docs\/evidence\/.+\.json$/.test(input.evidenceRef)) {
    const repository = await resolveMeasurementRoot(scope.workspaceId, scope.harnessSlug);
    if (existsSync(resolve(repository, input.evidenceRef))) {
      const { withWorkItemEvidenceRetention } = await import('../../storage/retention-pins');
      return withWorkItemEvidenceRetention({ harness_slug: scope.harnessSlug, work_item_id: input.workItemId,
        evidence_ref: input.evidenceRef }, { repositories: new Map([[scope.harnessSlug, repository]]) }, writeBinding);
    }
  }
  return writeBinding();
}

export type FingerprintState = 'current' | 'stale' | 'unknown' | 'not-applicable';
export interface EvidenceCurrentInputIdentity {
  planSlug?: string;
  specId?: string;
  specRevision?: number;
  specFingerprint?: string;
}

export interface EvidenceCurrentInput extends EvidenceFingerprints {
  planSlug?: string;
  specId?: string;
  specRevision?: number;
  specFingerprint?: string;
  evidenceKind: SpecEvidenceKind;
  evidenceRef: string;
}

/**
 * Key a currentness tuple by exact clause identity when available. Historical
 * callers only supplied evidenceKind/evidenceRef, so those tuples retain a
 * separate legacy key and are consulted only as a fallback.
 */
export function evidenceCurrentInputKey(input: EvidenceCurrentInputIdentity & {
  evidenceKind: string;
  evidenceRef: string;
}): string {
  const scoped =
    input.planSlug !== undefined &&
    input.specId !== undefined &&
    input.specRevision !== undefined &&
    input.specFingerprint !== undefined;
  return JSON.stringify(
    scoped
      ? [
          'scoped',
          input.planSlug,
          input.specId,
          input.specRevision,
          input.specFingerprint,
          input.evidenceKind,
          input.evidenceRef,
        ]
      : ['legacy', input.evidenceKind, input.evidenceRef],
  );
}

/**
 * Provenance of the comparison used to classify a binding. Public tool inputs are
 * necessarily caller-attested: the caller supplies both fingerprints and the
 * comparison request. Only an internal server-measured path may establish a fresh
 * verdict.
 */
export type EvidenceCurrentnessProvenance =
  | 'server-measured'
  | 'partially-server-measured'
  | 'attested-current'
  | 'replayed-snapshot'
  | 'historical-snapshot'
  | 'not-supplied';

type OpaqueFingerprintDimension = 'fixture' | 'rubric' | 'environment';

/** Trust metadata for the current-fingerprint tuple used by the classifier. */
interface CurrentnessClassificationOptions {
  provenance?: 'server-measured' | 'partially-server-measured' | 'replayed-snapshot' | 'historical-snapshot';
  /** Applicable non-repository dimensions supplied by the caller beside server measurements. */
  attestedDimensions?: OpaqueFingerprintDimension[];
  /** Internal independent certification only; never admitted through current-input schemas. */
  sourceEquivalence?: StaticGuidanceSourceEquivalence;
  /**
   * P-011: the bar this evidence proves declares `verification.productionConfiguration`.
   * `declaredFingerprint` is that declaration's fingerprint; `unresolved` means the bar's
   * declaration could not be read, which is never treated as "declares nothing".
   */
  declaredConfiguration?: { declaredFingerprint: string } | { unresolved: string };
}

/** The bind-time stamp `plans:bind-spec-evidence` writes on a configuration-checked binding. */
function declaredConfigurationStampOf(
  details: Record<string, unknown> | undefined,
): { declaredFingerprint: string; fingerprint: string } | null {
  const stamp = details?.declaredConfiguration;
  if (!stamp || typeof stamp !== 'object' || Array.isArray(stamp)) return null;
  const { required, declaredFingerprint, fingerprint } = stamp as Record<string, unknown>;
  if (required !== true || typeof declaredFingerprint !== 'string' || typeof fingerprint !== 'string') return null;
  return { declaredFingerprint, fingerprint };
}

/**
 * SPEC-P-011-NULL-FINGERPRINT: evidence without a declared-configuration fingerprint never
 * counts as current for a bar that declares a production configuration. Only a binding the
 * bind door checked and stamped, under the declaration the bar still makes, is current.
 */
function declaredConfigurationState(
  row: CurrentnessRow,
  declared: NonNullable<CurrentnessClassificationOptions['declaredConfiguration']>,
): FingerprintState {
  if ('unresolved' in declared) return 'unknown';
  const stamp = declaredConfigurationStampOf(row.details);
  if (!stamp || stamp.fingerprint !== stamp.declaredFingerprint) return 'unknown';
  return stamp.declaredFingerprint === declared.declaredFingerprint ? 'current' : 'stale';
}

type DeclaredConfigurationResolution = NonNullable<CurrentnessClassificationOptions['declaredConfiguration']>;

function declaredConfigurationPinKey(row: {
  source_rubric_slug?: string | null;
  source_rubric_revision?: number | null;
  source_bar_key?: string | null;
}): string | null {
  if (!row.source_rubric_slug || row.source_rubric_revision == null || !row.source_bar_key) return null;
  return `${row.source_rubric_slug}@${Number(row.source_rubric_revision)}:${row.source_bar_key}`;
}

/** Test seam: replace the pinned-rubric read the P-011 currentness check performs. */
export const declaredConfigurationReadSeam: {
  loadRubricCriteria?: (rubricSlug: string, revision: number) => Promise<
    Array<{ key: string; barKey?: string; productionConfiguration?: unknown }> | null
  >;
} = {};

/**
 * P-011: which pinned BARs declare a production configuration. One rubric read per distinct
 * (rubric, revision); a BAR whose rubric is gone declares nothing, while a read that throws
 * is `unresolved` so its evidence cannot read as current on an unknown declaration.
 */
export async function resolveDeclaredConfigurations(
  rows: ReadonlyArray<{ source_rubric_slug?: string | null; source_rubric_revision?: number | null; source_bar_key?: string | null }>,
): Promise<Map<string, DeclaredConfigurationResolution>> {
  const out = new Map<string, DeclaredConfigurationResolution>();
  const rubricReads = new Map<string, Promise<Array<{ key: string; barKey?: string; productionConfiguration?: unknown }> | null>>();
  const loadCriteria =
    declaredConfigurationReadSeam.loadRubricCriteria ??
    (async (slug: string, revision: number) => {
      const { getRubric } = await import('../../rubrics');
      return (await getRubric(slug, revision))?.criteria ?? null;
    });
  for (const row of rows) {
    const key = declaredConfigurationPinKey(row);
    if (!key || out.has(key)) continue;
    const rubricKey = `${row.source_rubric_slug}@${Number(row.source_rubric_revision)}`;
    if (!rubricReads.has(rubricKey)) {
      rubricReads.set(rubricKey, loadCriteria(row.source_rubric_slug!, Number(row.source_rubric_revision)));
    }
    try {
      const criteria = await rubricReads.get(rubricKey)!;
      const criterion = criteria?.find((c) => (c.barKey?.trim() || c.key) === row.source_bar_key);
      const declared = parseProductionConfiguration(criterion?.productionConfiguration);
      if (declared) out.set(key, { declaredFingerprint: declaredConfigurationFingerprint(declared) });
    } catch (error: unknown) {
      out.set(key, { unresolved: (error instanceof Error ? error.message : String(error)).slice(0, 160) });
    }
  }
  return out;
}

interface StaticGuidanceSourceEquivalence {
  kind: 'static-agent-tool-guidance';
  paths: string[];
  storedFingerprint: string;
  measuredFingerprint: string;
}

/**
 * A scorecard referenced as proof can still be a provisional working note.
 * Keep the source card's identity and stamp alongside the boolean flag so an
 * adequacy reader can audit the dependency without a second work-item lookup.
 */
export interface ProvisionalScorecardProof {
  issueId: string;
  stampedAt: string;
  violatableKeys: string[];
}

export interface EvidenceCurrentness {
  /** Raw fingerprints differ only at the listed independently certified inert metadata spans. */
  sourceEquivalence?: StaticGuidanceSourceEquivalence;
  overall: Exclude<FingerprintState, 'not-applicable'>;
  dimensions: {
    spec: Exclude<FingerprintState, 'unknown' | 'not-applicable'>;
    source: Exclude<FingerprintState, 'not-applicable'>;
    test: FingerprintState;
    fixture: FingerprintState;
    rubric: FingerprintState;
    environment: FingerprintState;
    coverageEvidence: FingerprintState;
    testRun: FingerprintState;
    /** P-011: present only when the bar declares a production configuration. */
    configuration?: FingerprintState;
  };
  staleReasons: string[];
  unknownReasons: string[];
  /**
   * Whether the CALLER actually supplied a current-fingerprint input for this row.
   *
   * WHY THIS EXISTS. `unknown` is produced by `compareFingerprint(stored, undefined)`,
   * i.e. by the caller not asking — not by anything uncertain about the evidence. A
   * reader that supplies no `current` therefore gets `unknown` on every row with a
   * stored fingerprint, and `source_fingerprint` is NOT NULL, so that is EVERY row.
   * Consumers which gate on uncertainty must distinguish "asked and got a gap" from
   * "never asked"; without this flag the two are indistinguishable and a gate reading
   * `unknown` as doubt becomes a constant refusal (WI-2146375).
   */
  comparisonSupplied: boolean;
  /**
   * Caller-supplied matching fingerprints are explicitly attested-current and are
   * capped at aggregate `unknown`; equality alone is not an independent measurement.
   */
  /** Optional only for legacy hand-built/internal fixtures; the classifier always emits it. */
  provenance?: EvidenceCurrentnessProvenance;
}

interface CurrentnessRow {
  spec_is_current: boolean;
  source_fingerprint: string;
  test_fingerprint: string | null;
  fixture_fingerprint: string | null;
  rubric_fingerprint: string | null;
  environment_fingerprint: string | null;
  coverage_evidence_ref: number | null;
  coverage_evidence_present: boolean;
  test_run_id: number | null;
  test_run_present: boolean;
  test_run_worktree_dirty?: boolean | null;
  evidence_kind?: SpecEvidenceKind;
  details?: Record<string, unknown>;
}

function compareFingerprint(stored: string | null, current: string | null | undefined): FingerprintState {
  if (stored === null) return 'not-applicable';
  if (current == null) return 'unknown';
  return stored === current ? 'current' : 'stale';
}

/** Read both supported metadata locations, preserving explicit root-plane precedence. */
export function readSpecEvidencePlane(details?: Record<string, unknown>): unknown {
  const nested = details?.adequacy;
  const adequacy = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : undefined;
  return details?.evidencePlane ?? details?.evidence_plane ?? details?.plane ??
    adequacy?.evidencePlane ?? adequacy?.evidence_plane ?? adequacy?.plane;
}

/** Pure, four-state currentness classifier; no drifting boolean is persisted. */
export function classifySpecEvidenceCurrentness(
  row: CurrentnessRow,
  current?: EvidenceCurrentInput,
  options: CurrentnessClassificationOptions = {},
): EvidenceCurrentness {
  const adequacy = row.details?.adequacy;
  const fixtureCalibrationAttested =
    adequacy !== null && typeof adequacy === 'object' && !Array.isArray(adequacy) &&
    (adequacy as Record<string, unknown>).fixtureCalibrated === true;
  const fixtureExpected = row.evidence_kind === 'fixture' || fixtureCalibrationAttested;
  const evidencePlane = readSpecEvidencePlane(row.details);
  const ledgerMeasurement = workItemsEvidenceMeasurementSchema.safeParse(row.details?.currentMeasurement);
  // A live ledger-state observation measures dispositions, not a serving process.
  // Only a valid ledger-only recipe can omit runtime identity; runtime-dependent
  // work-item measurements and every repository-backed live proof still require it.
  const ledgerOnly = ledgerMeasurement.success && ledgerMeasurement.data.runtimeUnits === undefined;
  const liveEnvironmentRequired =
    typeof evidencePlane === 'string' && ['live', 'deployed'].includes(evidencePlane.trim().toLowerCase()) &&
    !ledgerOnly;
  const environmentFingerprintMissing = liveEnvironmentRequired && row.environment_fingerprint === null;
  const dimensions: EvidenceCurrentness['dimensions'] = {
    spec: row.spec_is_current ? 'current' : 'stale',
    source: compareFingerprint(row.source_fingerprint, current?.sourceFingerprint) as 'current' | 'stale' | 'unknown',
    test: compareFingerprint(row.test_fingerprint, current?.testFingerprint),
    fixture:
      fixtureExpected && row.fixture_fingerprint === null
        ? 'unknown'
        : compareFingerprint(row.fixture_fingerprint, current?.fixtureFingerprint),
    rubric: compareFingerprint(row.rubric_fingerprint, current?.rubricFingerprint),
    // A live/deployed proof depends on the runtime it exercised. Missing that identity
    // is unknown, not proof that the environment dimension does not apply.
    environment: environmentFingerprintMissing
      ? 'unknown'
      : compareFingerprint(row.environment_fingerprint, current?.environmentFingerprint),
    coverageEvidence:
      row.coverage_evidence_ref === null ? 'not-applicable' : row.coverage_evidence_present ? 'current' : 'stale',
    // A durable testRunId proves that a ledger row exists; it does not prove that a
    // run against a dirty shared worktree executed the committed files now being
    // fingerprinted. The file-set measurement covers only declared paths, so a
    // dirty run remains unknown even when those declared hashes happen to match.
    testRun:
      row.test_run_id === null
        ? 'not-applicable'
        : !row.test_run_present
          ? 'stale'
          : row.test_run_worktree_dirty === false
            ? 'current'
            : 'unknown',
    // Additive only: a bar that declares nothing classifies exactly as before P-011.
    ...(options.declaredConfiguration
      ? { configuration: declaredConfigurationState(row, options.declaredConfiguration) }
      : {}),
  };
  const sourceEquivalence = options.provenance === 'server-measured' && options.sourceEquivalence
    && options.sourceEquivalence.storedFingerprint === row.source_fingerprint
    && options.sourceEquivalence.measuredFingerprint === current?.sourceFingerprint
    && options.sourceEquivalence.paths.length > 0 ? options.sourceEquivalence : undefined;
  if (sourceEquivalence && dimensions.source === 'stale') dimensions.source = 'current';
  const staleReasons = Object.entries(dimensions)
    .filter(([, state]) => state === 'stale')
    .map(([dimension]) => `${dimension}-stale`);
  const unknownReasons = Object.entries(dimensions)
    .filter(([, state]) => state === 'unknown')
    .map(([dimension]) =>
      dimension === 'testRun'
        ? row.test_run_worktree_dirty === true
          ? 'test-run-worktree-not-clean'
          : 'test-run-worktree-cleanliness-unproven'
        : dimension === 'environment' && environmentFingerprintMissing
          ? 'environment-evidence-fingerprint-not-recorded'
          : dimension === 'configuration'
            ? options.declaredConfiguration && 'unresolved' in options.declaredConfiguration
              ? `declared-configuration-unresolved:${options.declaredConfiguration.unresolved}`
              : 'declared-configuration-fingerprint-not-recorded'
            : `${dimension}-current-fingerprint-not-supplied`,
    );
  const attestedDimensions = [...new Set(options.attestedDimensions ?? [])].sort();
  const provenance: EvidenceCurrentnessProvenance =
    current === undefined
      ? 'not-supplied'
      : options.provenance === 'server-measured' && attestedDimensions.length > 0
        ? 'partially-server-measured'
        : options.provenance ?? 'attested-current';
  // The public replay path is NOT an independent measurement: the whole `current`
  // tuple arrives from the caller, so `replayed-snapshot` stays unknown when it matches.
  // The internal grading-audit path uses `historical-snapshot` only with auditAsOf to
  // reconstruct the verdict at card creation; its distinct provenance is not a live
  // freshness attestation or a ship-gate result.
  const attestedCurrentGuard =
    (provenance === 'attested-current' ||
      provenance === 'partially-server-measured' ||
      provenance === 'replayed-snapshot') &&
    staleReasons.length === 0
      ? [
          provenance === 'partially-server-measured'
            ? `current-fingerprints-partially-attested-not-independently-measured:${attestedDimensions.join(',')}`
            : provenance === 'replayed-snapshot'
              ? 'current-fingerprints-replayed-not-independently-measured'
              : 'current-fingerprints-attested-not-independently-measured',
        ]
      : [];
  const guardedUnknownReasons = [...unknownReasons, ...attestedCurrentGuard];
  return {
    overall: staleReasons.length > 0 ? 'stale' : guardedUnknownReasons.length > 0 ? 'unknown' : 'current',
    dimensions,
    staleReasons,
    unknownReasons: guardedUnknownReasons,
    comparisonSupplied: current != null,
    provenance,
    ...(sourceEquivalence ? { sourceEquivalence } : {}),
  };
}

/**
 * Split a failed mutation-probe run's ledger tail into its non-empty lines (WI-10006745). The
 * ledger reporter writes one `<case full name>: <message>` line per failed case; the adequacy
 * evaluator matches a declared test case against those line prefixes. Prefer structured failed
 * identities (EI-25248905256718690): large DOM diagnostics can erase all names from that tail.
 * Old valid rows retain their legacy path; malformed execution proof never falls back to text.
 */
export function mutationFailureLines(tail: string, executionDetails?: unknown): string[] {
  if (executionDetails != null) {
    const execution = parseTestRunExecutionDetails(executionDetails);
    if (!execution) return [];
    if (execution.failedCaseTitles !== undefined) {
      return execution.failedCaseTitles.map(title => `${title}: (recorded failed assertion)`);
    }
  }
  return tail
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, 64);
}

/**
 * The mutant run's recorded failed-case titles, for EXACT-membership case matching (WI-10006753).
 * `mutationFailureLines` re-renders these as `<title>: …` lines, and prefix matching over those
 * lines lets a declared `suite > a` claim a recorded failed `suite > a: b`; the adequacy
 * evaluator prefers this list when present. `undefined` = no structured titles (legacy row or no
 * execution details) → the evaluator falls back to line-prefix matching. Malformed execution proof
 * yields `[]` (measures nothing), mirroring `mutationFailureLines`' refusal to fall back to text.
 */
export function mutationFailedCaseTitles(executionDetails?: unknown): string[] | undefined {
  if (executionDetails == null) return undefined;
  const execution = parseTestRunExecutionDetails(executionDetails);
  if (!execution) return [];
  return execution.failedCaseTitles === undefined ? undefined : [...execution.failedCaseTitles];
}

export interface MutationCaughtCaseProseMismatch {
  field: 'observations' | 'calibration';
  failedCaseTitles?: string[];
  expectedClaim: string | null;
}

function stringLeaves(value: unknown): string[] {
  const strings: string[] = [];
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      strings.push(current);
      continue;
    }
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    pending.push(...(Array.isArray(current) ? current : Object.values(current)));
  }
  return strings;
}

/** Refuse caller prose that claims more caught mutant cases than the canonical ledger. */
export function mutationCaughtCaseProseMismatch(
  details: Record<string, unknown>,
  failedCaseTitles: string[] | undefined,
): MutationCaughtCaseProseMismatch | null {
  const expectedClaim = failedCaseTitles?.length
    ? `caught by: ${failedCaseTitles.join(' | ')}`
    : null;
  for (const field of ['observations', 'calibration'] as const) {
    for (const prose of stringLeaves(details[field])) {
      const marker = /\bcaught by:/gi;
      let match = marker.exec(prose);
      while (match) {
        const start = match.index ?? 0;
        const actual = prose.slice(start);
        const matchesLedger = expectedClaim !== null
          && actual.slice('caught by:'.length, expectedClaim.length) === expectedClaim.slice('caught by:'.length)
          // The observed list style uses " | " between cases; a following separator
          // adds a further caller-claimed case after the complete measured list.
          && !/^\s*\|\s*/.test(actual.slice(expectedClaim.length));
        if (!matchesLedger) {
          return {
            field,
            ...(failedCaseTitles === undefined ? {} : { failedCaseTitles: [...failedCaseTitles] }),
            expectedClaim,
          };
        }
        // A test title may itself contain "caught by:". Skip the verified title list as a unit.
        marker.lastIndex = start + expectedClaim!.length;
        match = marker.exec(prose);
      }
    }
  }
  return null;
}

export function mutationCaughtCaseClaimMessage(
  testRunId: number,
  mismatch: MutationCaughtCaseProseMismatch,
): string {
  const measured = mismatch.failedCaseTitles === undefined
    ? ' (no canonical case list was recorded)'
    : ` ${JSON.stringify(mismatch.failedCaseTitles)}`;
  return `details.${mismatch.field} contains a "caught by:" case claim that does not match mutant test-run ${testRunId} ` +
    `failedCaseTitles${measured}. ` +
    (mismatch.expectedClaim
      ? `Use the measured list exactly as "${mismatch.expectedClaim}", or remove the caught-case claim.`
      : 'Remove the caught-case claim because this run has no measured failed cases.');
}

interface EvidenceRow extends CurrentnessRow {
  verifies_binding_id?: number | string | null;
  /** P-011: the BAR pin of the bound clause revision, when it was projected from a rubric. */
  source_rubric_slug?: string | null;
  source_rubric_revision?: number | null;
  source_bar_key?: string | null;
  id: number;
  work_item_id: string;
  plan_slug: string;
  spec_id: string;
  source_val_id: string | null;
  spec_revision: number;
  current_revision: number;
  spec_fingerprint: string;
  evidence_kind: SpecEvidenceKind;
  evidence_ref: string;
  details: Record<string, unknown>;
  observed_at: Date | string;
  binding_fingerprint: string;
  created_by: string;
  created_at: Date | string;
  /**
   * Withdrawal stamp (migration 1174). NULL on live proof; set all-three-or-none, once,
   * and never cleared — the row itself is never deleted, so a withdrawn claim stays
   * auditable. Only an `includeRetracted` read can see a row with these set.
   */
  retracted_at: Date | string | null;
  retracted_by: string | null;
  retraction_reason: string | null;
  test_run_file_path: string | null;
  test_run_commit_sha: string | null;
  test_run_worktree_dirty: boolean | null;
  test_run_status?: string | null;
  test_run_framework?: string | null;
  test_run_source?: string | null;
  test_run_execution_details?: unknown;
  test_run_started_at?: Date | string | null;
  test_run_finished_at?: Date | string | null;
  /** Ledger output tail of a FAILED mutation-probe run bound as mutation evidence; else NULL. */
  mutation_failure_tail: string | null;
  /** Same source/status fence as the tail; optional for legacy mock/read envelopes. */
  mutation_execution_details?: unknown;
  mutation_baseline_id?: number | string | null;
  mutation_baseline_status?: string | null;
  mutation_baseline_execution_details?: unknown;
  provisionalProofBase?: boolean;
  provisionalScorecard?: ProvisionalScorecardProof;
}

/** The verified recording adapter's layer, never an inferred historical runtime layer. */
export function canonicalOperationalAdapterLayer(run: {
  framework?: string | null; source?: string | null; filePath?: string | null;
  runGroupId?: string | null; commitSha?: string | null; worktreeDirty?: boolean | null;
}): 'operational' | undefined {
  if (run.framework !== 'operational' || run.source !== 'local' ||
    run.worktreeDirty !== false || !run.commitSha) return undefined;
  // executeOperationalRun owns this receipt namespace and executes the callback;
  // this classifies the recording adapter, not a Vitest or e2e runtime layer.
  const native = /^operational-native:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(run.runGroupId ?? '') &&
    /^[a-f0-9]{40}$/.test(run.commitSha) &&
    repoMeasurementPathSchema.safeParse(run.filePath).success;
  const archived =
    /^docs\/evidence\/[^\n]+\.json$/.test(run.filePath ?? '') &&
    /^operational(?:-recovery:\d+)?:[a-f0-9]{40}$/.test(run.runGroupId ?? '');
  return native || archived ? 'operational' : undefined;
}

function scorecardIssueIdFromEvidenceRef(evidenceRef: string): string | null {
  const match = /^scorecard:([^#\s]+)(?:#.*)?$/.exec(evidenceRef.trim());
  return match?.[1] ?? null;
}

function parseProvisionalScorecardProof(issueId: string, value: unknown): ProvisionalScorecardProof | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const violatableKeys = Array.isArray(raw.violatableKeys)
    ? raw.violatableKeys.filter((key): key is string => typeof key === 'string' && key.trim() !== '')
    : [];
  if (violatableKeys.length === 0 || typeof raw.stampedAt !== 'string' || raw.stampedAt.trim() === '') return null;
  return { issueId, stampedAt: raw.stampedAt, violatableKeys };
}

export interface ListSpecEvidenceDiagnostics {
  phaseMs: Record<string, number>;
  committedTree?: CommittedTreeDiagnostics;
  bindings: {
    selectedRows: number;
    rowsWithRecipe: number;
    measured: number;
    unavailable: number;
    skipped: number;
    totalMeasurementMs: number;
    maxMeasurementMs: number;
  };
}

export interface ListSpecEvidenceOptions {
  harnessSlug?: string;
  /** Pin historical audit reads to the workspace recorded on the graded card. */
  workspaceId?: string;
  /**
   * The plan namespaces to read evidence from — an ARRAY, not a single slug, since P-013.
   *
   * WHY IT HAD TO WIDEN. D-012/D-013 made a work item's contract span plan namespaces: an
   * edge can name a clause in a plan the item is not stamped with. Once the completion
   * gate ENFORCES those cross-namespace clauses (P-013), a single-plan evidence read makes
   * every one of them find ZERO rows and refuse SPURIOUSLY — the gate would demand proof it
   * had just made itself unable to see. So the enforced clause set and the evidence read
   * must be scoped by the SAME set of namespaces, always.
   *
   * It is one query with `plan_slug = ANY(...)`, deliberately, not an N-plan fan-out: the
   * 1000-row safety limit callers apply is a limit on the WHOLE selection, and N separate
   * capped queries cannot honour one shared cap.
   *
   * An EMPTY array selects nothing, which is the honest reading of "no eligible namespace".
   */
  planSlugs: string[];
  workItemIds?: string[];
  specIds?: string[];
  sourceValIds?: string[];
  evidenceKinds?: SpecEvidenceKind[];
  evidenceRefs?: string[];
  /** Restrict a replay to exact immutable binding rows; [] selects no rows. */
  bindingIds?: number[];
  /** Boolean aliases carry no testimony and use the same server measurement as omission. */
  current?: EvidenceCurrentInput[] | boolean;
  /** Pin reads to one immutable clause revision instead of the live revision pointer. */
  specRevision?: number;
  /** Optional content hash paired with specRevision for an exact immutable pin. */
  specFingerprint?: string;
  /** Replay the supplied current tuple as a prior server measurement; never re-read live files. */
  replaySnapshot?: boolean;
  /** Provenance for a replayed current tuple; historical-snapshot is internal and requires auditAsOf. */
  currentProvenance?: 'server-measured' | 'partially-server-measured' | 'replayed-snapshot' | 'historical-snapshot';
  currentness?: Array<'current' | 'stale' | 'unknown'>;
  /**
   * Include bindings that were deliberately WITHDRAWN (migration 1174, decision D-011).
   *
   * Defaults to false, and that default is the whole point: the spec-test-adequacy
   * evaluator scans EVERY row of a (spec, revision) cohort — execution-integrity fails
   * the clause if ANY binding names a run that was never collected or executed, and
   * freshness fails it if ANY binding has gone stale — so one malformed binding
   * permanently bricks its clause. Appending a corrected row cannot outrank the bad one
   * (this loader has no DISTINCT ON; both rows are read), and spec_revision is the only
   * partitioning dimension, so before 1174 the only escape was bumping the clause
   * revision purely to shed the failing evidence. D-011 rules that out as gate evasion.
   *
   * So a retraction is what a default read must NOT see, or it repairs nothing. Pass
   * true only for an AUDIT read — one that must show what was withdrawn, by whom and
   * why — never from an evaluator, a gate, or anything that counts evidence.
   */
  includeRetracted?: boolean;
  /**
   * Historical audit cutoff. When set with includeRetracted:true, return only
   * bindings that existed and had not yet been withdrawn at this instant.
   */
  auditAsOf?: Date;
  limit?: number;
  /** Optional internal timing sink for the plans:get-spec-evidence slow-read diagnosis. */
  diagnostics?: ListSpecEvidenceDiagnostics;
  /** Internal contract inspection only. Rows remain unmeasured and cannot prove freshness. */
  measurementMode?: 'metadata';
}

export interface WorkItemSpecRevisionEdge {
  workItemId: string;
  planSlug: string;
  specId: string;
  specRevision: number;
  specFingerprint: string;
}

export interface EnsureWorkItemSpecRevisionEdgesInput {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  planItemIds: readonly string[];
  workItemId: string;
  actorId: string;
}

async function writeWorkItemSpecRevisionEdges(
  input: EnsureWorkItemSpecRevisionEdgesInput,
  tx: SpecClauseSql,
): Promise<WorkItemSpecRevisionEdge[]> {
  const planItemIds = [...new Set(input.planItemIds.map((id) => id.trim()).filter(Boolean))];
  if (planItemIds.length === 0) return [];

  await tx`
    INSERT INTO harness_shared.work_item_spec_revision_edges (
      workspace_id, harness_slug, work_item_id, plan_slug, spec_id,
      spec_revision, spec_fingerprint, created_by
    )
    SELECT c.workspace_id, c.harness_slug, ${input.workItemId}, c.plan_slug,
           c.spec_id, c.current_revision, r.content_hash, ${input.actorId}
      FROM harness_shared.plan_spec_clauses c
      JOIN harness_shared.plan_spec_clause_revisions r
        ON r.workspace_id = c.workspace_id
       AND r.harness_slug = c.harness_slug
       AND r.plan_slug = c.plan_slug
       AND r.spec_id = c.spec_id
       AND r.revision = c.current_revision
     WHERE c.workspace_id = ${input.workspaceId}
       AND c.harness_slug = ${input.harnessSlug}
       AND c.plan_slug = ${input.planSlug}
       AND r.plan_item_id = ANY(${planItemIds}::text[])
    ON CONFLICT DO NOTHING`;

  const rows = await tx<{
    work_item_id: string;
    plan_slug: string;
    spec_id: string;
    spec_revision: number | string;
    spec_fingerprint: string;
  }[]>`
    SELECT work_item_id, plan_slug, spec_id, spec_revision, spec_fingerprint
      FROM harness_shared.work_item_spec_revision_edges
     WHERE workspace_id = ${input.workspaceId}
       AND harness_slug = ${input.harnessSlug}
       AND work_item_id = ${input.workItemId}
       AND plan_slug = ${input.planSlug}
     ORDER BY spec_id, spec_revision`;
  return rows.map((row) => ({
    workItemId: row.work_item_id,
    planSlug: row.plan_slug,
    specId: row.spec_id,
    specRevision: Number(row.spec_revision),
    specFingerprint: row.spec_fingerprint,
  }));
}

/**
 * Attach a promoted work-item to every current spec revision owned by its plan
 * item.  Promotion is the first moment the canonical work-item id exists, so
 * this is the join that turns activation's BAR/spec projection into an
 * executable behavior contract.  The edge is append-only: a later clause
 * revision gets a new edge, while old edges remain auditable and are reported
 * stale by the resolver.
 */
export async function ensureWorkItemSpecRevisionEdges(
  input: EnsureWorkItemSpecRevisionEdgesInput,
): Promise<WorkItemSpecRevisionEdge[]> {
  return withWorkspace(input.workspaceId, async (tx) => {
    return writeWorkItemSpecRevisionEdges(input, tx as unknown as SpecClauseSql);
  });
}

export interface CarryForwardCurrentSpecEvidenceInput {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  planItemId: string;
  workItemId: string;
  actorId: string;
}

export interface CarryForwardCurrentSpecEvidenceResult {
  sourceWorkItemId: string | null;
  copiedBindingIds: number[];
}

interface CarryForwardSpecEvidenceRow {
  source_work_item_id: string;
  id: number | string;
  spec_id: string;
  spec_revision: number | string;
  evidence_kind: SpecEvidenceKind;
  evidence_ref: string;
  source_fingerprint: string;
  test_fingerprint: string | null;
  fixture_fingerprint: string | null;
  rubric_fingerprint: string | null;
  environment_fingerprint: string | null;
  coverage_evidence_ref: number | string | null;
  test_run_id: number | string | null;
  details: Record<string, unknown> | null;
  observed_at: Date | string;
  created_by: string | null;
  verifies_binding_id: number | string | null;
}

/**
 * Preserve current-clause evidence when promotion replaces a completed plan-item
 * work-item. This copies only unretracted bindings for the clause's current
 * revision from the newest completed or replaced (dropped) work-item with the
 * exact plan-item stamp. Reopening a plan item can drop its former canonical
 * work-item even though its exact, current proof remains reusable.
 * Each copied row goes through the normal binder, which revalidates the new
 * work-item's plan-item provenance and referenced runs. The old rows remain
 * untouched, and the adequacy gate still evaluates evidence for the exact
 * current work-item id and current fingerprints.
 */
export async function carryForwardCurrentSpecEvidence(
  input: CarryForwardCurrentSpecEvidenceInput,
): Promise<CarryForwardCurrentSpecEvidenceResult> {
  const planItemId = input.planItemId.trim();
  if (!planItemId) throw new Error('spec_evidence_continuity_plan_item_required');

  const candidates = await withWorkspace(input.workspaceId, async (tx) => {
    const [target] = await tx<{
      feature_id: string;
      source_plan_slug: string | null;
      source_plan_item_ids: string[] | null;
      stamped_plan_slug: string | null;
      stamped_item_id: string | null;
    }[]>`
      SELECT feature_id, source_plan_slug, source_plan_item_ids,
             payload -> 'plan_item' ->> 'plan_slug' AS stamped_plan_slug,
             payload -> 'plan_item' ->> 'item_id' AS stamped_item_id
        FROM harness_shared.work_items
       WHERE workspace_id = ${input.workspaceId}
         AND harness_slug = ${input.harnessSlug}
         AND feature_id = ${input.workItemId}`;
    if (!target) throw new Error('spec_evidence_continuity_target_missing:' + input.workItemId);
    const targetProvenance = planItemProvenanceFromRow(target);
    if (targetProvenance.planSlug !== input.planSlug || !targetProvenance.itemIds.includes(planItemId)) {
      throw new Error('spec_evidence_continuity_target_plan_item_mismatch:' + input.workItemId + ':' +
        input.planSlug + '#' + planItemId);
    }

    return tx<CarryForwardSpecEvidenceRow[]>`
      WITH current_clauses AS (
        SELECT c.spec_id, c.current_revision, r.content_hash
          FROM harness_shared.plan_spec_clauses c
          JOIN harness_shared.plan_spec_clause_revisions r
            ON r.workspace_id = c.workspace_id
           AND r.harness_slug = c.harness_slug
           AND r.plan_slug = c.plan_slug
           AND r.spec_id = c.spec_id
           AND r.revision = c.current_revision
         WHERE c.workspace_id = ${input.workspaceId}
           AND c.harness_slug = ${input.harnessSlug}
           AND c.plan_slug = ${input.planSlug}
           AND r.plan_item_id = ${planItemId}
      )
      SELECT wi.feature_id AS source_work_item_id,
             b.id, b.spec_id, b.spec_revision, b.evidence_kind, b.evidence_ref,
             b.source_fingerprint, b.test_fingerprint, b.fixture_fingerprint,
             b.rubric_fingerprint, b.environment_fingerprint, b.coverage_evidence_ref,
             b.test_run_id, b.details, b.observed_at, b.created_by, b.verifies_binding_id
        FROM harness_shared.work_items wi
        JOIN harness_shared.spec_evidence_bindings b
          ON b.workspace_id = wi.workspace_id
         AND b.harness_slug = wi.harness_slug
         AND b.work_item_id = wi.feature_id
        JOIN current_clauses c
          ON c.spec_id = b.spec_id
         AND c.current_revision = b.spec_revision
         AND c.content_hash = b.spec_fingerprint
       WHERE wi.workspace_id = ${input.workspaceId}
         AND wi.harness_slug = ${input.harnessSlug}
         AND wi.feature_id <> ${input.workItemId}
         AND wi.status = ANY(${['done', 'resolved', 'passed', 'closed', 'dropped']}::text[])
         AND b.plan_slug = ${input.planSlug}
         AND b.retracted_at IS NULL
         AND (
           (wi.source_plan_slug = ${input.planSlug}
             AND ${planItemId} = ANY(COALESCE(wi.source_plan_item_ids, ARRAY[]::text[])))
           OR (
             wi.payload -> 'plan_item' ->> 'plan_slug' = ${input.planSlug}
             AND wi.payload -> 'plan_item' ->> 'item_id' = ${planItemId}
           )
         )
       ORDER BY wi.updated_ts DESC NULLS LAST, wi.feature_id DESC, b.created_at, b.id`;
  });

  if (candidates.length === 0) return { sourceWorkItemId: null, copiedBindingIds: [] };
  const sourceWorkItemId = candidates[0].source_work_item_id;
  const sourceRows = candidates.filter((row) => row.source_work_item_id === sourceWorkItemId);
  const copiedBindingIds: number[] = [];
  const copiedIds = new Map<number, number>();

  const copy = async (row: CarryForwardSpecEvidenceRow, verifiesBindingId?: number): Promise<void> => {
    const result = await bindSpecEvidence({
      workspaceId: input.workspaceId,
      harnessSlug: input.harnessSlug,
      planSlug: input.planSlug,
      workItemId: input.workItemId,
      specId: row.spec_id,
      specRevision: Number(row.spec_revision),
      evidenceKind: row.evidence_kind,
      evidenceRef: row.evidence_ref,
      sourceFingerprint: row.source_fingerprint,
      testFingerprint: row.test_fingerprint,
      fixtureFingerprint: row.fixture_fingerprint,
      rubricFingerprint: row.rubric_fingerprint,
      environmentFingerprint: row.environment_fingerprint,
      coverageEvidenceRef: row.coverage_evidence_ref == null ? null : Number(row.coverage_evidence_ref),
      testRunId: row.test_run_id == null ? null : Number(row.test_run_id),
      ...(verifiesBindingId === undefined ? {} : { verifiesBindingId }),
      details: row.details ?? {},
      observedAt: new Date(row.observed_at).toISOString(),
      actorId: row.created_by ?? input.actorId,
    });
    if (result.status !== 'created' && result.status !== 'unchanged') {
      throw new Error('spec_evidence_continuity_bind_refused:' + sourceWorkItemId + ':' +
        row.id + ':' + result.status);
    }
    copiedIds.set(Number(row.id), result.id);
    copiedBindingIds.push(result.id);
  };

  for (const row of sourceRows) {
    if (row.evidence_kind === 'independent-verification') continue;
    await copy(row);
  }
  for (const row of sourceRows) {
    if (row.evidence_kind !== 'independent-verification' || row.verifies_binding_id == null) continue;
    const targetBindingId = copiedIds.get(Number(row.verifies_binding_id));
    if (targetBindingId === undefined) continue;
    await copy(row, targetBindingId);
  }
  return { sourceWorkItemId, copiedBindingIds };
}

/**
 * Attach current clause revisions to every already-existing work-item that
 * names one of the supplied plan items. Activation can run after promotion,
 * so this repair must cover terminal rows as well as live rows and must not
 * mint a replacement work-item. All provenance legs are read in the same
 * caller-supplied transaction as the BAR/spec writes.
 */
export async function ensureExistingWorkItemSpecRevisionEdgesInTransaction(
  input: Omit<EnsureWorkItemSpecRevisionEdgesInput, 'workItemId'>,
  tx: SpecClauseSql,
): Promise<WorkItemSpecRevisionEdge[]> {
  const planItemIds = [...new Set(input.planItemIds.map((id) => id.trim()).filter(Boolean))];
  if (planItemIds.length === 0) return [];

  // The feature-family coord plane historically lives in `default`, while
  // issue-family links follow the active workspace when COORD_PER_WORKSPACE is
  // enabled. Read both without changing the scheduler or claim specification.
  const coordWorkspaceIds = [...new Set([input.workspaceId, DEFAULT_COORD_WORKSPACE])];
  const planItemRefs = planItemIds.map((itemId) => planItemRef(input.planSlug, itemId));
  const rows = await tx<{ work_item_id: string; plan_item_id: string }[]>`
    WITH provenance AS (
      SELECT wi.feature_id AS work_item_id,
             source_item.item_id AS plan_item_id
        FROM harness_shared.work_items wi
        CROSS JOIN LATERAL unnest(COALESCE(wi.source_plan_item_ids, ARRAY[]::text[]))
          AS source_item(item_id)
       WHERE wi.workspace_id = ANY(${coordWorkspaceIds}::text[])
         AND wi.harness_slug = ${input.harnessSlug}
         AND wi.source_plan_slug = ${input.planSlug}
      UNION
      SELECT wi.feature_id AS work_item_id,
             wi.payload->'plan_item'->>'item_id' AS plan_item_id
        FROM harness_shared.work_items wi
       WHERE wi.workspace_id = ANY(${coordWorkspaceIds}::text[])
         AND wi.harness_slug = ${input.harnessSlug}
         AND wi.payload->'plan_item'->>'plan_slug' = ${input.planSlug}
      UNION
      SELECT wi.feature_id AS work_item_id,
             split_part(l.dst_ref, '#', 2) AS plan_item_id
        FROM harness_shared.coord_links l
        JOIN harness_shared.work_items wi
          ON wi.workspace_id = l.workspace_id
         AND wi.harness_slug = ${input.harnessSlug}
         AND (
           (l.src_kind = 'issue' AND wi.feature_id = l.src_ref)
           OR (
             l.src_kind = 'feature'
             AND wi.feature_id = split_part(l.src_ref, '#', 2)
             AND wi.harness_slug = split_part(l.src_ref, '#', 1)
           )
         )
       WHERE l.workspace_id = ANY(${coordWorkspaceIds}::text[])
         AND l.rel = ANY(${['implements', 'relates']}::text[])
         AND l.dst_kind = 'plan_item'
         AND l.dst_ref = ANY(${planItemRefs}::text[])
    )
    SELECT DISTINCT work_item_id, plan_item_id
      FROM provenance
     WHERE plan_item_id = ANY(${planItemIds}::text[])
     ORDER BY work_item_id, plan_item_id`;

  const planItemsByWorkItem = new Map<string, string[]>();
  for (const row of rows) {
    const ids = planItemsByWorkItem.get(row.work_item_id) ?? [];
    if (!ids.includes(row.plan_item_id)) ids.push(row.plan_item_id);
    planItemsByWorkItem.set(row.work_item_id, ids);
  }

  const edges: WorkItemSpecRevisionEdge[] = [];
  for (const [workItemId, workItemPlanItemIds] of planItemsByWorkItem) {
    edges.push(...await writeWorkItemSpecRevisionEdges({
      ...input,
      planItemIds: workItemPlanItemIds,
      workItemId,
    }, tx));
  }
  return edges;
}

/** Read the explicit many-to-many coverage edges for one work item. */
export async function listWorkItemSpecRevisionEdges(options: {
  harnessSlug?: string;
  /**
   * OMIT to read every namespace. D-013: a work item may link to clauses in any
   * plan namespace regardless of its own source-plan provenance, so the universal
   * resolver needs the unscoped read. Widened here rather than added as a sibling
   * reader — two readers over one edge table is how the two drift apart.
   */
  planSlug?: string;
  workItemId: string;
}): Promise<WorkItemSpecRevisionEdge[]> {
  const scope = await resolvePlanScope({
    harnessSlug: options.harnessSlug,
  });
  const planSlug = options.planSlug;
  const rows = await withWorkspace(
    scope.workspaceId,
    async (tx) => tx<{
      work_item_id: string;
      plan_slug: string;
      spec_id: string;
      spec_revision: number;
      spec_fingerprint: string;
    }[]>`
      SELECT work_item_id, plan_slug, spec_id, spec_revision, spec_fingerprint
        FROM harness_shared.work_item_spec_revision_edges
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND work_item_id = ${options.workItemId}
         ${planSlug === undefined ? tx`` : tx`AND plan_slug = ${planSlug}`}
       ORDER BY plan_slug, spec_id, spec_revision`,
  );
  return rows.map((row) => ({
    workItemId: row.work_item_id,
    planSlug: row.plan_slug,
    specId: row.spec_id,
    specRevision: Number(row.spec_revision),
    specFingerprint: row.spec_fingerprint,
  }));
}

export interface RetractSpecEvidenceOptions {
  harnessSlug?: string;
  /** Internal callers already holding a scoped target must retain its workspace. */
  workspaceId?: string;
  /**
   * The exact binding row to withdraw, as returned by plans:get-spec-evidence.
   *
   * Deliberately the row id and never a (workItemId, evidenceRef) pair: changed
   * fingerprints APPEND history, so that pair routinely matches several rows and a
   * retraction is one-way and per-row. Targeting by id forces the caller to have
   * actually looked at the row they are withdrawing.
   */
  bindingId: number;
  reason: string;
  actorId: string;
}

export interface RetractedBindingRow {
  id: number;
  work_item_id: string;
  plan_slug: string;
  spec_id: string;
  spec_revision: number;
  evidence_kind: SpecEvidenceKind;
  evidence_ref: string;
  retracted_at: Date | string | null;
  retracted_by: string | null;
  retraction_reason: string | null;
}

type CancelledAuditorNotifier = (input: {
  workspaceId: string;
  issueIds: readonly string[];
  harness?: string | null;
  reason?: string;
}) => Promise<unknown>;

interface SpecEvidenceGradingAuditNotificationDeps {
  /** Test seam; production resolves the shared notifier after the write commits. */
  notifyCancelledAuditors?: CancelledAuditorNotifier;
}

async function notifyCancelledAuditorsAfterCommit(
  input: {
    workspaceId: string;
    harnessSlug: string;
    issueIds: readonly string[];
    reason: string;
  },
  deps: SpecEvidenceGradingAuditNotificationDeps,
): Promise<void> {
  if (input.issueIds.length === 0) return;
  try {
    const notify = deps.notifyCancelledAuditors ??
      (await import('../../grading-integrity')).notifyCancelledGradingAuditors;
    await notify({
      workspaceId: input.workspaceId,
      harness: input.harnessSlug,
      issueIds: input.issueIds,
      reason: input.reason,
    });
  } catch (error) {
    // The binding withdrawal is already committed. Keep notification degradation
    // visible without turning a durable evidence repair into a false failure.
    console.warn('[spec-evidence] cancelled grading-auditor notification failed:',
      error instanceof Error ? error.message : error);
  }
}

export type RetractSpecEvidenceResult =
  | { status: 'not_found'; bindingId: number; binding: null }
  | { status: 'already_retracted'; bindingId: number; binding: RetractedBindingRow }
  | {
      status: 'retracted';
      bindingId: number;
      binding: RetractedBindingRow;
      cancelledAuditIssueIds: string[];
    };

export interface RetractSpecEvidenceBatchOptions {
  harnessSlug?: string;
  /** Internal callers already holding a scoped target must retain its workspace. */
  workspaceId?: string;
  actorId: string;
  items: ReadonlyArray<Pick<RetractSpecEvidenceOptions, 'bindingId' | 'reason'>>;
}

/**
 * Record attributable withdrawals of evidence bindings (D-011) in one workspace
 * transaction. A database failure rolls the full request back; expected per-row
 * outcomes such as not_found and already_retracted remain in the returned results.
 *
 * Each row is never deleted and never edited — it acquires a stamp, and default reads
 * stop counting it while an `includeRetracted` audit read still returns it in full.
 * This is the ONLY sanctioned repair for malformed bindings: because the adequacy
 * evaluator fails a clause if ANY bound row is uncollected/unexecuted or stale, and
 * spec_revision is its only partitioning dimension, the alternative was bumping a
 * clause revision purely to shed failing evidence — which D-011 forbids as gate
 * evasion, since a bar whose hash moved has genuinely different meaning.
 */
export async function retractSpecEvidenceBatch(
  options: RetractSpecEvidenceBatchOptions,
  deps: SpecEvidenceGradingAuditNotificationDeps = {},
): Promise<RetractSpecEvidenceResult[]> {
  if (options.items.length === 0) return [];
  const scope = await resolvePlanScope({ harnessSlug: options.harnessSlug, workspaceId: options.workspaceId });
  const actorId = options.actorId.trim();
  const results = await withWorkspace(scope.workspaceId, async (tx) => {
    const batchResults: RetractSpecEvidenceResult[] = [];
    for (const item of options.items) {
      const reason = item.reason.trim();
      const [existing] = await tx<RetractedBindingRow[]>`
        SELECT id, work_item_id, plan_slug, spec_id, spec_revision,
               evidence_kind, evidence_ref, retracted_at, retracted_by, retraction_reason
          FROM harness_shared.spec_evidence_bindings
         WHERE workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}
           AND id = ${item.bindingId}`;
      // Not-found and already-retracted are reported as statuses rather than thrown: a
      // retraction is idempotent from the caller's side, and the trigger's own
      // re-retraction error would otherwise surface as an opaque 55000 for a benign replay.
      if (!existing) {
        batchResults.push({ status: 'not_found', bindingId: item.bindingId, binding: null });
        continue;
      }
      if (existing.retracted_at != null) {
        batchResults.push({ status: 'already_retracted', bindingId: existing.id, binding: existing });
        continue;
      }
      const [updated] = await tx<RetractedBindingRow[]>`
        UPDATE harness_shared.spec_evidence_bindings
           SET retracted_at = now(), retracted_by = ${actorId}, retraction_reason = ${reason}
         WHERE workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}
           AND id = ${item.bindingId}
           AND retracted_at IS NULL
        RETURNING id, work_item_id, plan_slug, spec_id, spec_revision,
                  evidence_kind, evidence_ref, retracted_at, retracted_by, retraction_reason`;
      if (!updated) {
        batchResults.push({ status: 'already_retracted', bindingId: existing.id, binding: existing });
        continue;
      }
      // The binding row is withdrawn before the audit row is fenced, but both writes
      // share this transaction. A dispatcher cannot win a reservation in the gap
      // between the evidence update and cancellation (EI-26089859582727160).
      // Keep this import lazy: scorecards' evaluator path consumes this store's
      // schemas, so a static edge would make the schema undefined during module
      // initialization (the cancellation runs only after the store is ready).
      const { cancelPendingGradingAuditsForBindingInTransaction } = await import('../../scorecards');
      const cancelledAuditIssueIds = await cancelPendingGradingAuditsForBindingInTransaction(
        tx,
        scope.workspaceId,
        updated.id,
      );
      batchResults.push({
        status: 'retracted',
        bindingId: updated.id,
        binding: updated,
        cancelledAuditIssueIds,
      });
    }
    return batchResults;
  });
  // Notify only after the shared transaction commits. The audit cancellation for each row
  // is inside that same transaction, so a pushed read cannot see a withdrawn binding whose
  // audit lease is still pending.
  for (const [index, result] of results.entries()) {
    if (result.status !== 'retracted') continue;
    await notifyCancelledAuditorsAfterCommit({
      workspaceId: scope.workspaceId,
      harnessSlug: scope.harnessSlug,
      issueIds: result.cancelledAuditIssueIds,
      reason: `binding ${result.bindingId} was retracted: ${options.items[index]!.reason.trim()}`,
    }, deps);
  }
  if (results.some((result) => result.status === 'retracted')) {
    void trackDetached(import('../../sync-sse'))
      .then((m) => {
        m.notifySyncInvalidate('scorecards.list');
        m.notifySyncInvalidate('rubrics.trend');
        m.notifySyncInvalidate('learning.releaseReadiness');
      })
      .catch(() => {});
  }
  return results;
}

/** Record one attributable withdrawal through the same transactional batch path. */
export async function retractSpecEvidence(
  options: RetractSpecEvidenceOptions,
  deps: SpecEvidenceGradingAuditNotificationDeps = {},
): Promise<RetractSpecEvidenceResult> {
  const [result] = await retractSpecEvidenceBatch({
    harnessSlug: options.harnessSlug,
    workspaceId: options.workspaceId,
    actorId: options.actorId,
    items: [{ bindingId: options.bindingId, reason: options.reason }],
  }, deps);
  return result!;
}

export interface SupersedeSpecEvidenceOptions {
  harnessSlug?: string;
  /** The resolved spec scope slug the superseding binding landed in (bind result `planSlug`). */
  planSlug: string;
  specId: string;
  specRevision: number;
  evidenceKind: SpecEvidenceKind;
  /** The binding doing the superseding; named in every retraction reason. */
  supersedingBindingId: number;
  /** Rows bound in the same call — never retracted by their own sibling. */
  keepBindingIds: readonly number[];
  actorId: string;
}

/**
 * Why a same-kind live sibling survived a supersession. Each names a claim the sibling makes
 * that the superseding row does not, so withdrawing it would have destroyed proof nothing
 * replaced (EI-25220306060165214, EI-24400631485940769).
 */
export type SupersessionKeepReason =
  | 'different-subject'
  | 'different-target'
  | 'different-causal-pairs'
  | 'superseding-binding-not-live';

export interface SupersessionKeptRow {
  id: number;
  work_item_id: string;
  evidence_ref: string;
  subject: string;
  keep_reason: SupersessionKeepReason;
}

export interface SupersessionResult {
  retracted: RetractedBindingRow[];
  /** Same-kind live siblings left standing, each with the claim that protected it. */
  kept: SupersessionKeptRow[];
  /** Pending grading-audit targets fenced in the same withdrawal transaction. */
  cancelledAuditIssueIds?: string[];
}

/**
 * P-019 (review-system-rework-reduction-2026-09-23): withdraw the live rows at one clause
 * revision that the named binding REPLACES, stamped as superseded by it (D-011: stamped, never
 * deleted, still returned by includeRetracted reads).
 *
 * The adequacy evaluator grades every live row at a revision, so one old weak, stale or
 * failing row fails a criterion beside newer sufficient proof — measured on R-11, where a
 * fresh targeted mutation proof could not pass the bar until 13 older rows were retracted by
 * hand. Scoped to the same evidence KIND on purpose: a fresh test row must never withdraw the
 * clause's mutation proof, which is a different obligation. Runs AFTER the superseding bind
 * commits, so a failure here leaves the old rows live and never loses proof.
 *
 * Scoped to the same proof SUBJECT as well. A clause's proof often spans several test files
 * (a unit and an integration layer) or several causal pairs (one per seam). Keyed only on
 * kind, one fresh run retracted every sibling file's current proof: EI-24400631485940769 wiped
 * ~15 current rows from five unrelated seams, EI-25220306060165214 a different layer's still-
 * current unit proof. A sibling is withdrawn only when it proves the same subject — the test
 * run's file (the same `test_runs.file_path` the evaluator reads as testRunProvenance), else
 * `details.testRun.filePath`, else the evidence ref — AND claims nothing the superseding row
 * does not: an `adequacy.targeted` that differs under the clause's accepted-target policy,
 * or `adequacy.causalPairIds` outside the
 * superseding row's set, is a different proof. Survivors are returned in `kept` with that
 * reason, so a caller who meant to clear them retracts those ids explicitly.
 */
export async function supersedeSpecEvidenceAtRevision(
  options: SupersedeSpecEvidenceOptions,
  deps: SpecEvidenceGradingAuditNotificationDeps = {},
): Promise<SupersessionResult> {
  const scope = await resolvePlanScope({ harnessSlug: options.harnessSlug });
  const actorId = options.actorId.trim();
  const reason = `superseded by binding ${options.supersedingBindingId} (plans:bind-spec-evidence supersedeAtRevision)`;
  const keep = [...new Set([options.supersedingBindingId, ...options.keepBindingIds])];
  const result = await withWorkspace(scope.workspaceId, async (tx) => {
    const siblings = await tx<
      Array<Omit<SupersessionKeptRow, 'keep_reason'> & { keep_reason: SupersessionKeepReason | null }>
    >`
      WITH target_policy AS (
        SELECT CASE WHEN jsonb_typeof(r.falsifier->'requiredScenarios') = 'array'
                    THEN jsonb_array_length(r.falsifier->'requiredScenarios') = 0
                    ELSE true END AS accepts_self_target
          FROM harness_shared.plan_spec_clause_revisions r
         WHERE r.workspace_id = ${scope.workspaceId}
           AND r.harness_slug = ${scope.harnessSlug}
           AND r.plan_slug = ${options.planSlug}
           AND r.spec_id = ${options.specId}
           AND r.revision = ${options.specRevision}
      ), clause_rows AS (
        SELECT b.id, b.work_item_id, b.evidence_ref,
               COALESCE(NULLIF(tr.file_path, ''), NULLIF(b.details->'testRun'->>'filePath', ''), b.evidence_ref)
                 AS subject,
               CASE WHEN jsonb_typeof(b.details->'adequacy'->'targeted') = 'string' THEN
                      CASE WHEN (SELECT accepts_self_target FROM target_policy)
                                 AND b.details->'adequacy'->>'targeted'
                                     IN (${options.specId}, ${options.specId.toLowerCase()})
                           THEN ${options.specId}
                           ELSE b.details->'adequacy'->>'targeted' END
                    END AS targeted,
               CASE WHEN jsonb_typeof(b.details->'adequacy'->'causalPairIds') = 'array'
                    THEN b.details->'adequacy'->'causalPairIds' ELSE '[]'::jsonb END AS causal_pair_ids
          FROM harness_shared.spec_evidence_bindings b
          LEFT JOIN harness_shared.test_runs tr ON tr.id = b.test_run_id
         WHERE b.workspace_id = ${scope.workspaceId}
           AND b.harness_slug = ${scope.harnessSlug}
           AND b.plan_slug = ${options.planSlug}
           AND b.spec_id = ${options.specId}
           AND b.spec_revision = ${options.specRevision}
           AND b.evidence_kind = ${options.evidenceKind}
           AND b.retracted_at IS NULL
      ),
      superseding AS (SELECT * FROM clause_rows WHERE id = ${options.supersedingBindingId})
      SELECT c.id, c.work_item_id, c.evidence_ref, c.subject,
             CASE WHEN s.id IS NULL THEN 'superseding-binding-not-live'
                  WHEN c.subject IS DISTINCT FROM s.subject THEN 'different-subject'
                  WHEN c.targeted IS NOT NULL AND c.targeted IS DISTINCT FROM s.targeted THEN 'different-target'
                  WHEN NOT (c.causal_pair_ids <@ s.causal_pair_ids) THEN 'different-causal-pairs'
             END AS keep_reason
        FROM clause_rows c
        LEFT JOIN superseding s ON true
       WHERE NOT (c.id = ANY(${keep}::bigint[]))
       ORDER BY c.id`;
    const retractIds = siblings.filter((row) => row.keep_reason === null).map((row) => Number(row.id));
    const kept = siblings
      .filter((row): row is SupersessionKeptRow => row.keep_reason !== null)
      .map((row) => ({ ...row, id: Number(row.id) }));
    if (retractIds.length === 0) return { retracted: [], kept };
    const retracted = await tx<RetractedBindingRow[]>`
      UPDATE harness_shared.spec_evidence_bindings
         SET retracted_at = now(), retracted_by = ${actorId}, retraction_reason = ${reason}
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND id = ANY(${retractIds}::bigint[])
         AND retracted_at IS NULL
      RETURNING id, work_item_id, plan_slug, spec_id, spec_revision,
                evidence_kind, evidence_ref, retracted_at, retracted_by, retraction_reason`;
    // The binding withdrawals and audit fences share this transaction. Capture
    // issue ids here; the owner notification is deliberately deferred until the
    // transaction has committed below.
    const { cancelPendingGradingAuditsForBindingInTransaction } = await import('../../scorecards');
    const cancelledAuditIssueIds = [...new Set((await Promise.all(
      retracted.map((binding) => cancelPendingGradingAuditsForBindingInTransaction(
        tx,
        scope.workspaceId,
        Number(binding.id),
      )),
    )).flat())].sort();
    return {
      retracted,
      kept,
      ...(cancelledAuditIssueIds.length > 0 ? { cancelledAuditIssueIds } : {}),
    };
  });
  await notifyCancelledAuditorsAfterCommit({
    workspaceId: scope.workspaceId,
    harnessSlug: scope.harnessSlug,
    issueIds: 'cancelledAuditIssueIds' in result ? result.cancelledAuditIssueIds ?? [] : [],
    reason: `spec evidence was superseded by binding ${options.supersedingBindingId}`,
  }, deps);
  if (result.retracted.length > 0) {
    void trackDetached(import('../../sync-sse'))
      .then((m) => {
        m.notifySyncInvalidate('scorecards.list');
        m.notifySyncInvalidate('rubrics.trend');
        m.notifySyncInvalidate('learning.releaseReadiness');
      })
      .catch(() => {});
  }
  return result;
}

export type SupersedeSpecEvidenceBatchItem = Pick<
  SupersedeSpecEvidenceOptions,
  'planSlug' | 'specId' | 'specRevision' | 'evidenceKind' | 'supersedingBindingId'
>;

export interface SupersedeSpecEvidenceBatchOptions {
  harnessSlug?: string;
  actorId: string;
  /** Every binding created by this call, excluded from all sibling withdrawals. */
  keepBindingIds: readonly number[];
  items: readonly SupersedeSpecEvidenceBatchItem[];
}

export interface SupersedeSpecEvidenceBatchResult {
  results: SupersessionResult[];
  cancelledAuditIssueIds: string[];
}

interface SupersedeSpecEvidenceBatchRow {
  input_ordinal: number;
  outcome: 'retracted' | 'kept';
  id: number | string;
  work_item_id: string;
  plan_slug: string;
  spec_id: string;
  spec_revision: number;
  evidence_kind: SpecEvidenceKind;
  evidence_ref: string;
  subject: string | null;
  retracted_at: Date | string | null;
  retracted_by: string | null;
  retraction_reason: string | null;
  keep_reason: SupersessionKeepReason | null;
}

/**
 * Supersede a group of clause bindings in one set-based pass and one workspace transaction.
 * Stable input order assigns a prior row to the first sufficient replacement that covers it.
 */
export async function supersedeSpecEvidenceAtRevisionBatch(
  options: SupersedeSpecEvidenceBatchOptions,
  deps: SpecEvidenceGradingAuditNotificationDeps = {},
): Promise<SupersedeSpecEvidenceBatchResult> {
  if (options.items.length === 0) return { results: [], cancelledAuditIssueIds: [] };
  const scope = await resolvePlanScope({ harnessSlug: options.harnessSlug });
  const actorId = options.actorId.trim();
  const keepBindingIds = [...new Set([
    ...options.keepBindingIds,
    ...options.items.map((item) => item.supersedingBindingId),
  ])];
  const requested = options.items.map((item, input_ordinal) => ({
    input_ordinal,
    plan_slug: item.planSlug,
    spec_id: item.specId,
    spec_revision: item.specRevision,
    evidence_kind: item.evidenceKind,
    superseding_binding_id: item.supersedingBindingId,
    keep_binding_ids: keepBindingIds,
  }));
  const requestJson = JSON.stringify(requested);
  const result = await withWorkspace(scope.workspaceId, async (tx) => {
    const rows = await tx<SupersedeSpecEvidenceBatchRow[]>`
      WITH requested AS (
        SELECT * FROM jsonb_to_recordset(${requestJson}::jsonb)
          AS input_rows(
            input_ordinal integer,
            plan_slug text,
            spec_id text,
            spec_revision integer,
            evidence_kind text,
            superseding_binding_id bigint,
            keep_binding_ids bigint[]
          )
      ), groups AS (
        SELECT DISTINCT plan_slug, spec_id, spec_revision, evidence_kind
          FROM requested
      ), target_policy AS (
        SELECT groups.plan_slug, groups.spec_id, groups.spec_revision,
               CASE WHEN jsonb_typeof(revision.falsifier->'requiredScenarios') = 'array'
                    THEN jsonb_array_length(revision.falsifier->'requiredScenarios') = 0
                    ELSE true END AS accepts_self_target
          FROM groups
          LEFT JOIN harness_shared.plan_spec_clause_revisions revision
            ON revision.workspace_id = ${scope.workspaceId}
           AND revision.harness_slug = ${scope.harnessSlug}
           AND revision.plan_slug = groups.plan_slug
           AND revision.spec_id = groups.spec_id
           AND revision.revision = groups.spec_revision
      ), clause_rows AS (
        SELECT binding.id, binding.work_item_id, binding.plan_slug, binding.spec_id,
               binding.spec_revision, binding.evidence_kind, binding.evidence_ref,
               COALESCE(NULLIF(test_run.file_path, ''),
                        NULLIF(binding.details->'testRun'->>'filePath', ''),
                        binding.evidence_ref) AS subject,
               CASE WHEN jsonb_typeof(binding.details->'adequacy'->'targeted') = 'string' THEN
                      CASE WHEN policy.accepts_self_target
                                     AND binding.details->'adequacy'->>'targeted'
                                         IN (groups.spec_id, lower(groups.spec_id))
                           THEN groups.spec_id
                           ELSE binding.details->'adequacy'->>'targeted' END
                    END AS targeted,
               CASE WHEN jsonb_typeof(binding.details->'adequacy'->'causalPairIds') = 'array'
                    THEN binding.details->'adequacy'->'causalPairIds' ELSE '[]'::jsonb END AS causal_pair_ids
          FROM groups
          JOIN harness_shared.spec_evidence_bindings binding
            ON binding.workspace_id = ${scope.workspaceId}
           AND binding.harness_slug = ${scope.harnessSlug}
           AND binding.plan_slug = groups.plan_slug
           AND binding.spec_id = groups.spec_id
           AND binding.spec_revision = groups.spec_revision
           AND binding.evidence_kind = groups.evidence_kind
           AND binding.retracted_at IS NULL
          LEFT JOIN harness_shared.test_runs test_run ON test_run.id = binding.test_run_id
          LEFT JOIN target_policy policy
            ON policy.plan_slug = groups.plan_slug
           AND policy.spec_id = groups.spec_id
           AND policy.spec_revision = groups.spec_revision
      ), superseding AS (
        SELECT requested.input_ordinal, binding.id, binding.subject, binding.targeted,
               binding.causal_pair_ids
          FROM requested
          LEFT JOIN clause_rows binding ON binding.id = requested.superseding_binding_id
      ), comparisons AS (
        SELECT requested.input_ordinal, sibling.id, sibling.work_item_id, sibling.plan_slug,
               sibling.spec_id, sibling.spec_revision, sibling.evidence_kind, sibling.evidence_ref,
               sibling.subject,
               CASE WHEN superseding.id IS NULL THEN 'superseding-binding-not-live'
                    WHEN sibling.subject IS DISTINCT FROM superseding.subject THEN 'different-subject'
                    WHEN sibling.targeted IS NOT NULL
                         AND sibling.targeted IS DISTINCT FROM superseding.targeted THEN 'different-target'
                    WHEN NOT (sibling.causal_pair_ids <@ superseding.causal_pair_ids)
                      THEN 'different-causal-pairs'
               END AS keep_reason
          FROM requested
          JOIN clause_rows sibling
            ON sibling.plan_slug = requested.plan_slug
           AND sibling.spec_id = requested.spec_id
           AND sibling.spec_revision = requested.spec_revision
           AND sibling.evidence_kind = requested.evidence_kind
          LEFT JOIN superseding ON superseding.input_ordinal = requested.input_ordinal
         WHERE NOT (sibling.id = ANY(requested.keep_binding_ids))
      ), eligible_retractions AS (
        SELECT id, MIN(input_ordinal) AS input_ordinal
          FROM comparisons
         WHERE keep_reason IS NULL
         GROUP BY id
      ), retracted AS (
        UPDATE harness_shared.spec_evidence_bindings AS binding
           SET retracted_at = now(),
               retracted_by = ${actorId},
               retraction_reason = 'superseded by binding ' || requested.superseding_binding_id::text
                 || ' (plans:bind-spec-evidence supersedeAtRevision)'
          FROM eligible_retractions eligible
          JOIN requested ON requested.input_ordinal = eligible.input_ordinal
         WHERE binding.workspace_id = ${scope.workspaceId}
           AND binding.harness_slug = ${scope.harnessSlug}
           AND binding.id = eligible.id
           AND binding.retracted_at IS NULL
        RETURNING binding.id, binding.work_item_id, binding.plan_slug, binding.spec_id,
                  binding.spec_revision, binding.evidence_kind, binding.evidence_ref,
                  binding.retracted_at, binding.retracted_by, binding.retraction_reason
      ), retracted_with_input AS (
        SELECT eligible.input_ordinal, retracted.*
          FROM retracted
          JOIN eligible_retractions eligible ON eligible.id = retracted.id
      ), kept AS (
        SELECT DISTINCT ON (comparison.input_ordinal, comparison.id)
               comparison.input_ordinal, comparison.id, comparison.work_item_id,
               comparison.plan_slug, comparison.spec_id, comparison.spec_revision,
               comparison.evidence_kind, comparison.evidence_ref, comparison.subject,
               comparison.keep_reason
          FROM comparisons comparison
         WHERE comparison.keep_reason IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM eligible_retractions eligible WHERE eligible.id = comparison.id
           )
         ORDER BY comparison.input_ordinal, comparison.id
      ), combined AS (
        SELECT input_ordinal, 'retracted'::text AS outcome, id, work_item_id, plan_slug,
               spec_id, spec_revision, evidence_kind, evidence_ref, NULL::text AS subject,
               retracted_at, retracted_by, retraction_reason, NULL::text AS keep_reason
          FROM retracted_with_input
        UNION ALL
        SELECT input_ordinal, 'kept'::text AS outcome, id, work_item_id, plan_slug,
               spec_id, spec_revision, evidence_kind, evidence_ref, subject,
               NULL::timestamptz AS retracted_at, NULL::text AS retracted_by,
               NULL::text AS retraction_reason, keep_reason
          FROM kept
      )
      SELECT input_ordinal, outcome, id, work_item_id, plan_slug, spec_id, spec_revision,
             evidence_kind, evidence_ref, subject, retracted_at, retracted_by,
             retraction_reason, keep_reason
        FROM combined
       ORDER BY input_ordinal, outcome, id`;
    const retractedRows = rows.filter((row) => row.outcome === 'retracted');
    const cancelledAuditIssueIds = retractedRows.length > 0
      ? [...new Set(await (async () => {
          const { cancelPendingGradingAuditsForBindingInTransaction } = await import('../../scorecards');
          return cancelPendingGradingAuditsForBindingInTransaction(
            tx,
            scope.workspaceId,
            retractedRows.map((row) => Number(row.id)),
          );
        })())].sort()
      : [];
    const results = options.items.map((_, inputOrdinal): SupersessionResult => {
      const retracted: RetractedBindingRow[] = [];
      const kept: SupersessionKeptRow[] = [];
      for (const row of rows) {
        if (row.input_ordinal !== inputOrdinal) continue;
        if (row.outcome === 'retracted') {
          retracted.push({
            id: Number(row.id),
            work_item_id: row.work_item_id,
            plan_slug: row.plan_slug,
            spec_id: row.spec_id,
            spec_revision: row.spec_revision,
            evidence_kind: row.evidence_kind,
            evidence_ref: row.evidence_ref,
            retracted_at: row.retracted_at,
            retracted_by: row.retracted_by,
            retraction_reason: row.retraction_reason,
          });
        } else if (row.keep_reason) {
          kept.push({
            id: Number(row.id),
            work_item_id: row.work_item_id,
            evidence_ref: row.evidence_ref,
            subject: row.subject ?? row.evidence_ref,
            keep_reason: row.keep_reason,
          });
        }
      }
      return { retracted, kept };
    });
    return { results, cancelledAuditIssueIds };
  });
  if (result.cancelledAuditIssueIds.length > 0) {
    const supersedingIds = options.items.map((item) => item.supersedingBindingId);
    await notifyCancelledAuditorsAfterCommit({
      workspaceId: scope.workspaceId,
      harnessSlug: scope.harnessSlug,
      issueIds: result.cancelledAuditIssueIds,
      reason: supersedingIds.length === 1
        ? 'spec evidence was superseded by binding ' + supersedingIds[0]
        : 'spec evidence was superseded by bindings ' + supersedingIds.join(', '),
    }, deps);
  }
  if (result.results.some((entry) => entry.retracted.length > 0)) {
    void trackDetached(import('../../sync-sse'))
      .then((m) => {
        m.notifySyncInvalidate('scorecards.list');
        m.notifySyncInvalidate('rubrics.trend');
        m.notifySyncInvalidate('learning.releaseReadiness');
      })
      .catch(() => {});
  }
  return result;
}

/**
 * Strip only inert description/guidance properties of a direct imported defineTool.
 * Everything outside those spans remains byte-identical. Dynamic metadata, root
 * spreads, duplicate properties and parse errors fail closed. This classifies a
 * completed native journey; it never changes the measured raw source fingerprint.
 */
export function agentToolRuntimeSourceWithoutStaticGuidance(source: string): string | null {
  const file = ts.createSourceFile('tool.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((file as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length) return null;
  const importsDefineTool = file.statements.some(statement => ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === '@papercusp/agent-mcp'
    && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
    && statement.importClause.namedBindings.elements.some(element => element.name.text === 'defineTool'
      && (!element.propertyName || element.propertyName.text === 'defineTool')));
  const exports = file.statements.filter(ts.isExportAssignment);
  if (!importsDefineTool || exports.length !== 1 || exports[0].isExportEquals) return null;
  const expression = exports[0].expression;
  if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)
    || expression.expression.text !== 'defineTool' || expression.arguments.length !== 1
    || !ts.isObjectLiteralExpression(expression.arguments[0])) return null;
  const object = expression.arguments[0];
  const key = (node: ts.PropertyName | undefined): string | null => node
    && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : null;
  const keys = object.properties.map(property => ts.isSpreadAssignment(property) ? null : key(property.name));
  if (keys.includes(null) || new Set(keys).size !== keys.length) return null;
  const staticString = (node: ts.Expression): boolean => ts.isStringLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node)
    || ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
      && staticString(node.left) && staticString(node.right);
  const staticValue = (node: ts.Expression): boolean => staticString(node)
    || ts.isArrayLiteralExpression(node) && node.elements.every(element => staticString(element));
  const metadata = object.properties.filter(property => !ts.isSpreadAssignment(property)
    && ['description', 'guidance'].includes(key(property.name) ?? ''));
  if (metadata.length !== 2) return null;
  for (const property of metadata) {
    if (!ts.isPropertyAssignment(property)) return null;
    if (key(property.name) === 'description') {
      if (!staticString(property.initializer)) return null;
    } else {
      if (!ts.isObjectLiteralExpression(property.initializer)) return null;
      const guidanceKeys = property.initializer.properties.map(entry => ts.isSpreadAssignment(entry) ? null : key(entry.name));
      if (new Set(guidanceKeys).size !== guidanceKeys.length
        || !property.initializer.properties.every(entry => ts.isPropertyAssignment(entry)
          && ['when', 'notWhen', 'chaining', 'returns', 'seeAlso'].includes(key(entry.name) ?? '')
          && staticValue(entry.initializer))) return null;
    }
  }
  let stripped = source;
  for (const property of [...metadata].sort((a, b) => b.pos - a.pos)) {
    const end = source[property.end] === ',' ? property.end + 1 : property.end;
    stripped = stripped.slice(0, property.getFullStart()) + stripped.slice(end);
  }
  return stripped;
}

async function onlyStaticToolGuidanceChanged(root: string, original: MeasuredRepoFile, current: MeasuredRepoFile): Promise<boolean> {
  if (!original.gitBlob || !current.gitBlob) return false;
  const blobs = await defaultBlobBatchReader(root, [original.gitBlob, current.gitBlob]);
  const before = blobs.get(original.gitBlob), after = blobs.get(current.gitBlob);
  if (!before || !after || createHash('sha256').update(before).digest('hex') !== original.sha256
    || createHash('sha256').update(after).digest('hex') !== current.sha256) return false;
  const beforeRuntime = agentToolRuntimeSourceWithoutStaticGuidance(before.toString('utf8'));
  return beforeRuntime !== null && beforeRuntime === agentToolRuntimeSourceWithoutStaticGuidance(after.toString('utf8'));
}

/** Bounded original receipts outlive the disposable runtime and run-count pruning. */
function completedRuntimeArtifactRefs(selector: NonNullable<RepoFilesEvidenceMeasurement['completedRuntime']>) {
  if (selector.kind === 'isolated-integration') return selector.runIds.flatMap(runId => [
    ['isolated-integration', runId, 'result.json'],
    ['isolated-integration', runId, 'phases/prepare/source.json'],
    ['isolated-integration', runId, 'phases/execute/lifecycle.json'],
  ] as const);
  return selector.kind === 'verification-harness' ? [
    ['verify-tauri-headless', selector.verifierRunId, 'result.json'],
    ['verify-tauri-headless', selector.verifierRunId, 'phases/prepare/verifier-source-receipt.json'],
    ...(selector.journeyHarness === 'verify-tauri-headless' ? [] : [
      [selector.journeyHarness, selector.journeyRunId, 'result.json'] as const,
    ]),
    ...(['operator-e2e-isolated', 'verify-tauri-headless'].includes(selector.journeyHarness) ? [] : [
      [selector.journeyHarness, selector.journeyRunId, 'phases/native/manifest.json'] as const,
    ]),
  ] as const : [];
}

/**
 * Bind-time coverage fence for isolated integration source receipts. A missing artifact
 * remains a legacy unknown (the read-side certifier will fail closed); once a receipt is
 * available, however, every explicit source path must be represented in that receipt before
 * a binding can claim the completed runtime. This catches hand-built recipes that otherwise
 * pin a null environment fingerprint and only surface the gap during a later read.
 */
async function isolatedIntegrationSourceReceiptGaps(
  recipe: RepoFilesEvidenceMeasurement,
): Promise<Array<{ runId: string; missingSourcePaths: string[] }>> {
  const selector = recipe.completedRuntime;
  if (selector?.kind !== 'isolated-integration') return [];
  const gaps: Array<{ runId: string; missingSourcePaths: string[] }> = [];
  await Promise.all(selector.runIds.map(async (runId) => {
    let receipt: unknown;
    try {
      receipt = (await readCompletedRuntimeArtifact(
        'isolated-integration', runId, 'phases/prepare/source.json',
      )).data;
    } catch {
      // Preserve the pre-existing read-side behavior for missing/expired artifacts. A
      // receipt that is present is still checked below; the certifier keeps absent
      // artifacts fail-closed as unknown.
      return;
    }
    const files = receipt && typeof receipt === 'object' && !Array.isArray(receipt)
      ? (receipt as Record<string, unknown>).files
      : undefined;
    if (!Array.isArray(files)) return;
    const recordedPaths = new Set(
      files.flatMap((file) => {
        if (!file || typeof file !== 'object' || Array.isArray(file)) return [];
        const path = (file as Record<string, unknown>).path;
        return typeof path === 'string' ? [path] : [];
      }),
    );
    const missingSourcePaths = recipe.sourcePaths.filter((path) => !recordedPaths.has(path));
    if (missingSourcePaths.length > 0) gaps.push({ runId, missingSourcePaths });
  }));
  return gaps.sort((a, b) => a.runId.localeCompare(b.runId));
}

async function readCompletedRuntimeArtifact(harness: string, runId: string, file: string) {
  // EI-25420516419064831: reuse the maintained driver's existing root contract;
  // measurement selectors still cannot supply an arbitrary filesystem path.
  const roots = [defaultEvidenceRoot(harness)];
  if (harness === 'operator-e2e-isolated') roots.push(
    process.env.OPERATOR_E2E_HARNESS_EVIDENCE_ROOT?.trim() || '/tmp/pcv/operator-e2e-isolated');
  // The offload default selects storage for NEW runs; original retained proof
  // stays in the prior home-state root. Read that bounded historical location
  // only for implicit defaults, preserving explicit caller storage boundaries.
  if (!process.env.VH_EVIDENCE_ROOT_BASE?.trim() && !process.env.XDG_STATE_HOME?.trim()) {
    roots.push(legacyEvidenceRoot(harness));
  }
  for (const root of [...new Set(roots)]) {
    let base: string, path: string;
    try {
      base = await realpath(root);
      try { path = await realpath(join(base, runId, file)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        path = await realpath(join(base, 'retained', runId, file));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      continue;
    }
    if (relative(base, path).startsWith('..') || isAbsolute(relative(base, path))) throw new Error('artifact outside harness');
    const info = await stat(path);
    if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('invalid harness artifact');
    const bytes = await readFile(path);
    if (bytes.length > 16 * 1024 * 1024) throw new Error('invalid harness artifact');
    return { base, bytes, data: JSON.parse(bytes.toString('utf8')) };
  }
  throw new Error('completed runtime artifact missing');
}

/** Extend existing proof pinning; retain receipt bytes, rather than whole multi-GB verifier runs. */
async function retainCompletedRuntimeArtifacts(recipe: RepoFilesEvidenceMeasurement) {
  if (!recipe.completedRuntime) return;
  await Promise.all(completedRuntimeArtifactRefs(recipe.completedRuntime).map(async ([harness, runId, file]) => {
    const { base, bytes } = await readCompletedRuntimeArtifact(harness, runId, file);
    const destination = join(base, 'retained', runId, file);
    await mkdir(dirname(destination), { recursive: true });
    const parent = await realpath(dirname(destination));
    if (relative(base, parent).startsWith('..') || isAbsolute(relative(base, parent))) throw new Error('artifact outside harness');
    try { await writeFile(destination, bytes, { flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existingPath = await realpath(destination);
      if (relative(base, existingPath).startsWith('..') || isAbsolute(relative(base, existingPath))) throw new Error('artifact outside harness');
      const existing = await readFile(destination);
      if (!existing.equals(bytes)) throw new Error('retained harness artifact changed');
    }
  }));
}

/**
 * Rows whose recorded test execution completed-runtime certification may re-verify: the
 * implementer's `test` row, an operational/check observation carrying the same test
 * receipt, and an `independent-verification` row re-observing that run (EI-25847620673275477).
 * Every kind must still pass the original ledger, source, scope and lifecycle checks.
 * bindSpecEvidence admits independent verification only with source and environment
 * fingerprints equal to the cited row's, carrying its run, plane and identity.
 */
function certifiesCompletedTestRow(kind: string): boolean {
  return kind === 'test' || kind === 'check' || kind === 'operational'
    || kind === 'independent-verification';
}

/** Resolve legacy isolated bindings from their original ledger, without rewriting a recipe or any pin. */
function completedTestRuntimeRecipe(row: EvidenceRow, recipe: RepoFilesEvidenceMeasurement): RepoFilesEvidenceMeasurement | null {
  if (recipe.completedRuntime) return recipe;
  const execution = parseTestRunExecutionDetails(row.test_run_execution_details);
  const runIds = execution?.isolatedRuntimeReceipts?.map(receipt => receipt.runId).sort();
  if (!runIds || !recipe.runtimeUnits
    || JSON.stringify([...recipe.runtimeUnits].sort()) !== JSON.stringify(runIds.map(id => `isolated-integration:${id}`))) return null;
  // The existing certifier still verifies original hashes, Git objects, scope,
  // intervals and teardown. An explicit selector is authoritative, and no
  // selector can turn a completed test into a current deployed runtime.
  return { ...recipe, completedRuntime: { kind: 'isolated-integration', runIds } };
}

/**
 * A disposed verifier cannot be re-probed through /proc. Certify its completed
 * execution from the retained harness lifecycle and independently rehashed source
 * instead. This applies only to clean test receipts on their supported evidence
 * planes; it never certifies a serving/deployed production process.
 */
function completedNativeMutationCalibration(row: EvidenceRow,
  execution: ReturnType<typeof parseTestRunExecutionDetails>, currentFiles: readonly MeasuredRepoFile[]) {
  const baseline = parseTestRunExecutionDetails(row.mutation_baseline_execution_details);
  const mutation = execution?.mutation, calibration = baseline?.mutation;
  const witness = stableRecordedRuntimeEnvironment(execution?.runtimeEnvironmentBefore, execution?.runtimeEnvironmentAfter);
  const baselineWitness = stableRecordedRuntimeEnvironment(baseline?.runtimeEnvironmentBefore, baseline?.runtimeEnvironmentAfter);
  if (!execution || !baseline || !mutation || !calibration || !witness || !baselineWitness
    || row.evidence_kind !== 'mutation' || row.test_run_source !== 'mutation-probe'
    || row.test_run_status !== 'fail' || !row.test_run_present
    || !row.mutation_baseline_id || Number(row.mutation_baseline_id) === Number(row.test_run_id)
    || row.mutation_baseline_status !== 'pass'
    || mutation.mode !== 'copy-out' || mutation.leg !== 'mutant' || execution.mutationPhase !== 'mutant'
    || calibration.leg !== 'copy-baseline' || baseline.mutationPhase !== 'copy-baseline'
    || baseline.worktreeDirty || baseline.collectionFailed || baseline.failed !== 0 || baseline.skipped !== 0 || baseline.passed < 1
    || execution.failed < 1 || execution.skipped !== 0 || execution.collectionFailed
    || baseline.commitSha !== execution.commitSha || baseline.root !== execution.root
    || baseline.filePath !== execution.filePath || baseline.testLayer !== execution.testLayer
    || baseline.workspaceId !== execution.workspaceId || baseline.harnessSlug !== execution.harnessSlug
    || baseline.testNamePattern !== execution.testNamePattern
    || witness.fingerprint !== baselineWitness.fingerprint
    || JSON.stringify([...witness.units].sort()) !== JSON.stringify([...baselineWitness.units].sort())
    || mutation.subjectBeforeSha256 === mutation.subjectAfterSha256
    || !currentFiles.some(file => file.dimension === 'source' && file.path === mutation.subjectPath
      && file.sha256 === mutation.subjectBeforeSha256)
    || !currentFiles.some(file => file.dimension === 'test' && file.path === execution.filePath
      && file.sha256 === mutation.testFileSha256)
    || Object.keys(mutation).some(key => key !== 'leg' && JSON.stringify(mutation[key as keyof typeof mutation])
      !== JSON.stringify(calibration[key as keyof typeof calibration]))
    || Object.keys(calibration).some(key => key !== 'leg' && !(key in mutation))
    || execution.failedCaseTitles?.length !== execution.failed
    || baseline.passedCaseTitles?.length !== baseline.passed
    || execution.failedCaseTitles.some(title => !hasMatchingDeclaredCaseTitle(title, baseline.passedCaseTitles!))) return null;
  const before = Date.parse(baseline.runtimeEnvironmentBefore!.observedAt);
  const after = Date.parse(baseline.runtimeEnvironmentAfter!.observedAt);
  const mutantBefore = Date.parse(execution.runtimeEnvironmentBefore!.observedAt);
  return Number.isFinite(before) && before <= after && after <= mutantBefore ? baseline : null;
}

export interface CompletedRuntimeRefusal {
  category: 'selector-mismatch' | 'execution-ineligible' | 'runtime-witness-missing-or-unstable'
    | 'invalid-test-interval' | 'unproven-case-selection' | 'retained-evidence-ineligible'
    | 'lifecycle-mismatch' | 'source-population-mismatch' | 'source-receipt-mismatch'
    | 'unqualified-source' | 'source-drift' | 'retained-evidence-unavailable';
  paths?: string[];
  pathCount?: number;
  omittedPathCount?: number;
}

export async function measureCompletedTestRuntime(
  row: EvidenceRow,
  recipe: RepoFilesEvidenceMeasurement,
  currentFiles: readonly MeasuredRepoFile[],
  scope: { workspaceId: string; harnessSlug: string },
  root: string,
  options: {
    onStaticGuidanceEquivalence?: (value: StaticGuidanceSourceEquivalence) => void;
    onRefusal?: (value: CompletedRuntimeRefusal) => void;
  } = {},
): Promise<string | null> {
  const refuse = (category: CompletedRuntimeRefusal['category'], paths?: string[]): null => {
    const unique = paths ? [...new Set(paths)].sort() : undefined;
    options.onRefusal?.({ category, ...(unique ? {
      paths: unique.slice(0, 20).map(path => path.slice(0, 240)),
      pathCount: unique.length, omittedPathCount: Math.max(0, unique.length - 20),
    } : {}) });
    return null;
  };
  const selector = recipe.completedRuntime;
  if (selector?.kind === 'isolated-integration') return measureCompletedIntegrationRuntime(row, recipe, currentFiles, scope, root);
  const directVerifier = selector?.kind === 'verification-harness'
    && selector.journeyHarness === 'verify-tauri-headless';
  const operatorE2e = selector?.kind === 'verification-harness'
    && selector.journeyHarness === 'operator-e2e-isolated';
  // The maintained verifier can execute a Vitest assertion directly. Its
  // original native witness and its own source/lifecycle receipts are the
  // journey; shared staging receipts cannot acquire that provenance later.
  if (directVerifier && (selector.journeyRunId !== selector.verifierRunId
    || recipe.runtimeUnits?.length !== 1
    || !/^verify-tauri-headless:[1-9]\d*$/.test(recipe.runtimeUnits[0]))) return refuse('selector-mismatch');
  const execution = parseTestRunExecutionDetails(row.test_run_execution_details);
  const witness = stableRecordedRuntimeEnvironment(
    execution?.runtimeEnvironmentBefore, execution?.runtimeEnvironmentAfter);
  // A caught mutant is an expected failed assertion, never a passing test. Its
  // original runtime can still be measured, but only with the same invocation's
  // passing copy calibration, unchanged test/source pins and stable witnesses.
  const mutationCalibration = directVerifier
    ? completedNativeMutationCalibration(row, execution, currentFiles) : null;
  // Guarded fromTestRun adoption changes ledger attribution, not the original
  // captured receipt. The scoped join proves adoption; foreign, CI/admin and
  // still-unscoped rows cannot certify an originally NULL-harness LLM witness.
  const executionHarnessMatches = execution?.harnessSlug === scope.harnessSlug
    || (selector?.kind === 'llm-in-process' && execution?.harnessSlug === null
      && row.test_run_present
      && (row.test_run_source === 'local' || row.test_run_source === 'mutation-probe'));
  if (!selector || !recipe.runtimeUnits || !(certifiesCompletedTestRow(row.evidence_kind) || mutationCalibration)
    // Owned verifier executions can support tree clauses too. Their recorded
    // witness, immutable source and complete lifecycle must still certify them.
    || (row.details.evidencePlane !== 'live' && !((directVerifier || operatorE2e) && row.details.evidencePlane === 'tree'))
    || (row.test_run_status !== 'pass' && !mutationCalibration)
    || !(selector.kind === 'llm-in-process' ? row.test_run_framework === 'llm-test'
      : selector.kind === 'verification-harness' ? ['vitest', 'playwright'].includes(row.test_run_framework ?? '')
      : row.test_run_framework === 'vitest')
    || row.test_run_worktree_dirty !== false
    || !execution || !(directVerifier
      ? row.test_run_framework === 'vitest' && ['integration', 'e2e'].includes(execution.testLayer ?? '')
      : execution.testLayer === (selector.kind === 'llm-in-process' ? 'llm' : 'e2e'))
    || execution.worktreeDirty
    || execution.collectionFailed || (!directVerifier && execution.skipped !== 0)
    || (!mutationCalibration && (execution.failed !== 0 || execution.passed < 1))
    || execution.workspaceId !== scope.workspaceId || !executionHarnessMatches
    || !execution.commitSha || !/^[a-f0-9]{40,64}$/.test(execution.commitSha)
    || execution.commitSha !== row.test_run_commit_sha || !witness
    || JSON.stringify([...witness.units].sort()) !== JSON.stringify([...recipe.runtimeUnits].sort())
    || !recipe.testPaths?.includes(execution.filePath)
    || recipe.rootHarnessSlug || recipe.fixtureRootHarnessSlug)
    return refuse(!witness ? 'runtime-witness-missing-or-unstable' : 'execution-ineligible');
  const instant = (value: unknown): number =>
    value instanceof Date || typeof value === 'string' ? new Date(value).getTime() : NaN;
  const before = instant(execution.runtimeEnvironmentBefore!.observedAt);
  const after = instant(execution.runtimeEnvironmentAfter!.observedAt);
  const start = instant(row.test_run_started_at);
  const end = instant(row.test_run_finished_at);
  if (![before, after, start, end].every(Number.isFinite)
    || before > start || start > end || end > after) return refuse('invalid-test-interval');
  // Focused native runs collect excluded cases as skips. The complete case
  // ledger must prove they were outside the selector and every selected case passed.
  if (directVerifier && execution.skipped !== 0
    && !await hasLedgerProvenPassingSelection(row, execution, scope.workspaceId)) return refuse('unproven-case-selection');
  if (selector.kind === 'llm-in-process') {
    try {
      // The original recorder measured these kernel pins while the process was
      // live. Reproduce THAT witness, then independently compare today's files
      // with the executed Git objects. This proves completed source execution,
      // without claiming that its PID or a serving deployment is still alive.
      const rows = await listRuntimeVintage(scope.workspaceId);
      const pins: Array<[string, string, string, string, number, string]> = [];
      for (const unit of [...recipe.runtimeUnits].sort()) {
        const matches = rows.filter(runtime => runtime.unit === unit && runtime.host === hostname());
        if (matches.length !== 1) return null;
        const runtime = matches[0];
        const kernel = runtime.extra.kernelProcessIdentity;
        const built = instant(runtime.buildTime), reported = instant(runtime.reportedAt);
        if (!Number.isSafeInteger(runtime.pid) || runtime.pid! <= 0
          || unit !== `llm-test-in-process-${runtime.pid}` || runtime.workspaceId !== scope.workspaceId
          || runtime.treeSha !== execution.commitSha || runtime.bundleVersion !== null
          || typeof kernel !== 'string' || !kernel
          || !Number.isFinite(built) || !Number.isFinite(reported)
          || built > reported || reported > before) return null;
        pins.push([unit, runtime.host, runtime.treeSha, new Date(built).toISOString(), runtime.pid!, kernel]);
      }
      // Same normalized pin contract written by measureRuntimeVintageEnvironment.
      if (createHash('sha256').update(JSON.stringify(pins)).digest('hex') !== witness.fingerprint) return null;
      const recorded = await measureRepoFilesEvidenceDetailedAtCommit(root, recipe, execution.commitSha);
      const original = new Map(recorded.files.map(file => [`${file.dimension}:${file.path}`, file.sha256]));
      if (currentFiles.length === 0 || currentFiles.length !== recorded.files.length
        || currentFiles.some(file => original.get(`${file.dimension}:${file.path}`) !== file.sha256)) return null;
      return witness.fingerprint;
    } catch { return null; }
  }
  try {
    const verifierSourceJourney = operatorE2e || directVerifier;
    const [verifier, receipt, journeyArtifact, manifest] = await Promise.all(
      completedRuntimeArtifactRefs(selector).map(async ([harness, runId, file]) =>
        (await readCompletedRuntimeArtifact(harness, runId, file)).data));
    const journey = directVerifier ? verifier : journeyArtifact;
    const completed = (result: any, harness: string, runId: string) => result?.schemaVersion === 1
      && result.harness === harness && result.runId === runId && result.verdict === 'pass'
      && !result.reuseFromRunId && Array.isArray(result.phases) && result.phases.length > 0
      && result.phases.every((phase: any) => phase.status === 'passed');
    if (!completed(verifier, 'verify-tauri-headless', selector.verifierRunId)
      || !completed(journey, selector.journeyHarness, selector.journeyRunId)
      || receipt?.schemaVersion !== 'verifier-source-v1' || receipt.sourceCommit !== execution.commitSha
      || !Array.isArray(receipt.files) || !Array.isArray(receipt.testedInputs)
      || !receipt.testedInputs.some((file: any) => file.path === execution.filePath)
      || (!verifierSourceJourney && (manifest?.result !== 'pass' || !Array.isArray(manifest.sourceFingerprints)
        || manifest.sourceFingerprints.length === 0))) return refuse('retained-evidence-ineligible');
    const phase = (name: string) => {
      const matches = verifier.phases.filter((entry: any) => entry.phase === name);
      return matches.length === 1 ? matches[0] : null;
    };
    const prepare = phase('prepare'), boot = phase('boot'), assertions = phase('assert');
    if (mutationCalibration && (!boot || !assertions
      || instant(boot.endedAt) > instant(mutationCalibration.runtimeEnvironmentBefore!.observedAt)
      || instant(assertions.startedAt) > instant(mutationCalibration.runtimeEnvironmentBefore!.observedAt))) return refuse('lifecycle-mismatch');
    // Reporter intervals derive from measured duration and can round before
    // the harness writes its completion receipt. The original paired runtime
    // observations bracket the actual test lifetime; use those exact bounds
    // for the journey, while preserving the reporter interval checks above.
    const journeyStart = instant(journey.startedAt), journeyEnd = instant(journey.endedAt);
    if (!prepare || !boot || !assertions
      || !(instant(prepare.endedAt) <= instant(boot.startedAt)
        && instant(boot.endedAt) <= before && instant(assertions.startedAt) <= before
        && instant(assertions.endedAt) >= after)) return refuse('lifecycle-mismatch');
    if (directVerifier) {
      if (!(instant(verifier.startedAt) <= instant(prepare.startedAt)
        && instant(assertions.endedAt) <= instant(verifier.endedAt))) return refuse('lifecycle-mismatch');
    } else if (operatorE2e) {
      // This driver wraps preparation, boot, assertions and teardown. Its
      // interval encloses the verifier, while the original paired observations
      // bracket the test inside that verifier's assertion phase.
      const phases = (name: string) => journey.phases.filter((entry: any) => entry.phase === name);
      const preflight = phases('preflight'), suite = phases('isolated-suite');
      if (preflight.length !== 1 || suite.length !== 1
        || !(journeyStart <= instant(preflight[0].startedAt)
          && instant(preflight[0].startedAt) <= instant(preflight[0].endedAt)
          && instant(preflight[0].endedAt) <= instant(suite[0].startedAt)
          && instant(suite[0].startedAt) <= instant(verifier.startedAt)
          && instant(verifier.startedAt) <= instant(prepare.startedAt)
          && instant(assertions.endedAt) <= instant(verifier.endedAt)
          && instant(verifier.endedAt) <= instant(suite[0].endedAt)
          && instant(suite[0].endedAt) <= journeyEnd)) return refuse('lifecycle-mismatch');
    } else if (!(before <= journeyStart && journeyStart <= journeyEnd && journeyEnd <= after)) return refuse('lifecycle-mismatch');
    // A retained JSON receipt alone is not code identity. Read the immutable Git
    // objects too, then compare each current source/test/fixture byte measurement.
    const recorded = await measureRepoFilesEvidenceDetailedAtCommit(root, recipe, execution.commitSha);
    const recordedFiles = new Map(recorded.files.map(file => [`${file.dimension}:${file.path}`, file]));
    const receiptFiles = new Map(receipt.files.map((file: any) => [file.path, file.sha256]));
    const journeyFiles = new Map((verifierSourceJourney ? receipt.testedInputs : manifest.sourceFingerprints)
      .map((file: any) => [file.path, file.sha256]));
    const guidanceChanged: string[] = [];
    if (currentFiles.length === 0 || currentFiles.length !== recorded.files.length) return refuse('source-population-mismatch');
    const unqualifiedPaths = currentFiles.filter(file => {
      const original = recordedFiles.get(`${file.dimension}:${file.path}`);
      return original && (verifierSourceJourney || file.dimension === 'source' && !file.path.startsWith('scripts/'))
        && journeyFiles.get(file.path) !== original.sha256;
    }).map(file => file.path);
    for (const file of currentFiles) {
      const original = recordedFiles.get(`${file.dimension}:${file.path}`);
      if (!original || receiptFiles.get(file.path) !== original.sha256)
        return refuse('source-receipt-mismatch', [file.path]);
      if ((verifierSourceJourney || file.dimension === 'source' && !file.path.startsWith('scripts/'))
        && journeyFiles.get(file.path) !== original.sha256) return refuse('unqualified-source', unqualifiedPaths);
      if (file.sha256 !== original.sha256 && !(file.dimension === 'source'
        && selector.guidanceOnlySourcePaths?.includes(file.path)
        && await onlyStaticToolGuidanceChanged(root, original, file))) return refuse('source-drift', [file.path]);
      if (file.sha256 !== original.sha256) guidanceChanged.push(file.path);
    }
    if (guidanceChanged.length && recorded.sourceFingerprint === row.source_fingerprint) {
      options.onStaticGuidanceEquivalence?.({ kind: 'static-agent-tool-guidance', paths: guidanceChanged.sort(),
        storedFingerprint: recorded.sourceFingerprint,
        measuredFingerprint: repoFileSetFingerprint(currentFiles.filter(file => file.dimension === 'source')) });
    }
    return witness.fingerprint;
  } catch { return refuse('retained-evidence-unavailable'); }
}

function isolatedIntegrationFingerprint(receipts: NonNullable<ReturnType<typeof parseTestRunExecutionDetails>>['isolatedRuntimeReceipts']): string {
  return createHash('sha256').update(JSON.stringify([...receipts!].sort((a, b) => a.runId.localeCompare(b.runId)))).digest('hex');
}

/** Certify the original mid-test lifetime, never the current serving host or retrofitted stdout. */
async function measureCompletedIntegrationRuntime(row: EvidenceRow, recipe: RepoFilesEvidenceMeasurement,
  currentFiles: readonly MeasuredRepoFile[], scope: { workspaceId: string; harnessSlug: string }, root: string): Promise<string | null> {
  const execution = parseTestRunExecutionDetails(row.test_run_execution_details);
  const selector = recipe.completedRuntime;
  // The scoped ledger lookup proves any adoption into this harness. Preserve
  // the original NULL in the hashed receipt, and never adopt CI/admin evidence.
  const isolatedHarnessMatches = execution?.harnessSlug === scope.harnessSlug
    || (execution?.harnessSlug === null && row.test_run_present
      && (row.test_run_source === 'local' || row.test_run_source === 'mutation-probe'));
  // A completed private runtime can prove committed-tree behavior as well as
  // a live test. Its receipts never establish the currently deployed artifact.
  const evidencePlane = readSpecEvidencePlane(row.details);
  const completedTestPlane = evidencePlane === 'tree' || evidencePlane === 'live';
  if (selector?.kind !== 'isolated-integration' || !execution?.isolatedRuntimeReceipts || !recipe.runtimeUnits
    || !row.test_run_present
    || !certifiesCompletedTestRow(row.evidence_kind) || !completedTestPlane || row.test_run_status !== 'pass'
    || row.test_run_framework !== 'vitest' || (execution.testLayer !== 'integration' && execution.testLayer !== 'e2e')
    || row.test_run_worktree_dirty !== false || execution.worktreeDirty || execution.collectionFailed
    || execution.failed !== 0 || execution.passed < selector.runIds.length
    || execution.workspaceId !== scope.workspaceId || !isolatedHarnessMatches
    || !execution.commitSha || !/^[a-f0-9]{40,64}$/.test(execution.commitSha)
    || execution.commitSha !== row.test_run_commit_sha || !recipe.testPaths?.includes(execution.filePath)
    || recipe.rootHarnessSlug || recipe.fixtureRootHarnessSlug
    || JSON.stringify([...selector.runIds].sort()) !== JSON.stringify(execution.isolatedRuntimeReceipts.map(r => r.runId).sort())
    || JSON.stringify([...recipe.runtimeUnits].sort()) !== JSON.stringify(selector.runIds.map(id => `isolated-integration:${id}`).sort())) return null;
  const at = (value: any) => new Date(value).getTime();
  const start = at(row.test_run_started_at), end = at(row.test_run_finished_at);
  if (![start, end].every(Number.isFinite) || start > end) return null;
  try {
    if (execution.skipped !== 0 || execution.passed !== selector.runIds.length) {
      // A focused Vitest run records excluded cases as skips. Certify only
      // when the case ledger proves every skip was outside the actual filter;
      // a selected skip or missing case ledger remains unverified. Several
      // passing cases may share one original lifetime, but their complete
      // passing case ledger must still corroborate the execution counts.
      if (!await hasLedgerProvenPassingSelection(row, execution, scope.workspaceId)) return null;
    }
    const recorded = await measureRepoFilesEvidenceDetailedAtCommit(root, recipe, execution.commitSha);
    const originals = new Map(recorded.files.map(file => [`${file.dimension}:${file.path}`, file]));
    if (!currentFiles.length || currentFiles.length !== recorded.files.length
      || currentFiles.some(file => originals.get(`${file.dimension}:${file.path}`)?.sha256 !== file.sha256)) return null;
    for (const original of execution.isolatedRuntimeReceipts) {
      const artifacts = await Promise.all(['result.json', 'phases/prepare/source.json', 'phases/execute/lifecycle.json']
        .map(file => readCompletedRuntimeArtifact('isolated-integration', original.runId, file)));
      const expected = [original.resultSha256, original.sourceSha256, original.lifecycleSha256];
      if (artifacts.some((artifact, i) => createHash('sha256').update(artifact.bytes).digest('hex') !== expected[i])) return null;
      const [result, source, life] = artifacts.map(a => a.data);
      const phases = result?.phases;
      if (result?.schemaVersion !== 1 || result.harness !== 'isolated-integration' || result.runId !== original.runId
        || result.verdict !== 'pass' || result.reuseFromRunId || result.preflight?.status === 'failed'
        || !Array.isArray(phases) || phases.length !== 3
        || JSON.stringify(phases.map((p: any) => p.phase)) !== JSON.stringify(['prepare', 'execute', 'teardown'])
        || phases.some((p: any) => p.status !== 'passed' || p.reusedFromRunId)
        || source?.schemaVersion !== 1 || source.runId !== original.runId || source.sourceCommit !== execution.commitSha
        || typeof source.repoRoot !== 'string' || !isAbsolute(source.repoRoot)
        || source.filePath !== execution.filePath || source.runGroupId !== execution.runGroupId
        || source.workspaceId !== execution.workspaceId || source.harnessSlug !== execution.harnessSlug
        || !Array.isArray(source.files) || new Set(source.files.map((f: any) => f.path)).size !== source.files.length
        || recorded.files.some(file => !source.files.some((f: any) => f.path === file.path && f.sha256 === file.sha256 && f.gitSha256 === file.sha256))
        || life?.schemaVersion !== 1 || life.runId !== original.runId || life.host !== hostname()
        || life.cwd !== source.repoRoot || !/^test-runtime-/.test(life.workspace)
        || typeof life.runtimeRoot !== 'string' || !basename(life.runtimeRoot).startsWith('papercusp-test-runtime-')
        || typeof life.dataDir !== 'string' || !basename(life.dataDir).startsWith('papercusp-test-pg-')
        || !Number.isInteger(life.pgPort) || life.pgPort <= 0 || life.pgPort === 5432
        || !Array.isArray(life.argv) || !life.argv.length
        || [life.observer, life.supervisor, life.worker, life.database].some(pin => !Number.isSafeInteger(pin?.pid) || pin.pid <= 0
          || !/^linux:[^:]+:\d+$/.test(pin.identity) || !Number.isSafeInteger(pin.parentPid))
        || life.supervisor.parentPid !== life.observer.pid || life.worker.parentPid !== life.supervisor.pid
        || life.database.parentPid !== life.supervisor.pid
        || !life.ended || life.ended.childPid !== life.worker.pid || life.ended.signal
        || !Number.isInteger(life.ended.exitCode) || !life.ended.runtimeRemoved || !life.ended.pgDataRemoved) return null;
      // The reporter derives its start by subtracting rounded duration from a
      // later completion observation. Harness preparation may already have
      // started on its own clock. Validate that receipt's full internal order,
      // then bind the actual runtime execution and completion to the parent
      // interval; an old execution still cannot be admitted by a new test.
      const times = [at(result.startedAt), ...phases.flatMap((p: any) => [at(p.startedAt), at(p.endedAt)]), at(result.endedAt)];
      if (times.some((time, i) => !Number.isFinite(time) || (i > 0 && time < times[i - 1]))
        || at(phases[1].startedAt) < start || at(result.endedAt) > end
        || !(at(phases[1].startedAt) <= at(life.observedAt) && at(life.observedAt) < at(life.ended.observedAt)
          && at(life.ended.observedAt) <= at(phases[1].endedAt))) return null;
    }
    return isolatedIntegrationFingerprint(execution.isolatedRuntimeReceipts);
  } catch { return null; }
}

export async function listSpecEvidence(options: ListSpecEvidenceOptions) {
  const diagnostics = options.diagnostics;
  const metadataOnly = options.measurementMode === 'metadata';
  const committedTree = diagnostics
    ? (diagnostics.committedTree ??= createCommittedTreeDiagnostics())
    : undefined;
  const totalStartedAt = diagnostics ? Date.now() : 0;
  const recordPhase = (name: string, startedAt: number) => {
    if (diagnostics) diagnostics.phaseMs[name] = Math.max(0, Date.now() - startedAt);
  };
  const recordMaxPhase = (name: string, startedAt: number) => {
    if (!diagnostics) return;
    diagnostics.phaseMs[name] = Math.max(
      diagnostics.phaseMs[name] ?? 0,
      Math.max(0, Date.now() - startedAt),
    );
  };
  const recordMeasurementPhase = (name: string, startedAt: number) => {
    if (!diagnostics) return;
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    diagnostics.phaseMs[`${name}TotalMs`] = (diagnostics.phaseMs[`${name}TotalMs`] ?? 0) + elapsedMs;
    diagnostics.phaseMs[`${name}MaxMs`] = Math.max(diagnostics.phaseMs[`${name}MaxMs`] ?? 0, elapsedMs);
  };
  if (options.auditAsOf && options.includeRetracted !== true) {
    throw new Error('auditAsOf requires includeRetracted:true');
  }
  // No namespace selected can never match a row, so say so without a round-trip. Kept
  // explicit rather than leaning on `= ANY('{}')`: a reader must not have to know that
  // Postgres happens to return nothing, and the alternative reading — an empty filter
  // meaning "every plan" — is the exact silent-widening this whole plan exists to remove.
  if (options.planSlugs.length === 0) {
    recordPhase('total', totalStartedAt);
    return [];
  }
  const scopeStartedAt = diagnostics ? Date.now() : 0;
  const scope = await resolvePlanScope({
    harnessSlug: options.harnessSlug,
    workspaceId: options.workspaceId,
  });
  recordPhase('resolvePlanScope', scopeStartedAt);
  const planSlugs = options.planSlugs;
  const workItemIds = options.workItemIds ?? [];
  const specIds = options.specIds ?? [];
  const sourceValIds = options.sourceValIds ?? [];
  const evidenceKinds = options.evidenceKinds ?? [];
  const evidenceRefs = options.evidenceRefs ?? [];
  const bindingIds = options.bindingIds;
  const limit = options.limit ?? 200;
  const includeRetracted = options.includeRetracted === true;
  const auditAsOf = options.auditAsOf ?? null;
  if (options.currentProvenance === 'historical-snapshot' && !auditAsOf) {
    throw new Error('historical-snapshot currentness requires an auditAsOf timestamp');
  }
  const specRevision = options.specRevision;
  const specFingerprint = options.specFingerprint;
  const replayCurrent = Array.isArray(options.current) ? options.current : [];
  // Completion gates can span several clauses, while each scorecard rerun recipe pins one.
  // For a multi-clause replay, current[] already carries the exact tuple per evidence row;
  // preserve those tuples instead of applying one scalar fingerprint to every clause.
  const replayCurrentHasFullClauseIdentity = replayCurrent.length > 0 && replayCurrent.every(
    (current) =>
      typeof current.planSlug === 'string' && current.planSlug.trim() !== '' &&
      typeof current.specId === 'string' && current.specId.trim() !== '' &&
      current.specRevision !== undefined &&
      typeof current.specFingerprint === 'string' && current.specFingerprint.trim() !== '',
  );
  const replayClausePins = replayCurrentHasFullClauseIdentity
    ? [...new Map(replayCurrent.map((current) => {
        const pin = {
          planSlug: current.planSlug!,
          specId: current.specId!,
          specRevision: current.specRevision!,
          specFingerprint: current.specFingerprint!,
        };
        return [JSON.stringify(pin), pin] as const;
      })).values()]
    : [];
  const workspaceReadStartedAt = diagnostics ? Date.now() : 0;
  const rows = await withWorkspace(
    scope.workspaceId,
    async (tx) => {
      const replayClausePinMatch = replayClausePins.length > 0
        ? tx`EXISTS (
            SELECT 1
              FROM unnest(
                ${replayClausePins.map((pin) => pin.planSlug)}::text[],
                ${replayClausePins.map((pin) => pin.specId)}::text[],
                ${replayClausePins.map((pin) => pin.specRevision)}::int[],
                ${replayClausePins.map((pin) => pin.specFingerprint)}::text[]
              ) AS requested(plan_slug, spec_id, spec_revision, spec_fingerprint)
             WHERE requested.plan_slug = b.plan_slug
               AND requested.spec_id = b.spec_id
               AND requested.spec_revision = b.spec_revision
               AND requested.spec_fingerprint = b.spec_fingerprint
          )`
        : undefined;
      const replaySinglePinMatch = specRevision !== undefined
        ? tx`(
            b.spec_revision = ${specRevision}
            AND (${specFingerprint ?? null}::text IS NULL OR b.spec_fingerprint = ${specFingerprint ?? null})
          )`
        : undefined;
      const replaySnapshotMatch = options.replaySnapshot
        ? replaySinglePinMatch ?? replayClausePinMatch ?? tx`FALSE`
        : tx`TRUE`;
      const evidenceClauseFilter = options.replaySnapshot
        ? replaySnapshotMatch
        : tx`(
            (${specRevision ?? null}::int IS NULL OR b.spec_revision = ${specRevision ?? null})
            AND (${specFingerprint ?? null}::text IS NULL OR b.spec_fingerprint = ${specFingerprint ?? null})
          )`;
      const specIsCurrent = options.replaySnapshot
        ? replaySnapshotMatch
        : tx`(b.spec_revision = c.current_revision AND b.spec_fingerprint = r.content_hash)`;
      const bindingIdFilter = bindingIds === undefined
        ? tx`TRUE`
        : tx`b.id = ANY(${bindingIds}::bigint[])`;
      const bindingRowsStartedAt = diagnostics ? Date.now() : 0;
      const rows = await tx<EvidenceRow[]>`
    SELECT b.id, b.work_item_id, b.plan_slug, b.spec_id, c.source_val_id,
           b.spec_revision, c.current_revision, b.spec_fingerprint,
           b.evidence_kind, b.evidence_ref, b.source_fingerprint,
           b.test_fingerprint, b.fixture_fingerprint, b.rubric_fingerprint,
           b.environment_fingerprint, b.coverage_evidence_ref, b.test_run_id, b.verifies_binding_id,
           b.details, b.observed_at, b.binding_fingerprint, b.created_by, b.created_at,
           b.retracted_at, b.retracted_by, b.retraction_reason,
           tr.file_path AS test_run_file_path,
           tr.commit_sha AS test_run_commit_sha,
           tr.worktree_dirty AS test_run_worktree_dirty,
           tr.status AS test_run_status,
           tr.framework AS test_run_framework,
           tr.source AS test_run_source,
           tr.execution_details AS test_run_execution_details,
           tr.started_at AS test_run_started_at,
           tr.finished_at AS test_run_finished_at,
           mutation_baseline.id AS mutation_baseline_id,
           mutation_baseline.status AS mutation_baseline_status,
           mutation_baseline.execution_details AS mutation_baseline_execution_details,
           -- WI-10006745: unconditional, so no adequacy reader (the ship-gate snapshot included)
           -- can forget to ask for it. Bounded by the ledger's own 4000-char tail.
           CASE
             WHEN b.evidence_kind IN ('mutation', 'counterexample')
               AND tr.source = 'mutation-probe'
               AND tr.status = 'fail'
               AND tr.execution_details->>'mutationPhase' = 'mutant'
             THEN tr.output_tail
             ELSE NULL
           END AS mutation_failure_tail,
           CASE
             WHEN b.evidence_kind IN ('mutation', 'counterexample')
               AND tr.source = 'mutation-probe'
               AND tr.status = 'fail'
               AND tr.execution_details->>'mutationPhase' = 'mutant'
             THEN tr.execution_details
             ELSE NULL
           END AS mutation_execution_details,
           ${specIsCurrent} AS spec_is_current,
           r.source_rubric_slug, r.source_rubric_revision, r.source_bar_key,
           (b.coverage_evidence_ref IS NOT NULL AND EXISTS (
              SELECT 1 FROM harness_shared.coverage_evidence ce
              JOIN harness_shared.testing_surfaces s ON s.id = ce.surface_ref
             WHERE ce.id = b.coverage_evidence_ref
               AND s.workspace_id = b.workspace_id AND s.harness_slug = b.harness_slug
           )) AS coverage_evidence_present,
           (b.test_run_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM harness_shared.test_runs tr
               WHERE tr.id = b.test_run_id
                 AND tr.workspace_id = b.workspace_id AND tr.harness_slug = b.harness_slug
           )) AS test_run_present
      FROM harness_shared.spec_evidence_bindings b
      LEFT JOIN harness_shared.test_runs tr
        ON tr.id = b.test_run_id
       AND tr.workspace_id = b.workspace_id AND tr.harness_slug = b.harness_slug
      LEFT JOIN LATERAL (
        SELECT baseline.id, baseline.status, baseline.execution_details
          FROM harness_shared.test_runs baseline
         WHERE b.evidence_kind IN ('mutation', 'counterexample')
           AND tr.source = 'mutation-probe'
           AND tr.execution_details->'mutation'->>'leg' = 'mutant'
           AND baseline.workspace_id = tr.workspace_id
           -- EI-26696103067780835: binding a mutant adopts only that row into the
           -- plan harness; its same-invocation calibration rows can stay harness
           -- NULL. A NULL-harness calibration row from the SAME probe invocation
           -- (same workspace/file/probeInvocationId/subjectBeforeSha256) is the
           -- same measurement, never another harness's evidence, so accept it.
           -- A calibration attributed to a DIFFERENT harness still never matches.
           AND (baseline.harness_slug = tr.harness_slug OR baseline.harness_slug IS NULL)
           AND baseline.file_path = tr.file_path
           AND baseline.source = 'mutation-probe'
           AND baseline.status = 'pass'
           AND baseline.execution_details->'mutation'->>'leg' = ANY(${[...CALIBRATION_LEGS]}::text[])
           AND baseline.execution_details->'mutation'->>'probeInvocationId'
               = tr.execution_details->'mutation'->>'probeInvocationId'
           AND baseline.execution_details->'mutation'->>'subjectBeforeSha256'
               = tr.execution_details->'mutation'->>'subjectBeforeSha256'
         ORDER BY (baseline.harness_slug IS NULL), baseline.id DESC
         LIMIT 1
      ) mutation_baseline ON TRUE
      JOIN harness_shared.plan_spec_clauses c
        ON c.workspace_id = b.workspace_id AND c.harness_slug = b.harness_slug
       AND c.plan_slug = b.plan_slug AND c.spec_id = b.spec_id
      JOIN harness_shared.plan_spec_clause_revisions r
        ON r.workspace_id = b.workspace_id AND r.harness_slug = b.harness_slug
       AND r.plan_slug = b.plan_slug AND r.spec_id = b.spec_id
       AND r.revision = b.spec_revision
     WHERE b.workspace_id = ${scope.workspaceId}
       AND b.harness_slug = ${scope.harnessSlug}
       AND b.plan_slug = ANY(${planSlugs}::text[])
       AND ${evidenceClauseFilter}
       AND (${workItemIds.length} = 0 OR b.work_item_id = ANY(${workItemIds}::text[]))
       AND (${specIds.length} = 0 OR b.spec_id = ANY(${specIds}::text[]))
       AND (${sourceValIds.length} = 0 OR c.source_val_id = ANY(${sourceValIds}::text[]))
       AND (${evidenceKinds.length} = 0 OR b.evidence_kind = ANY(${evidenceKinds}::text[]))
       AND (${evidenceRefs.length} = 0 OR b.evidence_ref = ANY(${evidenceRefs}::text[]))
       AND ${bindingIdFilter}
       AND (${includeRetracted}::boolean IS TRUE OR b.retracted_at IS NULL)
       AND (
         ${auditAsOf}::timestamptz IS NULL
         OR (
           b.created_at <= ${auditAsOf}::timestamptz
           AND (b.retracted_at IS NULL OR b.retracted_at > ${auditAsOf}::timestamptz)
         )
       )
     ORDER BY b.observed_at DESC, b.id DESC
      LIMIT ${limit}`;
      recordPhase('bindingRowsQuery', bindingRowsStartedAt);
      const scorecardIds = [
        ...new Set(
          rows
            .map((row) => scorecardIssueIdFromEvidenceRef(row.evidence_ref))
            .filter((issueId): issueId is string => issueId !== null),
        ),
      ];
      if (scorecardIds.length === 0) {
        if (diagnostics) diagnostics.phaseMs.scorecardProofQuery = 0;
        return rows;
      }

      const scorecardProofStartedAt = diagnostics ? Date.now() : 0;
      const scorecards = await tx<{ feature_id: string; provisional: unknown }[]>`
        SELECT feature_id, payload -> 'observation' -> 'provisional' AS provisional
          FROM harness_shared.work_items
         WHERE workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}
           AND feature_id = ANY(${scorecardIds}::text[])
           AND payload -> 'observation' -> 'provisional' IS NOT NULL`;
      recordPhase('scorecardProofQuery', scorecardProofStartedAt);
      const provisionalById = new Map<string, ProvisionalScorecardProof>();
      for (const scorecard of scorecards) {
        const proof = parseProvisionalScorecardProof(scorecard.feature_id, scorecard.provisional);
        if (proof) provisionalById.set(scorecard.feature_id, proof);
      }
      return rows.map((row) => {
        const issueId = scorecardIssueIdFromEvidenceRef(row.evidence_ref);
        const provisionalScorecard = issueId ? provisionalById.get(issueId) : undefined;
        return provisionalScorecard
          ? { ...row, provisionalProofBase: true, provisionalScorecard }
          : row;
      });
    },
  );
  recordPhase('workspaceRead', workspaceReadStartedAt);

  const currentByKey = new Map((metadataOnly ? [] : replayCurrent).map((c) => [evidenceCurrentInputKey(c), c]));
  // The server-measured replay opt-out is explained at its use in the loop below.
  const recipeBuildStartedAt = diagnostics ? Date.now() : 0;
  const recipes = rows.map((row) =>
    metadataOnly || options.auditAsOf || (options.replaySnapshot && options.currentProvenance === 'server-measured')
      ? null
      : measurementFromDetails(row.details),
  );
  recordPhase('recipeBuild', recipeBuildStartedAt);
  if (diagnostics) {
    diagnostics.bindings.selectedRows = rows.length;
    diagnostics.bindings.rowsWithRecipe = recipes.filter((recipe) => recipe !== null).length;
  }
  const measurementRoots = new Map<string, Promise<string>>();
  const measurementRootFor = (
    recipe: RepoFilesEvidenceMeasurement,
    dimension: 'source' | 'fixture' = 'source',
  ): Promise<string> => {
    const primaryRootHarnessSlug = recipe.rootHarnessSlug ?? scope.harnessSlug;
    const rootHarnessSlug = dimension === 'fixture'
      ? recipe.fixtureRootHarnessSlug ?? primaryRootHarnessSlug
      : primaryRootHarnessSlug;
    const existing = measurementRoots.get(rootHarnessSlug);
    if (existing) return existing;
    const root = (async () => {
      const registryLookupStartedAt = diagnostics ? Date.now() : 0;
      const path = await resolveMeasurementRoot(scope.workspaceId, scope.harnessSlug, recipe, dimension);
      recordMaxPhase('measurementRootRegistryLookupMaxMs', registryLookupStartedAt);
      const realpathStartedAt = diagnostics ? Date.now() : 0;
      // Root canonicalization is metadata-only. Keep it off libuv's shared
      // threadpool so a busy operator cannot turn one symlink lookup into a
      // multi-minute evidence request; the returned value is still a fresh
      // realpath for every evaluation and preserves symlink identity.
      const resolved = realpathSync(path);
      recordMaxPhase('measurementRootRealpathMaxMs', realpathStartedAt);
      return resolved;
    })();
    measurementRoots.set(rootHarnessSlug, root);
    return root;
  };
  // D-001: ONE measurement commit M per measurement root per evaluation — the root's HEAD,
  // resolved once and shared by every binding measured there. A repo-files binding is
  // measured from git objects at M, so an uncommitted peer edit to a closure file never
  // stales it, while a committed change still does. A root that is not a git top level
  // resolves null and keeps the working-tree measurement and its mutation-probe fence.
  const measurementCommits = new Map<string, Promise<string | null>>();
  const measurementCommitFor = (root: string): Promise<string | null> => {
    const existing = measurementCommits.get(root);
    if (existing) return existing;
    const commitStartedAt = diagnostics ? Date.now() : 0;
    const commit = resolveMeasurementCommit(root).then((value) => {
      recordMaxPhase('measurementCommitResolutionMaxMs', commitStartedAt);
      return value;
    });
    measurementCommits.set(root, commit);
    return commit;
  };
  const rootAndCommitStartedAt = diagnostics ? Date.now() : 0;
  const workingTreeRecipes = await Promise.all(
    recipes.map(async (recipe) => {
      if (!recipe || recipe.kind === 'work-items') return recipe;
      const root = await measurementRootFor(recipe, 'source').catch(() => null);
      if (!root) return recipe;
      const sourceCommit = await measurementCommitFor(root);
      const fixtureRoot = hasRepoFixturePaths(recipe)
        ? await measurementRootFor(recipe, 'fixture').catch(() => null)
        : root;
      const fixtureCommit = hasRepoFixturePaths(recipe) && fixtureRoot
        ? fixtureRoot === root ? sourceCommit : await measurementCommitFor(fixtureRoot)
        : null;
      const sourceNeedsWorkingTree = !sourceCommit;
      const fixtureNeedsWorkingTree = Boolean(hasRepoFixturePaths(recipe) && !fixtureCommit);
      if (!sourceNeedsWorkingTree && !fixtureNeedsWorkingTree) return null;
      return {
        ...recipe,
        ...(sourceNeedsWorkingTree ? {} : { sourcePaths: [], sourceGlobs: undefined, testPaths: undefined }),
        ...(fixtureNeedsWorkingTree ? {} : { fixturePaths: undefined, fixtureGlobs: undefined, fixtureRootHarnessSlug: undefined }),
      };
    }),
  );
  recordPhase('resolveMeasurementRootsAndCommits', rootAndCommitStartedAt);
  const probeSnapshotsStartedAt = diagnostics ? Date.now() : 0;
  const probeSnapshots = await readRepoFilesProbeSnapshots(workingTreeRecipes, measurementRootFor);
  recordPhase('preReadProbeSnapshots', probeSnapshotsStartedAt);
  let runtimeRows: ReturnType<typeof listRuntimeVintage> | undefined;
  // One control-plane read per remote runtime per evaluation (WI-6554700010011907).
  const remoteRuntimeIdentities = new Map<string, Promise<string | null>>();
  const bindingMeasurementStatus = (status: 'measured' | 'unavailable' | 'skipped', startedAt: number) => {
    if (!diagnostics) return;
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    diagnostics.bindings[status] += 1;
    diagnostics.bindings.totalMeasurementMs += elapsedMs;
    diagnostics.bindings.maxMeasurementMs = Math.max(diagnostics.bindings.maxMeasurementMs, elapsedMs);
  };
  const serverMeasurementsStartedAt = diagnostics ? Date.now() : 0;
  // Bindings often repeat the same recipe at different clauses or work items. Share
  // only the immutable file measurement within this evaluation, before any process
  // starts; binding-specific runtime and adequacy checks still run below. A rejected
  // measurement remains rejected for every identical binding, never a cached pass.
  const committedMeasurements = new Map<string, Promise<DetailedRepoEvidenceMeasurement>>();
  const committedTreeScans = new Map<string, Promise<boolean>>();
  // Each binding can submit an AST scan before its file measurement. Respect the
  // scanner's existing admission bound instead of rejecting our own later rows.
  const serverMeasurements = await mapWithConcurrency(
    rows,
    TREE_SCAN_MAX_REQUESTS,
    async (row, index) => {
      const bindingStartedAt = diagnostics ? Date.now() : 0;
      // A REPLAY RE-MEASURES UNLESS THE CALLER HANDS US SERVER-MEASURED PROOF.
      // `currentProvenance:'server-measured'` is a caller saying "this pinned tuple is
      // already server-measured; replay it as-is, do not read the live repository" —
      // that opt-out is deliberate and stays exactly as it was.
      //
      // Every OTHER replay now measures. `replaySnapshot` pins the immutable CLAUSE
      // SNAPSHOT (see specIsCurrent above); it must NOT also suppress the per-binding
      // server measurement. It used to, and that made scorecards:emit structurally
      // unable to certify freshness='pass' on ANY card: rerunRecipeFor always emits
      // replaySnapshot:true PLUS a matching `current` tuple, so with measurement
      // suppressed the classifier saw nothing but caller-authored fingerprints,
      // attestedCurrentGuard fired precisely BECAUSE nothing was stale, and the replay
      // was capped at 'unknown'. emit's gate requires the exact replay to reproduce
      // every pass the card claims — so the evaluator's own recipe could not reproduce
      // the evaluator's own verdict (WI-10002320, reproduced twice on P-023).
      //
      // Re-measuring launders nothing, which is what the suppression was protecting:
      // `measured.current` is spread LAST so server values win over any caller tuple,
      // source/test are never counted as attested, and an opaque dimension the caller
      // supplied still degrades provenance to 'partially-server-measured' below. A
      // binding with no persisted measurement basis is still labelled
      // 'replayed-snapshot' and still capped. It is also the semantically correct
      // behaviour for a FRESHNESS criterion: a card must stop replaying 'pass' once the
      // code it was bound against moves.
      const recipe = recipes[index];
      if (!recipe) {
        bindingMeasurementStatus('skipped', bindingStartedAt);
        return null;
      }
      try {
        let measured: MeasuredRepoEvidenceFingerprints;
        let files: MeasuredRepoFile[] | null = null;
        let measuredAtCommit: string | null = null;
        let sourceEquivalence: StaticGuidanceSourceEquivalence | undefined;
        let completedRuntimeRefusal: CompletedRuntimeRefusal | undefined;
        if (recipe.kind === 'work-items') {
          // Ledger state has no checkout to resolve: the digest is recomputed from the rows.
          measured = await measureWorkItemsEvidenceForScope(
            scope.workspaceId,
            scope.harnessSlug,
            recipe,
            recipe.runtimeUnits ? await (runtimeRows ??= listRuntimeVintage(scope.workspaceId)) : undefined,
          );
        } else {
          const measurementRoot = await measurementRootFor(recipe, 'source');
          const fixtureRoot = hasRepoFixturePaths(recipe)
            ? await measurementRootFor(recipe, 'fixture')
            : measurementRoot;
          // A historical recipe may omit fixtureRootHarnessSlug even though its
          // measurement pin recorded the default/explicit fixture root identity.
          // Reusing that pin identity keeps diffMeasuredFiles keyed to the same
          // root instead of reporting one changed file as an added + removed pair.
          const pinnedFixtureRootHarnesses = new Set(
            (readMeasurementPin(row.details)?.files ?? [])
              .filter((file) => file.dimension === 'fixture' && typeof file.rootHarnessSlug === 'string')
              .map((file) => file.rootHarnessSlug as string),
          );
          const fixtureRootHarnessSlug = recipe.fixtureRootHarnessSlug ?? (
            pinnedFixtureRootHarnesses.size === 1 ? [...pinnedFixtureRootHarnesses][0] : undefined
          );
          measuredAtCommit = await measurementCommitFor(measurementRoot);
          const fixtureCommit = fixtureRoot === measurementRoot
            ? measuredAtCommit
            : hasRepoFixturePaths(recipe)
              ? await measurementCommitFor(fixtureRoot)
              : null;
          let measurementPhaseStartedAt = diagnostics ? Date.now() : 0;
          const broadTreeScanRefusal = await broadRepoTreeScanGuard(
            measurementRoot,
            recipe,
            measuredAtCommit,
            committedTreeScans,
          );
          recordMeasurementPhase('broadTreeScan', measurementPhaseStartedAt);
          if (broadTreeScanRefusal) throw new Error(broadTreeScanRefusal);
          measurementPhaseStartedAt = diagnostics ? Date.now() : 0;
          // Same single read as before; the per-file hashes it now also returns are what
          // name the moved paths below at zero extra IO. Under a batch probe snapshot the
          // pre-read fence is decided locally; its post-read half runs after this loop.
          const snapshot = probeSnapshots.get(measurementRoot);
          const fixtureSnapshot = fixtureRoot === measurementRoot ? snapshot : probeSnapshots.get(fixtureRoot);
          let detailed: DetailedRepoEvidenceMeasurement;
          if (measuredAtCommit) {
            // A fixture outside a committed repository still needs its own
            // working-tree read and mutation-probe fences for each binding.
            const measurementKey = !hasRepoFixturePaths(recipe) || fixtureCommit
              ? JSON.stringify([
                  measurementRoot, measuredAtCommit, recipe, fixtureRoot, fixtureCommit, fixtureRootHarnessSlug ?? null,
                ])
              : null;
            let measurement = measurementKey ? committedMeasurements.get(measurementKey) : undefined;
            if (!measurement) {
              measurement = measureRepoFilesEvidenceDetailedAtCommit(measurementRoot, recipe, measuredAtCommit, {
                ...(committedTree ? { deps: { diagnostics: committedTree } } : {}),
                ...(hasRepoFixturePaths(recipe) ? { fixtureRoot, fixtureCommit, fixtureRootHarnessSlug } : {}),
              });
              if (measurementKey) committedMeasurements.set(measurementKey, measurement);
            }
            detailed = await measurement;
          } else if (snapshot && (fixtureRoot === measurementRoot || !hasRepoFixturePaths(recipe) || fixtureSnapshot)) {
            const sourcePaths = await expandedRepoSourcePathsAtRoot(measurementRoot, recipe);
            const importedFixturePaths = fixtureRoot === measurementRoot
              ? await inferRepoFixtureImportsAtWorkingTree(measurementRoot, recipe.testPaths ?? [])
              : [];
            const fixturePaths = await expandedRepoFixturePathsAtRoot(fixtureRoot, recipe, importedFixturePaths);
            const measuredPaths = [
              ...sourcePaths,
              ...(recipe.testPaths ?? []),
              ...(fixtureRoot === measurementRoot ? fixturePaths : []),
            ];
            const refusal = mutationProbeRefusal(snapshot.resolved, snapshot.probes, measuredPaths);
            if (refusal) throw new Error(refusal);
            if (fixtureRoot !== measurementRoot && hasRepoFixturePaths(recipe) && fixtureSnapshot) {
              const fixtureRefusal = mutationProbeRefusal(fixtureSnapshot.resolved, fixtureSnapshot.probes, fixturePaths);
              if (fixtureRefusal) throw new Error(fixtureRefusal);
            }
            if (fixtureRoot !== measurementRoot && hasRepoFixturePaths(recipe)) {
              const primaryRecipe = { ...recipe, fixturePaths: undefined, fixtureGlobs: undefined, fixtureRootHarnessSlug: undefined };
              const primary = await fingerprintRepoFilesMeasurement(
                measurementRoot,
                primaryRecipe,
                sourcePaths,
                measurementRoot,
                undefined,
                [],
              );
              let fixtureFingerprint: string;
              let fixtureFiles: Array<{ path: string; sha256: string; gitBlob: string }>;
              if (fixtureCommit) {
                const committedFixturePaths = [...new Set([
                  ...(recipe.fixturePaths ?? []),
                  ...await listCommittedGlobMatches(fixtureRoot, fixtureCommit, recipe.fixtureGlobs ?? [],
                    { maxMatches: MAX_REPO_MEASUREMENT_FIXTURE_GLOB_MATCHES, maxDepth: MAX_REPO_MEASUREMENT_GLOB_DEPTH }),
                ])].sort();
                const fixture = await fingerprintRepoFileSetAtCommit(fixtureRoot, fixtureCommit, committedFixturePaths,
                  committedTree ? { diagnostics: committedTree } : {}, REPO_FIXTURE_READ_LIMITS);
                fixtureFingerprint = fixture.fingerprint;
                fixtureFiles = fixture.files;
              } else {
                const fixture = await fingerprintRepoFileSet(fixtureRoot, fixturePaths, REPO_FIXTURE_READ_LIMITS);
                fixtureFingerprint = fixture.fingerprint;
                fixtureFiles = fixture.files;
              }
              detailed = {
                sourceFingerprint: primary.sourceFingerprint,
                testFingerprint: primary.testFingerprint,
                fixtureFingerprint,
                files: [
                  ...primary.files,
                  ...fixtureFiles.map((file) => ({
                    ...file,
                    ...(fixtureRootHarnessSlug ? { rootHarnessSlug: fixtureRootHarnessSlug } : {}),
                    dimension: 'fixture' as const,
                  })),
                ],
              };
            } else {
              detailed = await fingerprintRepoFilesMeasurement(
                measurementRoot,
                recipe,
                sourcePaths,
                fixtureRoot,
                hasRepoFixturePaths(recipe) ? fixtureRootHarnessSlug : undefined,
                fixturePaths,
              );
            }
          } else {
            detailed = await measureRepoFilesEvidenceDetailedAtRoot(measurementRoot, recipe, {
              ...(hasRepoFixturePaths(recipe) ? { fixtureRoot, fixtureRootHarnessSlug } : {}),
            });
          }
          recordMeasurementPhase('repoFiles', measurementPhaseStartedAt);
          measurementPhaseStartedAt = diagnostics ? Date.now() : 0;
          const completedRecipe = completedTestRuntimeRecipe(row, recipe);
          measured = {
            sourceFingerprint: detailed.sourceFingerprint,
            testFingerprint: detailed.testFingerprint,
            ...(detailed.fixtureFingerprint !== undefined ? { fixtureFingerprint: detailed.fixtureFingerprint } : {}),
            ...(recipe.artifactReceiptPath ? { environmentFingerprint: await measurePackagedArtifactEnvironment(
              measurementRoot, recipe.artifactReceiptPath,
              detailed.files.find(file => file.path === recipe.artifactReceiptPath && file.dimension === 'source')!.sha256) } : {}),
            ...(recipe.nativeInstrumentKey ? { environmentFingerprint: await measureNativeColdEnvironment(
              scope.workspaceId, scope.harnessSlug, recipe.nativeInstrumentKey) } : {}),
            ...(recipe.runtimeUnits ? { environmentFingerprint: completedRecipe
              ? await measureCompletedTestRuntime(row, completedRecipe, detailed.files, scope, measurementRoot,
                { onStaticGuidanceEquivalence: value => { sourceEquivalence = value; },
                  onRefusal: value => { completedRuntimeRefusal = value; } })
              : await measureRuntimeEnvironment(
                await (runtimeRows ??= listRuntimeVintage(scope.workspaceId)), recipe.runtimeUnits,
                { memo: remoteRuntimeIdentities }) } : {}),
          };
          recordMeasurementPhase('environment', measurementPhaseStartedAt);
          files = detailed.files;
        }
        bindingMeasurementStatus('measured', bindingStartedAt);
        return {
          status: 'measured' as const,
          files,
          measuredAtCommit,
          sourceEquivalence,
          completedRuntimeRefusal,
          current: {
            planSlug: row.plan_slug,
            specId: row.spec_id,
            specRevision: Number(row.spec_revision),
            specFingerprint: row.spec_fingerprint,
            evidenceKind: row.evidence_kind,
            evidenceRef: row.evidence_ref,
            ...measured,
          } satisfies EvidenceCurrentInput,
        };
      } catch (error: unknown) {
        bindingMeasurementStatus('unavailable', bindingStartedAt);
        return {
          status: 'unavailable' as const,
          reason: (error instanceof Error ? error.message : String(error)).slice(0, 240),
        };
      }
    },
  );
  recordPhase('serverMeasurements', serverMeasurementsStartedAt);
  // Post-read half of the batch fence: a probe that locked a binding's paths while the
  // batch was reading fails that binding, exactly as its own post-read fence would. An
  // unreadable queue falls back to that per-binding fence.
  const postReadProbeStartedAt = diagnostics ? Date.now() : 0;
  for (const [root, before] of probeSnapshots) {
    const after = await readMutationProbeSnapshot(root, [], before.resolved);
    if (after && after.probes.length === 0) continue;
    await Promise.all(
      rows.map(async (_row, index) => {
        const recipe = recipes[index];
        if (!recipe || recipe.kind === 'work-items' || serverMeasurements[index]?.status !== 'measured') return;
        const sourceRoot = await measurementRootFor(recipe, 'source');
        const fixtureRoot = hasRepoFixturePaths(recipe)
          ? await measurementRootFor(recipe, 'fixture')
          : sourceRoot;
        let paths: string[];
        if (sourceRoot === root) {
          paths = await repoFilesPrimaryPathsAtRoot(root, recipe);
          if (fixtureRoot === root) {
            const importedFixturePaths = await inferRepoFixtureImportsAtWorkingTree(root, recipe.testPaths ?? []);
            paths.push(...await expandedRepoFixturePathsAtRoot(fixtureRoot, recipe, importedFixturePaths));
          }
        } else if (fixtureRoot === root && hasRepoFixturePaths(recipe)) {
          paths = await expandedRepoFixturePathsAtRoot(fixtureRoot, recipe);
        } else {
          return;
        }
        try {
          if (!after) await refuseMutationProbePaths(root, paths);
          const refusal = after ? mutationProbeRefusal(after.resolved, after.probes, paths) : null;
          if (refusal) throw new Error(refusal);
        } catch (error: unknown) {
          serverMeasurements[index] = {
            status: 'unavailable' as const,
            reason: (error instanceof Error ? error.message : String(error)).slice(0, 240),
          };
        }
      }),
    );
  }
  recordPhase('postReadProbeFence', postReadProbeStartedAt);
  const declaredConfigurations = await resolveDeclaredConfigurations(rows);
  const classificationStartedAt = diagnostics ? Date.now() : 0;
  const classified = rows.map((row, index) => {
    const measured = serverMeasurements[index];
    const parsedTestRunExecution = row.test_run_id === null
      ? undefined
      : parseTestRunExecutionDetails(row.test_run_execution_details);
    const baselineExecution = parseTestRunExecutionDetails(row.mutation_baseline_execution_details);
    const scopedCurrentKey = evidenceCurrentInputKey({
      planSlug: row.plan_slug,
      specId: row.spec_id,
      specRevision: Number(row.spec_revision),
      specFingerprint: row.spec_fingerprint,
      evidenceKind: row.evidence_kind,
      evidenceRef: row.evidence_ref,
    });
    const legacyCurrentKey = evidenceCurrentInputKey({
      evidenceKind: row.evidence_kind,
      evidenceRef: row.evidence_ref,
    });
    const callerCurrent = currentByKey.get(scopedCurrentKey) ?? currentByKey.get(legacyCurrentKey);
    const attestedDimensions: OpaqueFingerprintDimension[] =
      measured?.status === 'measured'
        ? [
            // Repo-files measurements include fixturePaths. Do not downgrade a
            // server-measured fixture fingerprint to caller-attested merely because
            // the rerun recipe also carries its original current tuple (EI-248065476).
            ...(row.fixture_fingerprint !== null &&
            callerCurrent?.fixtureFingerprint != null &&
            measured.current.fixtureFingerprint == null
              ? (['fixture'] as const)
              : []),
            ...(row.rubric_fingerprint !== null && callerCurrent?.rubricFingerprint != null
              ? (['rubric'] as const)
              : []),
            ...(row.environment_fingerprint !== null && callerCurrent?.environmentFingerprint != null
              && measured.current.environmentFingerprint == null
              ? (['environment'] as const)
              : []),
          ]
        : [];
    const current =
      measured?.status === 'measured'
        ? { ...callerCurrent, ...measured.current }
        : callerCurrent;
    const replayProvenance =
      !metadataOnly && options.replaySnapshot && options.currentProvenance
        ? { provenance: options.currentProvenance }
        : {};
    const declaredConfiguration = declaredConfigurations.get(declaredConfigurationPinKey(row) ?? '');
    const currentness = classifySpecEvidenceCurrentness(
      row,
      current,
      {
        ...(measured?.status === 'measured'
          ? { provenance: 'server-measured' as const, attestedDimensions, sourceEquivalence: measured.sourceEquivalence }
          : replayProvenance),
        ...(declaredConfiguration ? { declaredConfiguration } : {}),
      },
    );
    if (metadataOnly) {
      currentness.overall = 'unknown';
      currentness.unknownReasons = [...currentness.unknownReasons, 'evidence-metadata-only'];
    }
    if (measured?.status === 'unavailable' && currentness.overall === 'unknown') {
      currentness.unknownReasons = [...currentness.unknownReasons, `server-measurement-unavailable:${measured.reason}`];
    }
    // P-018: a repository-file-stale verdict now names WHICH measured files moved. Only for a
    // row that is stale on those dimensions — a current row has nothing to name, and a
    // row that predates the pin reports `pinned:false` rather than an empty (false) list.
    const fileStale = currentness.staleReasons.some(
      (reason) => reason === 'source-stale' || reason === 'test-stale' || reason === 'fixture-stale',
    );
    const movement =
      fileStale && measured?.status === 'measured' && measured.files
        ? diffMeasuredFiles(readMeasurementPin(row.details), measured.files)
        : null;
    return {
      id: Number(row.id),
      workItemId: row.work_item_id,
      planSlug: row.plan_slug,
      specId: row.spec_id,
      sourceValId: row.source_val_id,
      specRevision: Number(row.spec_revision),
      currentRevision: Number(row.current_revision),
      specFingerprint: row.spec_fingerprint,
      evidenceKind: row.evidence_kind,
      evidenceRef: row.evidence_ref,
      fingerprints: {
        sourceFingerprint: row.source_fingerprint,
        testFingerprint: row.test_fingerprint,
        fixtureFingerprint: row.fixture_fingerprint,
        rubricFingerprint: row.rubric_fingerprint,
        environmentFingerprint: row.environment_fingerprint,
      },
      coverageEvidenceRef: row.coverage_evidence_ref === null ? null : Number(row.coverage_evidence_ref),
      testRunId: row.test_run_id === null ? null : Number(row.test_run_id),
      // This relation is stored separately from binder-authored details.
      ...(row.verifies_binding_id == null ? {} : { verifiesBindingId: Number(row.verifies_binding_id) }),
      ...(row.test_run_id === null
        ? {}
        : {
            testRunExecution: parsedTestRunExecution
              ? {
                  status: typeof row.test_run_status === 'string' ? row.test_run_status : null,
                  passed: parsedTestRunExecution.passed,
                  failed: parsedTestRunExecution.failed,
                  skipped: parsedTestRunExecution.skipped,
                  collectionFailed: parsedTestRunExecution.collectionFailed,
                  ...(parsedTestRunExecution.testNamePattern !== null
                    ? { testNamePattern: parsedTestRunExecution.testNamePattern }
                    : {}),
                  filePath: parsedTestRunExecution.filePath,
                  ...(parsedTestRunExecution.scenarioId !== undefined
                    ? { scenarioId: parsedTestRunExecution.scenarioId }
                    : {}),
                  ...(parsedTestRunExecution.passedCaseTitles !== undefined
                    ? { passedCaseTitles: [...parsedTestRunExecution.passedCaseTitles] }
                    : {}),
                  ...(passedCaseTitlesIncomplete(parsedTestRunExecution)
                    ? { passedCaseTitlesIncomplete: true }
                    : {}),
                  ...(parsedTestRunExecution.testLayer !== undefined || canonicalOperationalAdapterLayer({
                    framework: row.test_run_framework, source: row.test_run_source,
                    filePath: row.test_run_file_path, runGroupId: parsedTestRunExecution.runGroupId,
                    commitSha: row.test_run_commit_sha, worktreeDirty: row.test_run_worktree_dirty,
                  }) !== undefined
                    ? { testLayer: parsedTestRunExecution.testLayer ?? 'operational' }
                    : {}),
                }
              : null,
          }),
      testRunProvenance: row.test_run_id === null || row.test_run_file_path == null
        ? null
        : {
            filePath: row.test_run_file_path,
            framework: row.test_run_framework ?? null,
            source: row.test_run_source ?? null,
            mutationPhase: parsedTestRunExecution?.mutationPhase ?? null,
            ...(parsedTestRunExecution?.mutation ? {
              mutation: parsedTestRunExecution.mutation,
              mutationBaseline: row.mutation_baseline_id != null && baselineExecution?.mutation
                ? {
                    testRunId: Number(row.mutation_baseline_id),
                    status: row.mutation_baseline_status ?? null,
                    mutation: baselineExecution.mutation,
                    passed: baselineExecution.passed,
                    failed: baselineExecution.failed,
                    skipped: baselineExecution.skipped,
                    collectionFailed: baselineExecution.collectionFailed,
                    ...(baselineExecution.passedCaseTitles !== undefined
                      ? { passedCaseTitles: [...baselineExecution.passedCaseTitles] }
                      : {}),
                    ...(passedCaseTitlesIncomplete(baselineExecution)
                      ? { passedCaseTitlesIncomplete: true }
                      : {}),
                  }
                : null,
            } : {}),
            commitSha: row.test_run_commit_sha,
            worktreeDirty: row.test_run_worktree_dirty,
            ...(row.mutation_failure_tail || row.mutation_execution_details != null
              ? { mutationFailureLines: mutationFailureLines(row.mutation_failure_tail ?? '', row.mutation_execution_details) }
              : {}),
            ...(() => {
              const titles = mutationFailedCaseTitles(row.mutation_execution_details);
              return titles === undefined ? {} : { mutationFailedCaseTitles: titles };
            })(),
          },
      details: row.provisionalProofBase
        ? {
            ...row.details,
            provisionalProofBase: true,
            ...(row.provisionalScorecard ? { provisionalScorecard: row.provisionalScorecard } : {}),
          }
        : row.details,
      ...(row.provisionalProofBase ? { provisionalProofBase: true } : {}),
      ...(row.provisionalScorecard ? { provisionalScorecard: row.provisionalScorecard } : {}),
      observedAt: pgTimestampToIso(row.observed_at),
      bindingFingerprint: row.binding_fingerprint,
      createdBy: row.created_by,
      createdAt: pgTimestampToIso(row.created_at),
      ...(row.retracted_at == null ? {} : { withdrawal: {
        at: pgTimestampToIso(row.retracted_at), by: row.retracted_by, reason: row.retraction_reason,
      } }),
      ...(measured
        ? {
            serverMeasurement:
              measured.status === 'measured'
                ? {
                    status: measured.status,
                    measuredDimensions: [
                      'source',
                      ...(measured.current.testFingerprint === null ? [] : ['test']),
                      ...(measured.current.fixtureFingerprint == null ? [] : ['fixture']),
                      ...(measured.current.environmentFingerprint == null ? [] : ['environment']),
                    ],
                    ...(attestedDimensions.length > 0 ? { attestedDimensions } : {}),
                    // D-001: the commit whose objects were measured; absent for a
                    // working-tree (non-git root) or ledger measurement.
                    ...(measured.measuredAtCommit ? { measuredAtCommit: measured.measuredAtCommit } : {}),
                    current: measured.current,
                    ...(measured.completedRuntimeRefusal ? { completedRuntimeRefusal: measured.completedRuntimeRefusal } : {}),
                    ...(movement
                      ? movement.pinned
                        ? { pinned: true, movedPaths: movement.moved }
                        : { pinned: false }
                      : {}),
                  }
                : measured,
          }
        : {}),
      currentness,
    };
  });
  recordPhase('classification', classificationStartedAt);
  // An ordinary audit-as-of read reconstructs what was bound at a historical instant
  // and is downgraded to unknown freshness. Only the internal historical grading replay
  // opts out so the auditor can reproduce the card's emission-time verdict from its
  // saved tuple; the provenance remains historical-snapshot, never live freshness.
  const auditOnly = options.auditAsOf && options.currentProvenance !== 'historical-snapshot'
    ? classified.map((row) => ({
        ...row,
        currentness: {
          ...row.currentness,
          overall: 'unknown' as const,
          provenance: 'replayed-snapshot' as const,
          staleReasons: [],
          unknownReasons: [...new Set([...row.currentness.unknownReasons, 'historical-audit-only'])],
        },
      }))
    : classified;
  const allowed = options.currentness ? new Set(options.currentness) : null;
  const result = allowed ? auditOnly.filter((row) => allowed.has(row.currentness.overall)) : auditOnly;
  // Certify once at the common read seam. Both work-item acceptance and the BAR
  // ship snapshot consume these rows directly, without the evaluator tool.
  const absence = new Map<number, number[]>();
  if (result.some(row => row.evidenceKind === 'independent-verification')) {
    const { resolveFixtureAbsenceVerifications } = await import('./spec-test-adequacy');
    const implementers = new Map<string, Promise<string[]>>();
    const relations = new Map<string, Promise<boolean>>();
    const certified = await resolveFixtureAbsenceVerifications(result, async (reviewer, citedAuthor, planSlug) => {
      let authors = implementers.get(planSlug);
      if (!authors) {
        authors = resolvePlanImplementerIdentities(planSlug, { workspaceId: scope.workspaceId });
        implementers.set(planSlug, authors);
      }
      for (const author of new Set([...(await authors), citedAuthor])) {
        if (author === reviewer) return false;
        const key = `${author}\u0000${reviewer}`;
        let relation = relations.get(key);
        if (!relation) {
          relation = areAcceptanceLineageRelated(author, reviewer, { workspaceId: scope.workspaceId });
          relations.set(key, relation);
        }
        if (await relation) return false;
      }
      return true;
    });
    for (const [id, verifierIds] of certified) absence.set(id, verifierIds);
  }
  recordPhase('total', totalStartedAt);
  return result.map(row => ({ ...row,
    ...(absence.has(row.id) ? { fixtureAbsenceVerification: { verifierBindingIds: absence.get(row.id)! } } : {}),
  }));
}
