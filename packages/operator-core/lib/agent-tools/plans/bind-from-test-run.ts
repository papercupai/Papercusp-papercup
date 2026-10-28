/**
 * plans:bind-spec-evidence `{ fromTestRun }` — derive a proof binding from a RECORDED test run
 * (P-044, review-system-rework-reduction-2026-09-23, R-10 / D-015).
 *
 * WHY. A finished `testing:run` already knows almost everything a binding needs: the test
 * file, its commit and dirty flag, the harness it ran under, its status. Binding it anyway
 * meant hand-carrying each of those into `evidenceRef`, `testRunId`, a `repo-files`
 * measurement and the mechanical adequacy fields. Measured 2026-09-23 by su-e3d58938: about
 * ten calls from three finished runs to one filed card, including recovering the emit recipe
 * from its own transcript. And a run recorded WITHOUT a harness could not be bound at all:
 * `harness_slug` is env-stamped, so it lands NULL and never matches the store's scoped lookup
 * (EI-24038789681540438).
 *
 * WHAT IS DERIVED (the caller supplies only the clause and the adequacy judgment):
 *  - `evidenceKind`   — `mutation` for a mutation-probe MUTANT row, else `test`.
 *  - `evidenceRef`    — the test path for `test` (what a hand-built binding uses), a
 *                       self-describing run reference for `mutation`.
 *  - `testRunId`      — the run id.
 *  - `measurement`    — `repo-files` with `testPaths:[file_path]` and `sourcePaths` = the
 *                       test file's FIRST RING of relative runtime imports (static, side-effect,
 *                       and literal dynamic `import('…')`), plus a valid mutant descriptor's
 *                       subject path, minus test infrastructure. Pass `sourcePaths` to override.
 *                       The first ring, not the transitive graph:
 *                       the measurement is a FRESHNESS hash, and a transitive set both
 *                       overflows the 32-path cap and stales the proof on every unrelated edit
 *                       anywhere below the subject.
 *  - fixturePaths      — caller-declared calibration inputs plus direct relative imports that
 *                       resolve to first-party test infrastructure when fixtureCalibrated is
 *                       true. A clean recorded commit also verifies those support paths;
 *                       transitive and non-imported inputs remain caller-declared.
 *  - `details.testRun`— id, file, status, source, mutation phase, commit, dirty flag, finish
 *                       time, and how the harness attribution was obtained.
 *  - `details.adequacy.{collected,skipped,executed,outcome}` — observable facts of the run.
 *                       Filled when absent; a declared value the run CONTRADICTS is refused,
 *                       because a "passed" claim on a failed run is exactly the fabrication
 *                       the ledger link exists to prevent.
 *
 * HARNESS ATTRIBUTION. A run with `harness_slug` NULL is ADOPTED into the caller's harness
 * (a guarded conditional UPDATE: still-NULL, same or NULL workspace). Adoption is required,
 * not cosmetic: the store re-checks `test_run_present` against the binding's harness on EVERY
 * read, so a binding pointing at a still-unattributed row would read `testRun: stale` forever.
 * CI and admin-ui rows are never adopted — they are harness-NULL by design and gate triage
 * scopes them by source/commit, so stamping one would move it between populations. A run
 * attributed to another harness is refused unless its recorded root resolves inside that exact
 * registered sibling checkout; the original harness attribution is preserved.
 */
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { z } from 'zod';
import { recordedTestLayer, isRecordedInstant, parseTestRunExecutionDetails, stableRecordedRuntimeEnvironment,
  type RecordedTestLayer } from '@papercusp/test-config/execution-details';
import { parseMutationDescriptor, type MutationDescriptor } from '@papercusp/test-config/mutation-descriptor';
import { withWorkspace } from '@papercusp/db-org';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';
import { deriveFixtureSupportPaths, deriveSubjectSourcePaths, isTestInfrastructurePath, stripComments } from '../../search/import-graph';
export { deriveFixtureSupportPaths, deriveSubjectSourcePaths, isTestInfrastructurePath } from '../../search/import-graph';
import {
  expandRepoFilesEvidenceSourcePathsAtRoot,
  mutationCaughtCaseClaimMessage,
  mutationCaughtCaseProseMismatch,
  repoFilesEvidenceMeasurementSchema,
} from './spec-evidence-store';
import { pinModuleState } from '@papercusp/module-singleton';
import { defaultGitRunner, type GitRunner } from './evidence-measurement-pin';

/**
 * WI-10005436: how long a repository-IDENTITY answer (git common dir, worktree top level,
 * superproject) is reused. Those answers depend on the directory layout, not on HEAD, the index or
 * any object, so a binding loop that binds run after run from the same checkout need not re-fork
 * them per row. On the ~1.7 GB operator each fork costs ~160 ms of synchronous main-thread time
 * (EI-24852529885337741); an execve census of :3170 counted ~44 of these per 10 min during a peer's
 * binding loop. Only successful answers are kept, so a path that is not (yet) a repository is
 * re-asked every time. A layout change inside this window (a checkout deleted and a DIFFERENT
 * repository re-created at the same path) is the only staleness, and disposable clones use unique
 * mkdtemp paths, so it does not arise in practice.
 */
export const REPO_IDENTITY_TTL_MS = 60_000;

const REPO_IDENTITY_ARGS: ReadonlySet<string> = new Set([
  'rev-parse --path-format=absolute --git-common-dir',
  'rev-parse --show-toplevel',
  'rev-parse --show-superproject-working-tree',
]);

/** Above this many entries per runner, a miss first drops every expired one. */
const REPO_IDENTITY_PRUNE_AT = 64;

interface IdentityEntry {
  promise: Promise<string>;
  settledAt: number | null;
}

/** Keyed by the UNDERLYING runner, so an injected test runner never shares answers with production. */
const repoIdentityMemos = pinModuleState(
  '@papercusp/operator-core.bind-from-test-run.repo-identity-memo',
  () => new WeakMap<GitRunner, Map<string, IdentityEntry>>(),
);

/**
 * `git` with repository-identity reads (see REPO_IDENTITY_TTL_MS) shared per underlying runner:
 * single-flight while in flight, reused for `ttlMs` after success, never reused after a failure.
 * Every other call passes straight through.
 */
export function withRepoIdentityMemo(
  git: GitRunner,
  opts: { ttlMs?: number; now?: () => number } = {},
): GitRunner {
  const ttlMs = opts.ttlMs ?? REPO_IDENTITY_TTL_MS;
  const now = opts.now ?? Date.now;
  let entries = repoIdentityMemos.get(git);
  if (!entries) {
    entries = new Map();
    repoIdentityMemos.set(git, entries);
  }
  const memo = entries;
  const fresh = (e: IdentityEntry, t: number) => e.settledAt === null || t - e.settledAt < ttlMs;
  return (cwd, args) => {
    const joined = args.join(' ');
    if (!REPO_IDENTITY_ARGS.has(joined)) return git(cwd, args);
    const key = `${resolve(cwd)}\0${joined}`;
    const t = now();
    const hit = memo.get(key);
    if (hit && fresh(hit, t)) return hit.promise;
    if (memo.size >= REPO_IDENTITY_PRUNE_AT) {
      for (const [k, e] of memo) if (!fresh(e, t)) memo.delete(k);
    }
    const entry: IdentityEntry = { promise: Promise.resolve(''), settledAt: null };
    entry.promise = git(cwd, args).then(
      (out) => {
        entry.settledAt = now();
        return out;
      },
      (err: unknown) => {
        if (memo.get(key) === entry) memo.delete(key);
        throw err;
      },
    );
    memo.set(key, entry);
    return entry.promise;
  };
}

/** Same bound as a hand-built `repo-files` measurement. */
export const FROM_TEST_RUN_MAX_SOURCE_PATHS = 32;
export const FROM_TEST_RUN_MAX_FIXTURE_PATHS = 32;

/** Run sources that are harness-NULL BY DESIGN and must never be re-attributed. */
const NEVER_ADOPTED_SOURCES: ReadonlySet<string> = new Set(['ci', 'admin-ui']);

/** Upper bound on surviving mutants one re-aim check loads and one justification may name. */
export const MUTATION_REAIM_MAX_SURVIVORS = 50;

export const testRunBindingSchema = z
  .object({
    workItemId: z.string().trim().min(1).max(200),
    specId: z.string().trim().min(1).max(200).optional(),
    sourceValId: z
      .string()
      .regex(/^VAL-[A-Za-z0-9._-]+$/)
      .optional(),
    specRevision: z.number().int().positive().optional(),
    fromTestRun: z
      .number()
      .int()
      .positive(),
    evidenceKind: z.enum(['test', 'mutation', 'counterexample']).optional(),
    sourcePaths: repoFilesEvidenceMeasurementSchema.shape.sourcePaths
      .optional()
      .describe("Overrides imports + mutant subject."),
    sourceGlobs: repoFilesEvidenceMeasurementSchema.shape.sourceGlobs,
    treeInstrumentKey: repoFilesEvidenceMeasurementSchema.shape.treeInstrumentKey.describe(
      'Committed census instrument.',
    ),
    fixturePaths: repoFilesEvidenceMeasurementSchema.shape.fixturePaths.describe(
      'First bind: declare fixture paths/globs incl. inline fixtures; infrastructure is auto-included.',
    ),
    fixtureGlobs: repoFilesEvidenceMeasurementSchema.shape.fixtureGlobs,
    fixtureRootHarnessSlug: repoFilesEvidenceMeasurementSchema.shape.fixtureRootHarnessSlug,
    completedRuntime: repoFilesEvidenceMeasurementSchema.shape.completedRuntime,
    canonicalTestPath: repoFilesEvidenceMeasurementSchema.shape.testPaths.unwrap().element
      .optional()
      .describe('Copy-out/cargo repo-relative test.'),
    details: z.record(z.string(), z.unknown()).optional(),
    reaimJustification: z
      .object({
        survivorTestRunIds: z.array(z.number().int().positive()).min(1).max(MUTATION_REAIM_MAX_SURVIVORS),
        reason: z.string().trim().min(1).max(2000),
      })
      .strict()
      .optional()
      .describe(
        'Name all same-test-SHA survivors and justify catch; identical mutant refuses. Stored details.reaim.',
      ),
    observedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((b) => Boolean(b.specId) !== Boolean(b.sourceValId), {
    message: 'pass exactly one of specId or sourceValId',
  })
  .superRefine((b, ctx) => {
    const adequacy = b.details?.adequacy;
    const fixtureCalibrated =
      adequacy !== null &&
      typeof adequacy === 'object' &&
      !Array.isArray(adequacy) &&
      (adequacy as Record<string, unknown>).fixtureCalibrated === true;
    if (fixtureCalibrated && b.fixturePaths === undefined && b.fixtureGlobs === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fixturePaths'],
        message:
          'details.adequacy.fixtureCalibrated=true requires fixturePaths or fixtureGlobs on the first bind; ' +
          'the measurement recipe is immutable after it is recorded, so add the actual fixture files now.',
      });
    }
  });

export type TestRunBindingInput = z.infer<typeof testRunBindingSchema>;

export interface TestRunEvidenceRow {
  id: number | string;
  root?: string | null;
  file_path: string | null;
  status: string | null;
  source: string | null;
  harness_slug: string | null;
  workspace_id: string | null;
  commit_sha: string | null;
  worktree_dirty: boolean | null;
  execution_details: unknown;
  /**
   * When the run started (NOT NULL DEFAULT now() in test_runs). Optional only so hand-built
   * fixtures that predate it still type; the loader always selects it. Absent means the
   * after-run modification guard cannot judge, so it does not refuse.
   */
  started_at?: Date | string | null;
  finished_at: Date | string | null;
  /**
   * The recording framework (`vitest`, `cargo`, …). Optional for the same fixture reason as
   * `started_at`; the loader always selects it. `cargo` rows name a test, not a file
   * (WI-10006836), so they map only through an explicit `canonicalTestPath`.
   */
  framework?: string | null;
}

export type HarnessAttribution = 'run' | 'adopted-caller-harness';

/**
 * Cargo receipts name a case: `<target-source.rs>::<test path>` (current reporter) or
 * `<crate-dir>::<test path>` (legacy). Neither is a file. Keep exact source identities when
 * present; legacy rows still need an explicit defining source. Aggregates are not test cases.
 */
export function cargoTestRef(filePath: string | null): { crateDir: string; testName: string; sourcePath?: string } | null {
  if (!filePath) return null;
  const at = filePath.indexOf('::');
  if (at <= 0) return null;
  const crateDir = filePath.slice(0, at);
  const testName = filePath.slice(at + 2);
  if (!testName || /[\s()]/.test(testName)) return null;
  return crateDir.endsWith('.rs')
    ? { crateDir: crateDir.slice(0, crateDir.lastIndexOf('/')), testName, sourcePath: crateDir }
    : { crateDir, testName };
}

/**
 * The canonical source for a cargo test must be a readable `.rs` file inside the recorded crate
 * that defines the test's function, so a caller cannot point a passing cargo row at an unrelated
 * file. Returns null when it holds, else the reason it does not.
 */
export function cargoCanonicalTestPathRefusal(
  root: string,
  ref: { crateDir: string; testName: string; sourcePath?: string },
  canonicalTestPath: string,
): string | null {
  const fnName = ref.testName.split('::').pop() ?? '';
  if (ref.sourcePath && canonicalTestPath !== ref.sourcePath) {
    // Cargo names the compiled target (often main.rs), while libtest names a
    // test in an external module. Follow only declarations in that target's
    // qualified module chain; a same-named function elsewhere is not proof.
    let source = ref.sourcePath;
    for (const module of ref.testName.split('::').slice(0, -1)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(module)) break;
      let text: string;
      try { text = stripComments(readFileSync(resolve(root, source), 'utf8')); } catch { break; }
      const declaration = new RegExp(`\\bmod\\s+${module}\\s*([;{])`).exec(text);
      if (!declaration) break;
      if (declaration[1] === '{') continue;
      const directory = /(?:^|\/)(?:main|lib|mod)\.rs$/.test(source)
        ? dirname(source) : source.slice(0, -3);
      const candidates = [`${directory}/${module}.rs`, `${directory}/${module}/mod.rs`]
        .filter((file) => { try { readFileSync(resolve(root, file)); return true; } catch { return false; } });
      if (candidates.length !== 1) break;
      source = candidates[0]!;
    }
    if (canonicalTestPath !== source) {
      return `canonicalTestPath ${JSON.stringify(canonicalTestPath)} differs from the recorded target source ${JSON.stringify(ref.sourcePath)} and its declared test module.`;
    }
  }
  if (!canonicalTestPath.endsWith('.rs') || (!ref.sourcePath && !canonicalTestPath.startsWith(`${ref.crateDir}/`))) {
    return `canonicalTestPath ${JSON.stringify(canonicalTestPath)} is not a .rs file inside the recorded crate ${JSON.stringify(ref.crateDir)}.`;
  }
  if (repoRelativeTestPath(root, resolve(root, canonicalTestPath)) !== canonicalTestPath) {
    return `canonicalTestPath ${JSON.stringify(canonicalTestPath)} is not a normalized path inside this harness checkout.`;
  }
  let text: string;
  try {
    text = readFileSync(resolve(root, canonicalTestPath), 'utf8');
  } catch {
    return `canonicalTestPath ${JSON.stringify(canonicalTestPath)} is not a readable file in this harness checkout.`;
  }
  const escaped = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`\\bfn\\s+${escaped}\\s*[<(]`).test(text)) {
    return `canonicalTestPath ${JSON.stringify(canonicalTestPath)} does not define fn ${fnName}, the cargo test ${JSON.stringify(ref.testName)}.`;
  }
  return null;
}

/** The binding the derivation hands to the ordinary `bindingSchema` path (re-validated there). */
export interface DerivedTestRunBinding {
  workItemId: string;
  specId?: string;
  sourceValId?: string;
  specRevision?: number;
  evidenceKind: 'test' | 'mutation' | 'counterexample';
  evidenceRef: string;
  testRunId: number;
  measurement: {
    schemaVersion: 1;
    kind: 'repo-files';
    /** WI-10006610: the registered sibling checkout the paths are relative to (absent = the plan harness). */
    rootHarnessSlug?: string;
    sourcePaths: string[];
    sourceGlobs?: string[];
    treeInstrumentKey?: z.infer<typeof repoFilesEvidenceMeasurementSchema>['treeInstrumentKey'];
    testPaths: string[];
    fixturePaths?: string[];
    fixtureGlobs?: string[];
    fixtureRootHarnessSlug?: string;
    runtimeUnits?: string[];
    completedRuntime?: z.infer<typeof repoFilesEvidenceMeasurementSchema>['completedRuntime'];
  };
  details: Record<string, unknown>;
  observedAt?: string;
}

export type TestRunExpansion =
  | { ok: true; binding: DerivedTestRunBinding; attribution: HarnessAttribution }
  | { ok: false; error: TestRunBindingError; testRunId: number; message: string };

export type TestRunBindingError =
  | 'test_run_not_found'
  | 'test_run_out_of_scope'
  | 'test_run_unfinished'
  | 'test_run_runtime_witness_missing'
  | 'test_run_not_adoptable'
  | 'test_run_file_outside_root'
  | 'test_run_canonical_path_source_unsupported'
  | 'test_run_canonical_path_mismatch'
  | 'source_paths_underivable'
  | 'fixture_paths_underivable'
  | 'run_contradicts_declared_adequacy'
  | 'mutation_caught_case_claim_mismatch'
  | 'mutation_causal_controls_invalid'
  | 'mutation_causal_controls_unlinked'
  | 'mutation_reaim_unjustified'
  | 'mutation_subject_outside_root'
  | 'test_run_as_committed_content_mismatch'
  | 'test_run_as_committed_probe_failed'
  | 'test_run_measurement_start_missing'
  | 'test_run_source_modified_after_run'
  | 'test_run_cargo_not_a_test'
  | 'test_run_cargo_test_path_required';

function executionDetails(raw: unknown): Record<string, unknown> {
  // The column is jsonb, but the reporter has written it both as an object and as a
  // JSON-encoded STRING scalar; accept either rather than reading a string as "no details".
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

function declaresFixtureCalibration(details: Record<string, unknown> | undefined): boolean {
  const adequacy = details?.adequacy;
  return Boolean(adequacy && typeof adequacy === 'object' && !Array.isArray(adequacy)
    && (adequacy as Record<string, unknown>).fixtureCalibrated === true);
}

/** Repo-relative POSIX path of the run's file, or null when it lies outside the checkout. */
export function repoRelativeTestPath(root: string, filePath: string): string | null {
  const rel = isAbsolute(filePath) ? relative(root, filePath) : filePath.replace(/^\.\//, '');
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/** Rebase recorded nested-workspace paths only across proven views of the same repository. */
export async function recordedTestPath(
  root: string,
  row: Pick<TestRunEvidenceRow, 'root' | 'file_path'>,
  git: GitRunner = defaultGitRunner,
): Promise<string | null> {
  if (!row.file_path) return null;
  if (!row.root) return repoRelativeTestPath(root, row.file_path);
  if (!isAbsolute(row.root)) return null;
  const file = resolve(row.root, row.file_path);
  // A recorded workspace cannot lend evidence for a sibling via ../ or an absolute escape.
  if (!repoRelativeTestPath(row.root, file)) return null;
  const local = repoRelativeTestPath(root, file);
  git = withRepoIdentityMemo(git);
  if (local) {
    try {
      const rootTop = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
      const recordedTop = (await git(row.root, ['rev-parse', '--show-toplevel'])).trim();
      if (isAbsolute(rootTop) && isAbsolute(recordedTop) && await sameDirectory(rootTop, recordedTop)) return local;
    } catch {
      try {
        await realpath(file);
        return local;
      } catch {
        // A removed disposable clone must be mapped by its clean commit instead.
      }
    }
  }
  try {
    const common = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    if (!isAbsolute(common)) return null;
    let recordedRoot = row.root;
    const visited = new Set<string>();
    for (let depth = 0; depth < 16 && !visited.has(recordedRoot); depth += 1) {
      visited.add(recordedRoot);
      const recordedCommon = (await git(recordedRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
      if (isAbsolute(recordedCommon) && resolve(recordedCommon) === resolve(common)) {
        const top = (await git(recordedRoot, ['rev-parse', '--show-toplevel'])).trim();
        return isAbsolute(top) ? repoRelativeTestPath(top, file) : null;
      }
      const parent = (await git(recordedRoot, ['rev-parse', '--show-superproject-working-tree'])).trim();
      if (!isAbsolute(parent) || !repoRelativeTestPath(parent, file)) return null;
      recordedRoot = parent;
    }
  } catch {
    // Missing historical checkout or unverifiable repository identity is unknown, never a filename match.
  }
  return null;
}

/** WI-10004898: where a clean disposable-clone run maps back to in the harness checkout. */
export interface AsCommittedMapping {
  /** Harness-root-relative test path. */
  testPath: string;
  /** '' = the harness repository itself; otherwise the submodule checkout the run's commit belongs to. */
  repoPrefix: string;
  commitSha: string;
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const MAX_SUBMODULE_PREFIX_SEGMENTS = 8;
const MAX_GITLINK_DEPTH = 4;

/** Mapping uncertainty must not become a definite "file absent" verdict. */
class AsCommittedProbeError extends Error {
  constructor(repo: string, commit: string, path: string, cause: unknown) {
    const detail = (cause instanceof Error ? cause.message : String(cause)).split('\n')[0]!.slice(0, 500);
    super(`repository=${JSON.stringify(repo)} commit=${commit} path=${JSON.stringify(path)}: ${detail}`, { cause });
  }
}

async function trackedSubmodulePaths(
  root: string,
  paths: readonly string[],
  git: GitRunner,
): Promise<Set<string>> {
  const candidates = new Set(paths.filter(Boolean));
  if (candidates.size === 0) return new Set();
  try {
    const pathspecs = [...candidates].map((path) => ':(literal)' + path);
    const entries = (await git(root, ['ls-files', '--stage', '--', ...pathspecs])).trim().split('\n');
    const tracked = new Set<string>();
    for (const entry of entries) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const path = entry.slice(tab + 1);
      if (candidates.has(path) && /^160000 [0-9a-f]{40} 0$/.test(entry.slice(0, tab))) tracked.add(path);
    }
    return tracked;
  } catch (error) {
    throw new AsCommittedProbeError(root, 'index', paths.join(','), error);
  }
}

async function sameDirectory(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

/**
 * WI-10004898: map a CLEAN run recorded in a disposable clone (`lint:as-committed`) back to
 * this checkout by CONTENT, not location. A clean run at commit X executed exactly X's tree
 * wherever the clone lived, so it is this repository's run at X when X is an object of the
 * harness repository — or of the submodule checkout that a trailing segment run of the
 * recorded root names (`<clone>/libs/generic/search` → `libs/generic/search`) — and X contains
 * the recorded file. Nothing is read from the clone: it is normally deleted by bind time.
 * Dirty or commit-less runs never qualify, because what they executed is unknowable.
 */
export async function asCommittedTestPath(
  root: string,
  row: Pick<TestRunEvidenceRow, 'root' | 'file_path' | 'commit_sha' | 'worktree_dirty'>,
  git: GitRunner = defaultGitRunner,
): Promise<AsCommittedMapping | null> {
  const commitSha = row.commit_sha;
  if (row.worktree_dirty !== false || !commitSha || !FULL_SHA_RE.test(commitSha)) return null;
  if (!row.root || !isAbsolute(row.root) || !row.file_path) return null;
  const inClone = repoRelativeTestPath(row.root, resolve(row.root, row.file_path));
  if (!inClone) return null;
  git = withRepoIdentityMemo(git);
  const segments = resolve(row.root).split(sep).filter(Boolean);
  const prefixes = [''];
  for (let k = 1; k <= Math.min(segments.length, MAX_SUBMODULE_PREFIX_SEGMENTS); k += 1) {
    prefixes.push(segments.slice(-k).join('/'));
  }
  let submodules: Set<string> | undefined;
  for (const repoPrefix of prefixes) {
    if (repoPrefix) {
      submodules ??= await trackedSubmodulePaths(root, prefixes.slice(1), git);
      if (!submodules.has(repoPrefix)) continue;
    }
    // Cargo runs from the crate checkout but the reporter can pin the enclosing
    // superproject commit. Resolve that commit's gitlink before trying a commit
    // belonging to the submodule itself; both retain the recorded path and SHA.
    if (repoPrefix) {
      const testPath = `${repoPrefix}/${inClone}`;
      if (await mappingBlobAtCommit(root, commitSha, testPath, git)) {
        return { testPath, repoPrefix: '', commitSha };
      }
    }
    const repo = repoPrefix ? resolve(root, repoPrefix) : resolve(root);
    try {
      // A prefix must name a repository ROOT (a submodule checkout), never a plain directory
      // of the superproject — that would re-anchor the file under the wrong path.
      const top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
      if (!(await sameDirectory(top, repo))) continue;
      // WI-10006842: descend gitlinks exactly like verifyAsCommittedContent does. A superproject
      // clone run of a SUBMODULE file (papercusp-desktop/test/...) names a path below a 160000
      // entry, which a bare `cat-file -e <commit>:<path>` reports absent.
      if (!(await mappingBlobAtCommit(repo, commitSha, inClone, git))) continue;
      return { testPath: repoPrefix ? `${repoPrefix}/${inClone}` : inClone, repoPrefix, commitSha };
    } catch (error) {
      if (error instanceof AsCommittedProbeError) throw error;
      throw new AsCommittedProbeError(repo, commitSha, inClone, error);
    }
  }
  return null;
}

/**
 * WI-10004978: which repository a clean copy-out row's commit belongs to. The copy-out mirror is
 * gone and names no repository, so the explicit `canonicalTestPath` is the only anchor: a probe
 * of a SUBMODULE file records that submodule's commit, which the superproject's object store
 * does not hold. The harness repository wins whenever it holds the commit (its gitlinks are
 * descended by `blobAtCommit`); otherwise the deepest leading directory of the path that is a
 * repository ROOT containing `<commit>:<rest>` does. '' when nothing matches, so the content
 * check still refuses — naming the repository it looked in.
 */
export async function canonicalAsCommittedPrefix(
  root: string,
  canonicalTestPath: string,
  commitSha: string,
  git: GitRunner = defaultGitRunner,
): Promise<string> {
  if (await mappingBlobAtCommit(resolve(root), commitSha, canonicalTestPath, git)) return '';
  const dirs = canonicalTestPath.split('/').slice(0, -1);
  git = withRepoIdentityMemo(git);
  for (let k = dirs.length; k >= 1; k -= 1) {
    const repoPrefix = dirs.slice(0, k).join('/');
    const repo = resolve(root, repoPrefix);
    try {
      const top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
      if (!(await sameDirectory(top, repo))) continue;
      if (await mappingBlobAtCommit(repo, commitSha, canonicalTestPath.slice(repoPrefix.length + 1), git)) return repoPrefix;
    } catch (error) {
      if (error instanceof AsCommittedProbeError) throw error;
      // Plain path ancestors are not candidate repository roots.
      if (await stat(resolve(repo, '.git')).then(() => true, () => false)) {
        throw new AsCommittedProbeError(repo, commitSha, canonicalTestPath, error);
      }
    }
  }
  return '';
}

/** A known-absent commit may belong to another candidate repository. Other failures are unknown. */
async function mappingBlobAtCommit(repo: string, commit: string, rel: string, git: GitRunner) {
  try {
    return await blobAtCommit(repo, commit, rel, git, 0, true);
  } catch (error) {
    const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
    const message = cause instanceof Error ? cause.message : String(cause);
    const exitedMissing = cause instanceof Error && (
      ('status' in cause && cause.status === 128 && (!('signal' in cause) || cause.signal == null))
      || message.startsWith('Command failed (exit 128): git ')
    );
    if (exitedMissing && message.split('\n').some(line => line.trim() === 'fatal: not a tree object'
      || line.trim() === `fatal: not a tree object: ${commit}`)) return null;
    throw new AsCommittedProbeError(repo, commit, rel, error);
  }
}

/** Resolve `rel` at `commit` in `repo`, descending through any submodule gitlink the commit pins. */
async function blobAtCommit(
  repo: string,
  commit: string,
  rel: string,
  git: GitRunner,
  depth = 0,
  requireSuccessfulProbe = false,
): Promise<{ blob: string; repo: string; rel: string } | null> {
  const probeError = (path: string, detail: string, cause?: unknown): Error => new Error(
    `git ls-tree repository=${JSON.stringify(repo.slice(0, 180))} commit=${commit} path=${JSON.stringify(path.slice(0, 160))}: ${detail}`,
    { cause },
  );
  const errorDetail = (error: unknown): string =>
    (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200);
  let directEntry = '';
  try {
    // Unlike rev-parse --verify, ls-tree reports a missing path with a successful,
    // empty result. A failed probe therefore cannot masquerade as file absence.
    directEntry = (await git(repo, ['ls-tree', commit, '--', rel])).trim();
  } catch (error) {
    if (requireSuccessfulProbe) throw probeError(rel, errorDetail(error), error);
    return null;
  }
  const directBlob = /^[0-7]{6} blob ([0-9a-f]{40})\t/.exec(directEntry);
  if (directBlob) return { blob: directBlob[1]!, repo, rel };
  if (directEntry) {
    // A directory, gitlink, or malformed response is not a successful empty lookup.
    // Preserve the entry and actual repository so the next refusal is diagnosable.
    if (requireSuccessfulProbe) throw probeError(rel, `expected a blob; received ${JSON.stringify(directEntry.slice(0, 200))}`);
    return null;
  }
  if (depth >= MAX_GITLINK_DEPTH) return null;
  const parts = rel.split('/');
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const dir = parts.slice(0, i).join('/');
    let entry = '';
    try {
      entry = (await git(repo, ['ls-tree', commit, '--', dir])).trim();
    } catch (error) {
      if (requireSuccessfulProbe) throw probeError(dir, errorDetail(error), error);
      return null;
    }
    const gitlink = /^160000 commit ([0-9a-f]{40})\t/.exec(entry);
    if (gitlink) return blobAtCommit(resolve(repo, dir), gitlink[1]!, parts.slice(i).join('/'), git, depth + 1, requireSuccessfulProbe);
    if (entry) {
      // A valid tree/blob ancestor establishes absence. Unexpected output cannot.
      if (requireSuccessfulProbe && !/^[0-7]{6} (?:tree|blob) [0-9a-f]{40}\t/.test(entry)) {
        throw probeError(dir, `expected a tree, blob, or gitlink; received ${JSON.stringify(entry.slice(0, 200))}`);
      }
      return null;
    }
  }
  return null;
}

/**
 * A disposable-clone run may lend its outcome only for paths that EXIST at the commit it
 * ran at, inside the repository it ran in. The binding is then fingerprinted from git
 * objects at that commit (proof-freshness-pinned-candidate-2026-10-06 D-001 (b)), so the
 * shared checkout's current bytes are deliberately not compared: a peer edit made after
 * the run neither blocks the bind nor leaks into the stored fingerprint.
 */
async function verifyAsCommittedContent(
  root: string,
  mapping: AsCommittedMapping,
  paths: readonly string[],
  git: GitRunner,
): Promise<{ ok: true } | { ok: false; path: string; reason: string; probeFailed?: boolean }> {
  const repo = mapping.repoPrefix ? resolve(root, mapping.repoPrefix) : resolve(root);
  const at = mapping.commitSha.slice(0, 12);
  for (const path of paths) {
    if (mapping.repoPrefix && !path.startsWith(`${mapping.repoPrefix}/`)) {
      return { ok: false, path, reason: `lies outside the run's repository ${mapping.repoPrefix}` };
    }
    const rel = mapping.repoPrefix ? path.slice(mapping.repoPrefix.length + 1) : path;
    let committed: Awaited<ReturnType<typeof blobAtCommit>>;
    try {
      committed = await blobAtCommit(repo, mapping.commitSha, rel, git, 0, true);
    } catch (error) {
      return {
        ok: false, path, probeFailed: true,
        reason: (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 500),
      };
    }
    if (!committed) {
      const where = mapping.repoPrefix ? `the ${mapping.repoPrefix} repository` : 'the harness repository';
      return { ok: false, path, reason: `is absent at ${at} (looked up in ${where}: ${JSON.stringify(repo.slice(0, 240))})` };
    }
    // proof-freshness-pinned-candidate-2026-10-06 D-001 (b): the working-tree bytes are NOT
    // compared any more. The binding's fingerprint is measured from git objects at this
    // commit (bind-spec-evidence -> measureAndPinRepoFilesEvidenceAtCommitForScope), so it
    // describes exactly the code that ran however far the shared checkout has moved since.
  }
  return { ok: true };
}

interface RunFacts {
  collected: boolean;
  skipped: boolean;
  executed: boolean;
  outcome: string;
  testLayer?: RecordedTestLayer;
}

/** The adequacy reader accepts these aliases; compare them semantically while preserving polarity. */
const ADEQUACY_OUTCOME_CANONICAL: Readonly<Record<string, string>> = {
  pass: 'passed',
  passed: 'passed',
  success: 'passed',
  succeeded: 'passed',
  fail: 'failed',
  failed: 'failed',
  skip: 'skipped',
  skipped: 'skipped',
  caught: 'caught',
  killed: 'caught',
};

function canonicalAdequacyOutcome(value: unknown): string {
  const outcome = String(value).toLowerCase();
  return ADEQUACY_OUTCOME_CANONICAL[outcome] ?? outcome;
}

function runFacts(row: TestRunEvidenceRow, kind: DerivedTestRunBinding['evidenceKind']): RunFacts {
  const execution = executionDetails(row.execution_details);
  const testLayer = recordedTestLayer(row.execution_details);
  const status = String(row.status ?? '');
  const collectionFailed = execution.collectionFailed === true;
  const executed = status === 'pass' || status === 'fail';
  // A raw mutation-probe failure is only a caught mutant when the reporter
  // measured at least one failed assertion. A launch/collection crash can also
  // produce status=fail, and its output_tail is only a diagnostic tail that may
  // contain session hook or environment noise. New reporter rows carry the
  // structured failedCaseTitles/counts; legacy rows without them stay unknown.
  const measuredMutantFailure =
    deriveKind(row) === 'mutation' &&
    status === 'fail' &&
    execution.collectionFailed === false &&
    Number(execution.failed) > 0 &&
    Array.isArray(execution.failedCaseTitles) &&
    execution.failedCaseTitles.some((title) => typeof title === 'string' && title.length > 0);
  const outcome =
    kind === 'test' || (kind === 'counterexample' && deriveKind(row) !== 'mutation')
      ? // A caller-declared counterexample over an ordinary test run is still a test execution.
        // Its green status does not mean a mutant survived; only a canonical mutant row carries
        // the caught/survived polarity below.
        ({ pass: 'passed', fail: 'failed', skip: 'skipped' } as Record<string, string>)[status] ?? status
      : kind === 'mutation' && deriveKind(row) !== 'mutation'
        ? // A caller-declared mutation binding over a row that is NOT a raw mutant run (e.g. a
          // testing:record-run operational record of a whole mutation-probe invocation) carries
          // the probe's own VERDICT: it passes exactly when the mutant was caught. Inverting it
          // like a mutant row fabricated `survived` for a caught mutant (WI-10004591). A failed
          // verdict stays the raw status — the row cannot say whether it survived or misfired.
          ({ pass: 'caught' } as Record<string, string>)[status] ?? status
      : // A mutant run that FAILED is caught only when a failed assertion was
        // measured; a failed launch/collection remains unknown. A passing
        // mutant is still a measured survivor.
          (status === 'fail'
            ? (measuredMutantFailure ? 'caught' : 'unknown')
            : ({ pass: 'survived' } as Record<string, string>)[status] ?? status);
  return {
    ...(testLayer ? { testLayer } : {}),
    collected: !collectionFailed && status !== 'error',
    skipped: status === 'skip',
    executed,
    outcome,
  };
}

function deriveKind(row: TestRunEvidenceRow): DerivedTestRunBinding['evidenceKind'] {
  return row.source === 'mutation-probe' && executionDetails(row.execution_details).mutationPhase === 'mutant'
    ? 'mutation'
    : 'test';
}

function isoOrNull(value: Date | string | null): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/**
 * Pure derivation: one input + one loaded run row + the checkout root → the binding, or a
 * refusal naming what to supply instead. No I/O beyond reading the test file's imports.
 */
function mutationCausalControlsRefusal(
  input: TestRunBindingInput,
  row: TestRunEvidenceRow,
): Extract<TestRunExpansion, { ok: false }> | null {
  if ((input.evidenceKind ?? deriveKind(row)) !== 'mutation' || input.details?.causalControls === undefined) return null;
  const controls = input.details.causalControls;
  const testRunId = Number(row.id);
  const valid = controls && typeof controls === 'object' && !Array.isArray(controls)
    ? controls as Record<string, unknown> : null;
  const ids = valid && [valid.baselineTestRunId, valid.copyBaselineTestRunId, valid.mutantTestRunId];
  if (!ids || ids.some(id => !Number.isSafeInteger(id) || Number(id) <= 0)
    || new Set(ids).size !== 3 || valid?.mutantTestRunId !== testRunId) {
    return { ok: false, error: 'mutation_causal_controls_invalid', testRunId,
      message: `Mutation causalControls must name distinct positive baselineTestRunId, copyBaselineTestRunId and mutantTestRunId; mutantTestRunId must equal the bound test-run ${testRunId}.` };
  }
  return null;
}

/**
 * Caller-authored details are useful context, but a mutation's "caught by:" case list must
 * agree with the test-run ledger. The evaluator already reads failedCaseTitles separately;
 * guarding this prose prevents a reader from seeing a larger catch than the run measured.
 */
function mutationCaughtCaseClaimRefusal(
  input: TestRunBindingInput,
  row: TestRunEvidenceRow,
): Extract<TestRunExpansion, { ok: false }> | null {
  if ((input.evidenceKind ?? deriveKind(row)) !== 'mutation'
    || row.source !== 'mutation-probe'
    || executionDetails(row.execution_details).mutationPhase !== 'mutant') return null;

  const testRunId = Number(row.id);
  const failedCaseTitles = parseTestRunExecutionDetails(row.execution_details)?.failedCaseTitles;
  const mismatch = mutationCaughtCaseProseMismatch(input.details ?? {}, failedCaseTitles);
  return mismatch
    ? {
        ok: false,
        error: 'mutation_caught_case_claim_mismatch',
        testRunId,
        message: mutationCaughtCaseClaimMessage(testRunId, mismatch),
      }
    : null;
}

/** The calibration leg each named causal control must have recorded, in controlIds order. */
const CAUSAL_CONTROL_LEGS = ['baseline', 'copy-baseline'] as const;

/**
 * EI-26471802780956386: a caught mutant is linked only to calibration rows from
 * its OWN probe invocation (spec-evidence-store pairs the baseline on
 * probeInvocationId + subjectBeforeSha256). Controls copied from another probe of
 * the same commit pass the scope check yet leave the binding reading
 * mutationLinkage=unverified, so refuse them here. Pre-descriptor mutant rows keep
 * the scope-only check; a descriptor-bearing mutant needs descriptor-bearing controls.
 */
function mutationCausalControlsUnlinked(
  row: TestRunEvidenceRow,
  controls: readonly TestRunEvidenceRow[],
  controlIds: readonly number[],
): Extract<TestRunExpansion, { ok: false }> | null {
  const mutant = parseMutationDescriptor(executionDetails(row.execution_details).mutation);
  if (mutant?.leg !== 'mutant') return null;
  const testRunId = Number(row.id);
  for (const [index, control] of controls.entries()) {
    const descriptor = parseMutationDescriptor(executionDetails(control.execution_details).mutation);
    const expectedLeg = CAUSAL_CONTROL_LEGS[index];
    if (descriptor?.probeInvocationId === mutant.probeInvocationId
      && descriptor.subjectBeforeSha256 === mutant.subjectBeforeSha256
      && descriptor.leg === expectedLeg) continue;
    const found = descriptor
      ? `probeInvocationId ${JSON.stringify(descriptor.probeInvocationId)}, leg ${JSON.stringify(descriptor.leg)}`
      : 'no mutation descriptor';
    return { ok: false, error: 'mutation_causal_controls_unlinked', testRunId,
      message: `Mutation causal control test-run ${controlIds[index]} records ${found}, but the bound mutant ${testRunId} ` +
        `is probeInvocationId ${JSON.stringify(mutant.probeInvocationId)}; its ${expectedLeg} control must be that ` +
        `invocation's ${expectedLeg} leg for the same subject bytes. Take all three ids from one probe run's ledger rows ` +
        `(testing:runs on the guard file, grouped by execution_details.mutation.probeInvocationId), never from another probe.` };
  }
  return null;
}

export function deriveBindingFromTestRun(
  input: TestRunBindingInput,
  row: TestRunEvidenceRow,
  root: string,
  attribution: HarnessAttribution,
  mutantSubjectPathAtRoot?: string,
): TestRunExpansion {
  const testRunId = Number(row.id);
  const controlsRefusal = mutationCausalControlsRefusal(input, row);
  if (controlsRefusal) return controlsRefusal;
  if (row.status === 'running' || row.status == null) {
    return {
      ok: false,
      error: 'test_run_unfinished',
      testRunId,
      message: `test-run ${testRunId} has status ${row.status ?? 'null'}; bind it once it has finished.`,
    };
  }
  const caughtCaseClaimRefusal = mutationCaughtCaseClaimRefusal(input, row);
  if (caughtCaseClaimRefusal) return caughtCaseClaimRefusal;
  const testPath = row.file_path ? repoRelativeTestPath(root, row.file_path) : null;
  if (!testPath) {
    return {
      ok: false,
      error: 'test_run_file_outside_root',
      testRunId,
      message: `test-run ${testRunId} file ${JSON.stringify(row.file_path)} is not inside this harness checkout (${root}).`,
    };
  }
  const evidenceKind = input.evidenceKind ?? deriveKind(row);
  const mutationDescriptor = !input.sourcePaths
    ? parseMutationDescriptor(executionDetails(row.execution_details).mutation)
    : undefined;
  const mutantSubjectPath = mutationDescriptor?.leg === 'mutant'
    ? mutantSubjectPathAtRoot ?? repoRelativeTestPath(root, mutationDescriptor.subjectPath)
    : null;
  if (mutationDescriptor?.leg === 'mutant' && !mutantSubjectPath) {
    return {
      ok: false,
      error: 'mutation_subject_outside_root',
      testRunId,
      message:
        `test-run ${testRunId} mutant subject ${JSON.stringify(mutationDescriptor.subjectPath)} is outside this harness checkout (${root}); ` +
        'bind only a subject that can be measured from this checkout.',
    };
  }
  let sourcePaths: string[];
  if (input.sourcePaths) {
    sourcePaths = [...new Set(input.sourcePaths)].sort();
  } else {
    try {
      sourcePaths = [...new Set([
        ...deriveSubjectSourcePaths(root, testPath),
        ...(mutantSubjectPath ? [mutantSubjectPath] : []),
      ])].sort();
    } catch (error) {
      return {
        ok: false,
        error: 'source_paths_underivable',
        testRunId,
        message: `could not read ${testPath} to derive its subject files (${String(error)}); pass sourcePaths.`,
      };
    }
    if (sourcePaths.length === 0 || sourcePaths.length > FROM_TEST_RUN_MAX_SOURCE_PATHS) {
      return {
        ok: false,
        error: 'source_paths_underivable',
        testRunId,
        message:
          sourcePaths.length === 0
            ? `${testPath} imports no repo source through a relative specifier, so there is no subject to measure; pass sourcePaths.`
            : `${testPath} derives ${sourcePaths.length} repo source files, over the ${FROM_TEST_RUN_MAX_SOURCE_PATHS}-path measurement cap; pass the subject files as sourcePaths.`,
      };
    }
  }

  let fixturePaths = input.fixturePaths ? [...new Set(input.fixturePaths)].sort() : undefined;
  if (declaresFixtureCalibration(input.details)) {
    let supportPaths: string[];
    try {
      supportPaths = deriveFixtureSupportPaths(root, testPath);
    } catch (error) {
      return {
        ok: false,
        error: 'fixture_paths_underivable',
        testRunId,
        message: 'could not read first-party test-support imports from ' + testPath
          + ' (' + String(error) + '); no calibrated binding was created.',
      };
    }
    const combined = [...new Set([...(fixturePaths ?? []), ...supportPaths])].sort();
    if (combined.length > FROM_TEST_RUN_MAX_FIXTURE_PATHS) {
      return {
        ok: false,
        error: 'fixture_paths_underivable',
        testRunId,
        message: testPath + ' imports ' + combined.length + ' declared or first-party test-support fixture paths, over the '
          + FROM_TEST_RUN_MAX_FIXTURE_PATHS + '-path limit; split the test or reduce its calibrated fixture set.',
      };
    }
    if (combined.length > 0) fixturePaths = combined;
  }

  const facts = runFacts(row, evidenceKind);
  const declaredAdequacy =
    input.details?.adequacy && typeof input.details.adequacy === 'object'
      ? (input.details.adequacy as Record<string, unknown>)
      : {};
  const contradictions = (Object.keys(facts) as Array<keyof RunFacts>).filter(
    (key) =>
      declaredAdequacy[key] !== undefined &&
      (key === 'outcome'
        ? canonicalAdequacyOutcome(declaredAdequacy[key]) !== canonicalAdequacyOutcome(facts.outcome)
        : declaredAdequacy[key] !== facts[key]),
  );
  if (contradictions.length > 0) {
    return {
      ok: false,
      error: 'run_contradicts_declared_adequacy',
      testRunId,
      message:
        `test-run ${testRunId} recorded ${contradictions.map((k) => `${k}=${JSON.stringify(facts[k])}`).join(', ')}, ` +
        `but details.adequacy declares ${contradictions.map((k) => `${k}=${JSON.stringify(declaredAdequacy[k])}`).join(', ')}. ` +
        'Omit those fields and they are taken from the run.',
    };
  }

  const exec = executionDetails(row.execution_details);
  const commitSha = row.commit_sha ?? (typeof exec.commitSha === 'string' ? exec.commitSha : null);
  const worktreeDirty = row.worktree_dirty ?? (typeof exec.worktreeDirty === 'boolean' ? exec.worktreeDirty : null);
  const mutationPhase = typeof exec.mutationPhase === 'string' ? exec.mutationPhase : null;
  const evidenceRef =
    evidenceKind === 'test'
      ? testPath
      : `test-run ${testRunId} ${row.source ?? 'unknown-source'}${mutationPhase ? ` ${mutationPhase}` : ''} ` +
        `${row.status} ${testPath} @${commitSha ? commitSha.slice(0, 12) : 'unknown-commit'}${worktreeDirty ? '+dirty' : ''}`;

  const { adequacy: _declared, ...otherDetails } = input.details ?? {};
  const recordedExecution = parseTestRunExecutionDetails(row.execution_details);
  const runtimeWitness = stableRecordedRuntimeEnvironment(
    recordedExecution?.runtimeEnvironmentBefore, recordedExecution?.runtimeEnvironmentAfter);
  // Isolated workers finish inside the test, so their original ledger receipts
  // identify the execution instead of snapshots of the current serving host.
  // The store derives the receipt fingerprint and certifies the retained artifacts.
  // Guarded adoption updates the row's harness, while its original execution
  // metadata stays immutable. A local, originally unscoped receipt still belongs
  // to that adopted row; a recorded foreign harness must continue to fail closed.
  const isolatedHarnessMatches = recordedExecution?.harnessSlug === row.harness_slug
    || (recordedExecution?.harnessSlug === null && row.harness_slug != null
      && (row.source === 'local' || row.source === 'mutation-probe'));
  const isolatedRuntimeUnits = (recordedExecution?.testLayer === 'integration' || recordedExecution?.testLayer === 'e2e')
    && recordedExecution.workspaceId === row.workspace_id
    && isolatedHarnessMatches
    && recordedExecution.isolatedRuntimeReceipts
    ? recordedExecution.isolatedRuntimeReceipts.map(receipt => `isolated-integration:${receipt.runId}`)
    : undefined;
  const completedWitnessPresent = input.completedRuntime?.kind === 'isolated-integration'
    ? evidenceKind === 'test' && isolatedRuntimeUnits && JSON.stringify([...isolatedRuntimeUnits].sort())
      === JSON.stringify(input.completedRuntime.runIds.map(id => `isolated-integration:${id}`).sort())
    : runtimeWitness;
  if (input.completedRuntime && !completedWitnessPresent) {
    return { ok: false, error: 'test_run_runtime_witness_missing', testRunId,
      message: `test-run ${testRunId} has no stable execution-time runtime witness; completed certification cannot create one.` };
  }
  // Completed isolated lifetimes certify positive live tests. A negative
  // counterexample retains its original source/test/ledger proof without
  // inheriting a runtime selector that the completed-runtime reader cannot
  // certify. Do not fall back to an unrelated serving-host snapshot either.
  const runtimeUnits = isolatedRuntimeUnits && evidenceKind !== 'test' && !input.completedRuntime
    ? undefined
    : input.completedRuntime && input.completedRuntime.kind !== 'isolated-integration'
      ? runtimeWitness?.units : isolatedRuntimeUnits ?? runtimeWitness?.units;
  const binding: DerivedTestRunBinding = {
    workItemId: input.workItemId,
    ...(input.specId ? { specId: input.specId } : {}),
    ...(input.sourceValId ? { sourceValId: input.sourceValId } : {}),
    ...(input.specRevision ? { specRevision: input.specRevision } : {}),
    evidenceKind,
    evidenceRef,
    testRunId,
    measurement: {
      schemaVersion: 1,
      kind: 'repo-files',
      sourcePaths,
      ...(input.sourceGlobs ? { sourceGlobs: input.sourceGlobs } : {}),
      ...(input.treeInstrumentKey ? { treeInstrumentKey: input.treeInstrumentKey } : {}),
      testPaths: [testPath],
      ...(fixturePaths ? { fixturePaths } : {}),
      ...(input.fixtureGlobs ? { fixtureGlobs: input.fixtureGlobs } : {}),
      ...(input.fixtureRootHarnessSlug ? { fixtureRootHarnessSlug: input.fixtureRootHarnessSlug } : {}),
      ...(runtimeUnits ? { runtimeUnits: [...runtimeUnits] } : {}),
      ...(input.completedRuntime ? { completedRuntime: input.completedRuntime } : {}),
    },
    details: {
      ...otherDetails,
      adequacy: { ...declaredAdequacy, ...facts },
      testRun: {
        id: testRunId,
        filePath: testPath,
        status: row.status,
        source: row.source,
        mutationPhase,
        commitSha,
        worktreeDirty,
        finishedAt: isoOrNull(row.finished_at),
        harnessAttribution: attribution,
      },
    },
    ...(input.observedAt ? { observedAt: input.observedAt } : {}),
  };
  return { ok: true, binding, attribution };
}

/** A mutation descriptor path is relative to the probe subject's Git root, which can be nested. */
async function mutationSubjectPathAtHarnessRoot(
  harnessRoot: string,
  testPath: string,
  subjectPath: string,
  git: GitRunner,
): Promise<string | null> {
  if (isAbsolute(subjectPath)) return repoRelativeTestPath(harnessRoot, subjectPath);
  let subjectRepoRoot: string;
  try {
    subjectRepoRoot = (await git(dirname(resolve(harnessRoot, testPath)), ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return null;
  }
  if (!isAbsolute(subjectRepoRoot)) return null;

  const testWithinRepo = repoRelativeTestPath(subjectRepoRoot, resolve(harnessRoot, testPath));
  const subjectWithinRepo = repoRelativeTestPath(subjectRepoRoot, resolve(subjectRepoRoot, subjectPath));
  if (!testWithinRepo || !subjectWithinRepo) return null;

  const harnessRelative = relative(harnessRoot, resolve(subjectRepoRoot, subjectPath));
  if (!harnessRelative || harnessRelative === '..' || harnessRelative.startsWith(`..${sep}`) || isAbsolute(harnessRelative)) {
    return null;
  }
  return harnessRelative.split(sep).join('/');
}

/**
 * EI-24826121815486916: the spec-evidence store pins a binding's measurement from this
 * checkout's bytes at BIND time. An as-committed run is content-verified against its commit;
 * every other run only executed what the checkout held when it ran. A measured file modified
 * after the run started may not be what ran, so its pin would describe code the run never saw.
 * Measured: two mutation-probe mutant runs bound `current` against a source a peer edited four
 * minutes after they ran, while an earlier plain test binding of the same file read stale.
 *
 * test_runs keeps no per-file content, so mtime is the only signal. That makes this
 * conservative: a rewrite with identical bytes also refuses, and the remedy is to re-run.
 * Pass the bound from `measurementLowerBound`, not bare started_at: the reporter derives
 * started_at as finished_at - duration, which postdates collection, so an edit after vitest
 * read a file but before its tests started is only seen against the run-wide start
 * (EI-24827834166866368). A missing file is left to the store's own measurement checks.
 */
export async function measuredFileModifiedAfterRun(
  root: string,
  paths: readonly string[],
  startedAt: Date | string | null | undefined,
): Promise<{ path: string; modifiedAt: string; startedAt: string } | null> {
  if (startedAt == null) return null;
  const started = startedAt instanceof Date ? startedAt : new Date(startedAt);
  if (Number.isNaN(started.getTime())) return null;
  for (const repoRelative of paths) {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(resolve(root, repoRelative))).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs > started.getTime()) {
      return { path: repoRelative, modifiedAt: new Date(mtimeMs).toISOString(), startedAt: started.toISOString() };
    }
  }
  return null;
}

/**
 * The earliest instant this run could have read a measured file: the run-wide start the
 * reporter stamps in execution_details.runStartedAt when present (taken in onInit, before
 * vitest collects any module), else the row's started_at. Whichever readable value is earlier
 * wins, so a row that carries both is never judged against the later, post-collection one.
 * Null when neither is readable, which measuredFileModifiedAfterRun treats as "cannot judge".
 */
export function measurementLowerBound(
  startedAt: Date | string | null | undefined,
  executionDetailsRaw: unknown,
): Date | null {
  const candidates: Date[] = [];
  for (const value of [startedAt, executionDetails(executionDetailsRaw).runStartedAt]) {
    if (value == null) continue;
    if (!(value instanceof Date) && typeof value !== 'string') continue;
    const at = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(at.getTime())) candidates.push(at);
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, at) => (at.getTime() < earliest.getTime() ? at : earliest));
}

/** WI-6554700010011901: record-run's file_path names generated proof, not executable code.
 * Qualify that writer's immutable output against its original commit and ledger before
 * removing only the generated testPath from the execution-time guard. Source paths retain
 * the guard, including an artifact explicitly declared as an input.
 */
async function committedOperationalOutput(
  root: string, testPath: string, row: TestRunEvidenceRow, git: GitRunner,
): Promise<{ sha256: string; commitSha: string } | null> {
  const execution = executionDetails(row.execution_details);
  const group = typeof execution.runGroupId === 'string'
    ? /^(?:operational:|operational-recovery:[1-9]\d*:)([a-f0-9]{40})$/.exec(execution.runGroupId)
    : null;
  if (!group || !testPath.startsWith('docs/evidence/') || !testPath.endsWith('.json')) return null;
  if (row.source !== 'local' || row.worktree_dirty !== false || !row.commit_sha || !FULL_SHA_RE.test(row.commit_sha)) {
    throw new Error('operational output lacks a clean local committed receipt');
  }
  const file = await realpath(resolve(root, testPath));
  if (!isWithin(await realOrResolved(root), file) || !(await stat(file)).isFile()) {
    throw new Error('operational output is outside its repository');
  }
  const bytes = readFileSync(file);
  const committed = await git(root, ['show', `${row.commit_sha}:${testPath}`]);
  if (!bytes.equals(Buffer.from(committed, 'utf8'))) {
    throw new Error('operational output differs from its recorded commit');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256.slice(0, 40) !== group[1]) throw new Error('operational output differs from its recorded hash');
  // Load the recorder's maintained validation after binding modules initialize; this
  // avoids introducing an eager tool-registration cycle or a second artifact schema.
  const { parseOperationalEvidenceArtifact, operationalExecution } = await import('../testing/record-run');
  const artifact = parseOperationalEvidenceArtifact(bytes);
  const expected = operationalExecution(artifact);
  const verdict = artifact.exitCode === 0 && artifact.assertions.every(assertion => assertion.passed) ? 'pass' : 'fail';
  if (artifact.framework !== row.framework || verdict !== row.status
    || isoOrNull(row.started_at ?? null) !== new Date(artifact.startedAt).toISOString()
    || isoOrNull(row.finished_at) !== new Date(artifact.finishedAt).toISOString()
    || execution.passed !== expected.passed || execution.failed !== expected.failed
    || execution.skipped !== expected.skipped || execution.collectionFailed !== expected.collectionFailed
    || (execution.runStartedAt !== undefined && Date.parse(String(execution.runStartedAt)) !== Date.parse(artifact.startedAt))) {
    throw new Error('operational output does not match its recorded execution');
  }
  return { sha256, commitSha: row.commit_sha };
}

export interface TestRunBindingScope {
  workspaceId: string;
  harnessSlug: string;
}

export interface TestRunBindingDeps {
  loadRun(scope: TestRunBindingScope, testRunId: number): Promise<TestRunEvidenceRow | null>;
  /** Conditionally stamp a still-unattributed run with the caller's scope; true when this call (or a racer) did. */
  adoptRun(scope: TestRunBindingScope, testRunId: number): Promise<boolean>;
  resolveRoot(scope: TestRunBindingScope): Promise<string>;
  /** WI-10006610: the registered sibling checkout a run recorded outside the harness checkout ran in. Absent = never. */
  resolveSiblingRoot?(
    scope: TestRunBindingScope,
    harnessRoot: string,
    recordedRoot: string | null,
  ): Promise<SiblingCheckout | null>;
  git?: GitRunner;
  /**
   * Surviving mutants of the same guard: mutation-probe rows that PASSED on a mutant leg
   * (execution_details.mutation.leg = 'mutant') for any of `filePaths`, whose descriptor
   * records `testFileSha256` and a probeInvocationId other than `excludeProbeInvocationId`.
   * A completed passing load-check with the exact same invocation/test/selection proves
   * the poisoned subject was not consumed, so that invocation is not a survivor.
   * Missing, failed, unmeasured or mismatched controls do not waive the re-aim refusal.
   * Ordered by started_at, at most MUTATION_REAIM_MAX_SURVIVORS. Absent = re-aim detection off.
   */
  loadMutationSurvivors?(
    scope: TestRunBindingScope,
    filePaths: readonly string[],
    testFileSha256: string,
    excludeProbeInvocationId: string,
  ): Promise<MutationSurvivor[]>;
}

export interface MutationSurvivor {
  id: number;
  probeInvocationId: string;
  mutateExpression: string | null;
  againstCommit: string | null;
}

export interface MutationReaimJustification {
  survivorTestRunIds: number[];
  reason: string;
}

export interface UnjustifiedMutationSurvivor {
  testRunId: number;
  /** The survivor's literal mutation expression, or `againstCommit:<sha>` for a historical leg. */
  mutation: string;
  why: 'not-named' | 'same-mutation-as-catch';
}

/** One comparable label per mutation: the literal expression, or the historical commit. */
export function mutationLabel(m: { mutateExpression: string | null; againstCommit: string | null }): string {
  return m.mutateExpression ?? `againstCommit:${m.againstCommit ?? ''}`;
}

/**
 * A catch is only evidence that the GUARD is strong if no other mutation of the subject
 * slipped past the very same test bytes. So a caught mutant whose test file, at the same
 * testFileSha256, let a mutant pass in another probe invocation is a re-aim: the mutation
 * moved until something failed, the guard did not get stronger. Editing the test file
 * changes its sha256, which is what separates a strengthened guard from a re-aim; time
 * does not enter into it (plan mutation-probe-evidence-value-2026-10-11 D-003).
 *
 * The catch still binds when `justification` names EVERY such survivor and none of them
 * ran the catch's own mutation (an identical mutation that both passed and failed against
 * identical test bytes is a flaky guard, which no reason can make sound). The record then
 * travels on the binding so a grader sees the re-aim instead of a clean first-try catch.
 * A row without a descriptor is not checked: there is nothing to scope survivors by.
 */
export function decideMutationReaim(args: {
  testRunId: number;
  caught: { mutateExpression: string | null; againstCommit: string | null } | null;
  survivors: readonly MutationSurvivor[];
  justification: MutationReaimJustification | undefined;
}):
  | {
    ok: false;
    error: 'mutation_reaim_unjustified';
    testRunId: number;
    unjustifiedSurvivors: UnjustifiedMutationSurvivor[];
    message: string;
  }
  | { ok: true; record: MutationReaimJustification | null } {
  if (!args.caught || args.survivors.length === 0) {
    return { ok: true, record: args.justification ? { ...args.justification } : null };
  }
  const named = new Set(args.justification?.survivorTestRunIds ?? []);
  const catchLabel = mutationLabel(args.caught);
  const unjustified: UnjustifiedMutationSurvivor[] = [];
  for (const s of args.survivors) {
    const mutation = mutationLabel(s);
    if (mutation === catchLabel) unjustified.push({ testRunId: s.id, mutation, why: 'same-mutation-as-catch' });
    else if (!named.has(s.id)) unjustified.push({ testRunId: s.id, mutation, why: 'not-named' });
  }
  if (unjustified.length > 0) {
    const list = unjustified
      .map((u) => `${u.testRunId} (${JSON.stringify(u.mutation)}${u.why === 'same-mutation-as-catch' ? ', the same mutation as this catch' : ''})`)
      .join('; ');
    return {
      ok: false,
      error: 'mutation_reaim_unjustified',
      testRunId: args.testRunId,
      unjustifiedSurvivors: unjustified,
      message:
        `test-run ${args.testRunId} is a caught mutant, but the same test file at the same testFileSha256 let a mutant ` +
        `pass in another probe invocation: ${list}. That is a re-aimed mutation, not a stronger guard. Strengthen the ` +
        'test and re-run the probe, or pass reaimJustification { survivorTestRunIds, reason } naming every survivor ' +
        'with a different mutation and why this catch is still sound evidence.',
    };
  }
  return { ok: true, record: args.justification ? { ...args.justification } : null };
}

export interface SiblingCheckout {
  /** The registry's content path for the checkout: the root the evidence store re-measures at. */
  root: string;
  harnessSlug: string;
}

async function realOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/**
 * WI-10006610: the registered checkout, OTHER than the plan harness's own, that a run's recorded
 * root lives in — a hive app such as email or portal. testing:run evidence already measures
 * there through `measurement.rootHarnessSlug` (EI-25203154942838341, run.ts
 * registeredHarnessSlugForRoot); a ledger row recorded in that checkout (a mutation probe, a
 * direct vitest run with the admin reporter) maps the same way instead of being refused as
 * outside the harness. The deepest registered checkout containing the root wins, so a nested
 * workspace run that recorded its package directory still resolves; on a tie a non-hive project
 * beats a repo-less hive borrowing the same path. Null when the root is inside the plan harness
 * checkout (submodules keep their existing mapping) or inside no registered checkout (a
 * disposable clone or copy-out mirror, which the as-committed / canonical paths handle), and on
 * a registry failure, which must not break those in-harness mappings.
 */
export async function registeredSiblingCheckout(
  scope: TestRunBindingScope,
  harnessRoot: string,
  recordedRoot: string | null | undefined,
  loadRegistry: typeof loadHarnessRegistry = loadHarnessRegistry,
): Promise<SiblingCheckout | null> {
  if (!recordedRoot || !isAbsolute(recordedRoot)) return null;
  const recorded = await realOrResolved(recordedRoot);
  if (isWithin(await realOrResolved(harnessRoot), recorded)) return null;
  let registry: Awaited<ReturnType<typeof loadHarnessRegistry>>;
  try {
    registry = await loadRegistry(scope.workspaceId);
  } catch {
    return null;
  }
  let best: { root: string; real: string; harnessSlug: string; hive: boolean } | null = null;
  for (const project of registry.projects) {
    if (project.slug === scope.harnessSlug) continue;
    const path = resolveHarnessContentPath(registry, project.slug);
    if (!path || !isAbsolute(path)) continue;
    const real = await realOrResolved(path);
    if (real === sep || !isWithin(real, recorded)) continue;
    const hive = project.harness_kind === 'hive';
    if (!best || real.length > best.real.length || (real.length === best.real.length && best.hive && !hive)) {
      best = { root: resolve(path), real, harnessSlug: project.slug, hive };
    }
  }
  return best && { root: best.root, harnessSlug: best.harnessSlug };
}

export const defaultTestRunBindingDeps: TestRunBindingDeps = {
  async loadRun(scope, testRunId) {
    return withWorkspace(scope.workspaceId, async (tx) => {
      const rows = await tx<TestRunEvidenceRow[]>`
        SELECT id, file_path, status, source, harness_slug, workspace_id, commit_sha,
               worktree_dirty, execution_details, started_at, finished_at, framework
          FROM harness_shared.test_runs
         WHERE id = ${testRunId}`;
      const row = rows[0];
      if (!row) return null;
      const recordedRoot = executionDetails(row.execution_details).root;
      return { ...row, root: typeof recordedRoot === 'string' ? recordedRoot : null };
    });
  },
  async loadMutationSurvivors(scope, filePaths, testFileSha256, excludeProbeInvocationId) {
    if (!filePaths.length) return [];
    return withWorkspace(scope.workspaceId, async (tx) => {
      const rows = await tx<{ id: string | number; mutation: unknown }[]>`
        SELECT survivor.id, survivor.execution_details->'mutation' AS mutation
          FROM harness_shared.test_runs survivor
         WHERE survivor.source = 'mutation-probe'
           AND survivor.status = 'pass'
           AND survivor.execution_details->'mutation'->>'leg' = 'mutant'
           AND survivor.execution_details->'mutation'->>'testFileSha256' = ${testFileSha256}
           AND survivor.execution_details->'mutation'->>'probeInvocationId' <> ${excludeProbeInvocationId}
           AND survivor.file_path = ANY(${[...filePaths]}::text[])
           AND (survivor.workspace_id IS NULL OR survivor.workspace_id = ${scope.workspaceId})
           AND NOT EXISTS (
             -- WI-6554700010015717: copy-out runs the same command with a top-level
             -- poison after a mutant passes. If that also passes, the probe never
             -- loaded the subject; its earlier PASS is not mutation survival.
             SELECT 1 FROM harness_shared.test_runs control
              WHERE control.source = 'mutation-probe' AND control.status = 'pass'
                AND survivor.execution_details->'mutation'->>'mode' = 'copy-out'
                AND control.execution_details->>'mutationPhase' = 'load-check'
                AND control.execution_details->'mutation'->>'leg' = 'load-check'
                AND (control.execution_details->'mutation')::jsonb - 'leg' = (survivor.execution_details->'mutation')::jsonb - 'leg'
                AND control.file_path = survivor.file_path
                AND control.workspace_id IS NOT DISTINCT FROM survivor.workspace_id
                AND control.harness_slug IS NOT DISTINCT FROM survivor.harness_slug
                AND control.framework IS NOT DISTINCT FROM survivor.framework
                AND control.execution_details->>'root' = survivor.execution_details->>'root'
                AND control.execution_details ? 'testNamePattern'
                AND survivor.execution_details ? 'testNamePattern'
                AND control.execution_details->>'testNamePattern' IS NOT DISTINCT FROM survivor.execution_details->>'testNamePattern'
                AND control.execution_details->'collectionFailed' = 'false'::jsonb
                AND jsonb_typeof(control.execution_details->'passed') = 'number'
                AND control.execution_details->'passed' > '0'::jsonb
                AND control.execution_details->'failed' = '0'::jsonb
                AND control.execution_details->'skipped' = '0'::jsonb
                AND control.started_at >= survivor.finished_at
                AND control.finished_at >= control.started_at
           )
         ORDER BY survivor.started_at, survivor.id
         LIMIT ${MUTATION_REAIM_MAX_SURVIVORS}`;
      return rows.flatMap((r) => {
        const m = parseMutationDescriptor(r.mutation);
        return m
          ? [{ id: Number(r.id), probeInvocationId: m.probeInvocationId,
            mutateExpression: m.mutateExpression, againstCommit: m.againstCommit }]
          : [];
      });
    });
  },
  async adoptRun(scope, testRunId) {
    return withWorkspace(scope.workspaceId, async (tx) => {
      await tx`
        UPDATE harness_shared.test_runs
           SET harness_slug = ${scope.harnessSlug},
               workspace_id = ${scope.workspaceId}
         WHERE id = ${testRunId}
           AND harness_slug IS NULL
           AND (workspace_id IS NULL OR workspace_id = ${scope.workspaceId})
           AND source NOT IN ('ci', 'admin-ui')`;
      // Re-read rather than trust the row count: a racer that adopted the same row
      // into the SAME scope is a success, one that adopted it elsewhere is not.
      const rows = await tx<{ harness_slug: string | null; workspace_id: string | null }[]>`
        SELECT harness_slug, workspace_id FROM harness_shared.test_runs WHERE id = ${testRunId}`;
      return rows[0]?.harness_slug === scope.harnessSlug && rows[0]?.workspace_id === scope.workspaceId;
    });
  },
  async resolveRoot(scope) {
    const registry = await loadHarnessRegistry(scope.workspaceId);
    const root = resolveHarnessContentPath(registry, scope.harnessSlug);
    if (!root) throw new Error(`repo_measurement_harness_root_unavailable:${scope.harnessSlug}`);
    return root;
  },
  resolveSiblingRoot: (scope, harnessRoot, recordedRoot) => registeredSiblingCheckout(scope, harnessRoot, recordedRoot),
};

/** Load, scope-check, adopt if unattributed, then derive. */
export async function expandTestRunBinding(
  input: TestRunBindingInput,
  scope: TestRunBindingScope,
  deps: TestRunBindingDeps = defaultTestRunBindingDeps,
): Promise<TestRunExpansion> {
  try {
    return await expandTestRunBindingInScope(input, scope, deps);
  } catch (error) {
    if (!(error instanceof AsCommittedProbeError)) throw error;
    return {
      ok: false, error: 'test_run_as_committed_probe_failed', testRunId: input.fromTestRun,
      message: `test-run ${input.fromTestRun} committed test path could not be verified: ${error.message}. No binding was created.`,
    };
  }
}

async function expandTestRunBindingInScope(
  input: TestRunBindingInput,
  scope: TestRunBindingScope,
  deps: TestRunBindingDeps,
): Promise<TestRunExpansion> {
  const testRunId = input.fromTestRun;
  let row = await deps.loadRun(scope, testRunId);
  if (!row) {
    return { ok: false, error: 'test_run_not_found', testRunId, message: `no test_runs row has id ${testRunId}.` };
  }
  if (row.workspace_id != null && row.workspace_id !== scope.workspaceId) {
    return {
      ok: false,
      error: 'test_run_out_of_scope',
      testRunId,
      message: `test-run ${testRunId} belongs to workspace '${row.workspace_id}', not '${scope.workspaceId}'.`,
    };
  }
  let attribution: HarnessAttribution = 'run';
  let harnessRoot: string | undefined;
  let sibling: SiblingCheckout | null | undefined;
  if (row.harness_slug == null) {
    if (NEVER_ADOPTED_SOURCES.has(String(row.source))) {
      return {
        ok: false,
        error: 'test_run_not_adoptable',
        testRunId,
        message:
          `test-run ${testRunId} is a ${row.source} row, harness-NULL by design; it is not re-attributed. ` +
          `Re-run the file with testing:run { harness: '${scope.harnessSlug}', files: ['${row.file_path}'] } and bind that run.`,
      };
    }
    if (!(await deps.adoptRun(scope, testRunId))) {
      return {
        ok: false,
        error: 'test_run_not_adoptable',
        testRunId,
        message: `test-run ${testRunId} was attributed elsewhere while this call tried to adopt it into '${scope.harnessSlug}'.`,
      };
    }
    // `loadRun` returned the pre-adoption snapshot. Mirror the successful guarded
    // UPDATE for downstream scope checks, while leaving execution_details intact:
    // those receipts describe the original run and are the runtime witness.
    row = { ...row, harness_slug: scope.harnessSlug, workspace_id: scope.workspaceId };
    attribution = 'adopted-caller-harness';
  } else if (row.harness_slug !== scope.harnessSlug) {
    // A registered sibling run keeps its own attribution, but may be bound to a plan in this
    // harness when its recorded root resolves to that exact sibling checkout. Resolve this
    // before rejecting the harness mismatch; the later mapping path reuses the same root.
    try {
      harnessRoot = await deps.resolveRoot(scope);
      sibling = deps.resolveSiblingRoot
        ? await deps.resolveSiblingRoot(scope, harnessRoot, row.root ?? null)
        : null;
    } catch {
      sibling = null;
    }
    if (!sibling || sibling.harnessSlug !== row.harness_slug) {
      return {
        ok: false,
        error: 'test_run_out_of_scope',
        testRunId,
        message:
          `test-run ${testRunId} is attributed to harness '${row.harness_slug}', not the plan harness '${scope.harnessSlug}', ` +
          `and its recorded root is not that registered sibling checkout. ` +
          `Re-record it with PAPERCUSP_TEST_RUN_HARNESS='${scope.harnessSlug}' and bind the new row.`,
      };
    }
  }
  const controlsRefusal = mutationCausalControlsRefusal(input, row);
  if (controlsRefusal) return controlsRefusal;
  if ((input.evidenceKind ?? deriveKind(row)) === 'mutation' && input.details?.causalControls !== undefined) {
    // The shape and mutant identity were checked above; verify the two actual
    // ledger controls too, rather than trusting a copied caller description.
    const controls = input.details.causalControls as { baselineTestRunId: number; copyBaselineTestRunId: number };
    const controlIds = [controls.baselineTestRunId, controls.copyBaselineTestRunId];
    const rows = await Promise.all(controlIds.map(async id => {
      let control = await deps.loadRun(scope, id);
      // Mutation-probe controls are often recorded with harness_slug NULL before
      // their first evidence bind. Attribute those local rows to this caller's
      // harness using the same guarded adoption path as the mutant; otherwise a
      // valid same-workspace/same-commit baseline is rejected before it can be
      // bound. CI and admin-ui rows remain harness-NULL by design.
      if (control !== null && control.harness_slug == null
        && (control.workspace_id == null || control.workspace_id === scope.workspaceId)
        && !NEVER_ADOPTED_SOURCES.has(String(control.source))) {
        const adopted = await deps.adoptRun(scope, id);
        control = adopted
          ? { ...control, harness_slug: scope.harnessSlug, workspace_id: scope.workspaceId }
          : await deps.loadRun(scope, id);
      }
      return control;
    }));
    for (const [index, control] of rows.entries()) {
      if (!control || Number(control.id) !== controlIds[index] || control.status !== 'pass'
        || control.workspace_id !== scope.workspaceId || control.harness_slug !== (row.harness_slug ?? scope.harnessSlug)
        || !row.commit_sha || !control.commit_sha || control.commit_sha.toLowerCase() !== row.commit_sha.toLowerCase()) {
        return { ok: false, error: 'mutation_causal_controls_invalid', testRunId,
          message: `Mutation causal control test-run ${controlIds[index]} must exist, pass and match the bound mutant's workspace, harness and known commit.` };
      }
    }
    const unlinked = mutationCausalControlsUnlinked(row, rows as TestRunEvidenceRow[], controlIds);
    if (unlinked) return unlinked;
  }
  const resolvedHarnessRoot = harnessRoot ?? await deps.resolveRoot(scope);
  if (sibling === undefined) {
    sibling = deps.resolveSiblingRoot
      ? await deps.resolveSiblingRoot(scope, resolvedHarnessRoot, row.root ?? null)
      : null;
  }
  // WI-10006610: a run recorded in a registered sibling checkout (a hive app) maps and measures
  // at THAT checkout, and the binding names it so the store re-measures there.
  const root = sibling?.root ?? resolvedHarnessRoot;
  // WI-10006836: a cargo row names a test, not a file, so it maps only through an explicit
  // canonicalTestPath that defines that test inside the recorded crate (any source: a local run
  // and an in-tree mutation probe record the same shape).
  let cargo = row.framework === 'cargo' ? cargoTestRef(row.file_path) : null;
  let cargoMapping: AsCommittedMapping | null = null;
  if (cargo?.sourcePath) {
    const targetRow = { ...row, file_path: cargo.sourcePath };
    const recordedTarget = await recordedTestPath(root, targetRow, deps.git);
    if (!recordedTarget) cargoMapping = await asCommittedTestPath(root, targetRow, deps.git);
    const target = recordedTarget ?? cargoMapping?.testPath;
    if (target) cargo = { ...cargo, sourcePath: target, crateDir: dirname(target) };
  }
  if (row.framework === 'cargo') {
    if (!cargo) {
      return {
        ok: false,
        error: 'test_run_cargo_not_a_test',
        testRunId,
        message:
          `test-run ${testRunId} (${JSON.stringify(row.file_path)}) is a cargo binary aggregate, not one test; ` +
          "bind one of the run's per-test rows ('<target-source.rs>::<test>' or legacy '<crate-dir>::<test>').",
      };
    }
    if (!input.canonicalTestPath) {
      return {
        ok: false,
        error: 'test_run_cargo_test_path_required',
        testRunId,
        message:
          `cargo recorded test-run ${testRunId} as case ${JSON.stringify(cargo.testName)}; pass canonicalTestPath: ` +
          (cargo.sourcePath ? `the recorded .rs source ${JSON.stringify(cargo.sourcePath)}.`
            : `the .rs file under ${cargo.crateDir}/ that defines it.`),
      };
    }
    const refusal = cargoCanonicalTestPathRefusal(root, cargo, input.canonicalTestPath);
    if (refusal) return { ok: false, error: 'test_run_canonical_path_mismatch', testRunId, message: refusal };
  }
  let testPath = cargo && input.canonicalTestPath ? input.canonicalTestPath : await recordedTestPath(root, row, deps.git);
  // WI-10004898: a clean run in a disposable clone (lint:as-committed) maps by commit content.
  let asCommitted: AsCommittedMapping | null = null;
  // A distinct worktree can share this repository's common Git directory, so
  // recordedTestPath already resolves it. A clean receipt still exercised its
  // recorded commit, not later edits in this checkout. Keep the existing
  // commit-content verification instead of applying this checkout's mtime guard.
  if (testPath && !cargo && !input.canonicalTestPath && row.worktree_dirty === false
    && row.root && !(await sameDirectory(root, row.root))) {
    const git = withRepoIdentityMemo(deps.git ?? defaultGitRunner);
    try {
      const [rootTop, recordedTop] = await Promise.all([
        git(root, ['rev-parse', '--show-toplevel']),
        git(row.root, ['rev-parse', '--show-toplevel']),
      ]);
      if (isAbsolute(rootTop.trim()) && isAbsolute(recordedTop.trim())
        && !(await sameDirectory(rootTop.trim(), recordedTop.trim()))) {
        const mapped = await asCommittedTestPath(root, row, git);
        if (mapped?.testPath === testPath) asCommitted = mapped;
      }
    } catch (error) {
      if (error instanceof AsCommittedProbeError) throw error;
      // Unverified identity retains the existing mutable-checkout safeguards.
    }
  }
  if (cargo && input.canonicalTestPath && row.worktree_dirty === false && row.commit_sha && FULL_SHA_RE.test(row.commit_sha)) {
    asCommitted = cargoMapping
      ? { ...cargoMapping, testPath: input.canonicalTestPath }
      : { testPath: input.canonicalTestPath,
        repoPrefix: await canonicalAsCommittedPrefix(root, input.canonicalTestPath, row.commit_sha, deps.git),
        commitSha: row.commit_sha };
  }
  if (input.canonicalTestPath && !cargo) {
    const recordedRelative = row.root && isAbsolute(row.root) && row.file_path
      ? repoRelativeTestPath(row.root, row.file_path)
      : null;
    const matchingSuffix = recordedRelative && (
      input.canonicalTestPath === recordedRelative || input.canonicalTestPath.endsWith(`/${recordedRelative}`)
    );
    // Copy-out mirrors are temporary and are intentionally not Git worktrees.
    // Only an explicitly named canonical test in the same harness can replace
    // their path; never use a caller-supplied path for another run source.
    if (row.source !== 'mutation-probe') {
      return {
        ok: false,
        error: 'test_run_canonical_path_source_unsupported',
        testRunId,
        message:
          `canonicalTestPath is only supported for mutation-probe copy-out runs; test-run ${testRunId} has source ${JSON.stringify(row.source)}. ` +
          'Omit canonicalTestPath to bind the recorded test file.',
      };
    }
    if (!matchingSuffix) {
      return {
        ok: false,
        error: 'test_run_canonical_path_mismatch',
        testRunId,
        message: recordedRelative
          ? `canonicalTestPath ${JSON.stringify(input.canonicalTestPath)} does not preserve mutation-probe run ${testRunId}'s recorded relative test path ${JSON.stringify(recordedRelative)}.`
          : `canonicalTestPath cannot be checked because mutation-probe run ${testRunId}'s file cannot be resolved relative to its recorded root.`,
      };
    }
    if (testPath && testPath !== input.canonicalTestPath) {
      return {
        ok: false,
        error: 'test_run_canonical_path_mismatch',
        testRunId,
        message:
          `canonicalTestPath ${JSON.stringify(input.canonicalTestPath)} differs from the recorded test path ${JSON.stringify(testPath)} in this harness checkout.`,
      };
    }
    try {
      readFileSync(resolve(root, input.canonicalTestPath));
      testPath = input.canonicalTestPath;
    } catch {
      return {
        ok: false,
        error: 'test_run_file_outside_root',
        testRunId,
        message: `canonicalTestPath ${JSON.stringify(input.canonicalTestPath)} is not a readable test in this harness checkout.`,
      };
    }
    // A CLEAN, commit-stamped copy-out row (its probe's origin root was an as-committed clone)
    // executed that commit's files, not this checkout's. Verify the measured files against the
    // commit exactly like a clone run, or the pin would fingerprint whatever the shared tree
    // holds at bind time (measured: a peer's later bulk-run-store.ts edit pinned onto a mutant
    // that mutated the committed blob). Dirty or commit-less rows keep the checkout pin.
    if (row.worktree_dirty === false && row.commit_sha && FULL_SHA_RE.test(row.commit_sha)) {
      asCommitted = {
        testPath: input.canonicalTestPath,
        repoPrefix: await canonicalAsCommittedPrefix(root, input.canonicalTestPath, row.commit_sha, deps.git),
        commitSha: row.commit_sha,
      };
    }
  }
  if (!testPath && !input.canonicalTestPath) {
    asCommitted = await asCommittedTestPath(root, row, deps.git);
    testPath = asCommitted?.testPath ?? null;
  }
  if (!testPath) {
    const cleanCommit = row.worktree_dirty === false && row.commit_sha ? row.commit_sha.slice(0, 12) : null;
    return {
      ok: false,
      error: 'test_run_file_outside_root',
      testRunId,
      message:
        `test-run ${testRunId} file ${JSON.stringify(row.file_path)} at recorded root ${JSON.stringify(row.root)} cannot be mapped to this harness checkout (${root}).` +
        (cleanCommit
          ? ` Its clean commit ${cleanCommit} does not contain that file in this repository or in a submodule named by the recorded root.`
          : ''),
    };
  }
  let mutantSubjectPathAtRoot: string | undefined;
  if (!input.sourcePaths) {
    const descriptor = parseMutationDescriptor(executionDetails(row.execution_details).mutation);
    if (descriptor?.leg === 'mutant' && !isAbsolute(descriptor.subjectPath)) {
      mutantSubjectPathAtRoot = await mutationSubjectPathAtHarnessRoot(
        root,
        testPath,
        descriptor.subjectPath,
        deps.git ?? defaultGitRunner,
      ) ?? undefined;
      if (!mutantSubjectPathAtRoot) {
        return {
          ok: false,
          error: 'source_paths_underivable',
          testRunId,
          message:
            `test-run ${testRunId} mutation subject ${JSON.stringify(descriptor.subjectPath)} is relative to a Git root ` +
            `that could not be mapped from ${JSON.stringify(testPath)} into this harness checkout (${root}); pass sourcePaths.`,
        };
      }
    }
  }
  const result = deriveBindingFromTestRun(
    input,
    { ...row, file_path: testPath },
    root,
    attribution,
    mutantSubjectPathAtRoot,
  );
  if (result.ok && sibling) {
    result.binding.measurement = { ...result.binding.measurement, rootHarnessSlug: sibling.harnessSlug };
  }
  let fixtureSupportPaths: string[] = [];
  if (result.ok && declaresFixtureCalibration(input.details)) {
    try {
      fixtureSupportPaths = deriveFixtureSupportPaths(root, testPath);
    } catch (error) {
      return {
        ok: false,
        error: 'fixture_paths_underivable',
        testRunId,
        message: 'could not recheck first-party test-support imports from ' + testPath
          + ' (' + String(error) + '); no calibrated binding was created.',
      };
    }
  }
  if (result.ok && asCommitted) {
    // Declared paths only: source globs are expanded against the commit itself when the
    // binding is measured there, so a glob match that exists only in this checkout is moot.
    const { testPaths, sourcePaths } = result.binding.measurement;
    const measured = [...new Set([...testPaths, ...sourcePaths, ...fixtureSupportPaths])].sort();
    const content = await verifyAsCommittedContent(root, asCommitted, measured, deps.git ?? defaultGitRunner);
    if (!content.ok) {
      if (content.probeFailed) {
        return {
          ok: false,
          error: 'test_run_as_committed_probe_failed',
          testRunId,
          message: `test-run ${testRunId} committed source could not be verified: ${content.path}: ${content.reason}. No binding was created.`,
        };
      }
      return {
        ok: false,
        error: 'test_run_as_committed_content_mismatch',
        testRunId,
        message:
          `test-run ${testRunId} ran clean at ${asCommitted.commitSha.slice(0, 12)} in a disposable clone, but ${content.path} ` +
          `${content.reason}, so the binding would name a file the run never had. ` +
          'Bind only paths committed at the run\'s commit, or re-run the test at a commit that contains them.',
      };
    }
  }
  if (result.ok && !asCommitted) {
    const { testPaths } = result.binding.measurement;
    const sourcePaths = await expandRepoFilesEvidenceSourcePathsAtRoot(root, result.binding.measurement);
    let output: { sha256: string; commitSha: string } | null;
    try {
      output = await committedOperationalOutput(root, testPath, row, deps.git ?? defaultGitRunner);
    } catch (error) {
      return { ok: false, error: 'test_run_as_committed_content_mismatch', testRunId,
        message: `test-run ${testRunId} generated output cannot be authenticated: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (output) (result.binding.details.testRun as Record<string, unknown>).operationalArtifact = output;
    const guardedTestPaths = output ? testPaths.filter(path => path !== testPath) : testPaths;
    const measured = [...new Set([...guardedTestPaths, ...sourcePaths, ...fixtureSupportPaths])].sort();
    if (measured.length > 0 && !isRecordedInstant(executionDetails(row.execution_details).runStartedAt)) {
      return {
        ok: false,
        error: 'test_run_measurement_start_missing',
        testRunId,
        message:
          `test-run ${testRunId} has no valid execution_details.runStartedAt, so a mutable-checkout binding cannot prove ` +
          'which source bytes it executed. Re-run the test with a writer that records the run-wide start, or bind an as-committed run.',
      };
    }
    const changed = await measuredFileModifiedAfterRun(
      root,
      measured,
      measurementLowerBound(row.started_at, row.execution_details),
    );
    if (changed) {
      return {
        ok: false,
        error: 'test_run_source_modified_after_run',
        testRunId,
        message:
          `test-run ${testRunId} started at ${changed.startedAt}, but ${changed.path} was modified at ${changed.modifiedAt}, ` +
          'so the binding would fingerprint bytes this run may never have executed. Re-run the test and bind the new run.',
      };
    }
  }
  if (result.ok && deps.loadMutationSurvivors) {
    const caughtMutant = (input.evidenceKind ?? deriveKind(row)) === 'mutation' && row.status === 'fail';
    const descriptor: MutationDescriptor | undefined = caughtMutant
      ? parseMutationDescriptor(executionDetails(row.execution_details).mutation)
      : undefined;
    const testFileSha256 = descriptor?.leg === 'mutant' ? descriptor.testFileSha256 : null;
    const caught = descriptor && testFileSha256 ? descriptor : null;
    const survivors = caught && testFileSha256
      ? await deps.loadMutationSurvivors(
        scope,
        [...new Set([row.file_path ?? testPath, testPath])],
        testFileSha256,
        caught.probeInvocationId,
      )
      : [];
    const reaim = decideMutationReaim({
      testRunId: Number(row.id),
      caught,
      survivors,
      justification: input.reaimJustification,
    });
    if (!reaim.ok) return reaim;
    if (reaim.record) (result.binding.details as Record<string, unknown>).reaim = reaim.record;
  }
  if (result.ok) {
    Object.assign(result.binding.details.testRun as Record<string, unknown>, {
      recordedRoot: row.root ?? null,
      recordedFilePath: row.file_path,
      ...(sibling ? { rootHarnessSlug: sibling.harnessSlug } : {}),
      ...(input.canonicalTestPath ? { canonicalTestPathOverride: input.canonicalTestPath } : {}),
      ...(asCommitted
        ? { asCommitted: { commitSha: asCommitted.commitSha, repoPrefix: asCommitted.repoPrefix, measuredAtCommit: true } }
        : {}),
    });
  }
  return result;
}
