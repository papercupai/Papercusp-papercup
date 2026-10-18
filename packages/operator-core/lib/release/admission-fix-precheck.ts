import { papercuspPath } from '@papercusp/host-platform/home';
/**
 * P-006 / R6 (green-gate-zero-wait-convergence-2026-09-08, D-002): the ADMISSION FIX PRE-CHECK.
 *
 * Before the repair-queue admit door PUBLISHES an admission onto the frozen lineage, it runs the
 * frozen signature's `test-file` entries plus any admitted test files at the BUILT (still
 * unpublished) admission commit, and refuses:
 *
 *   - `admission-imports-red`   — an admitted test file OUTSIDE the signature fails at the built
 *                                 commit: the admission would import a new red into the lineage.
 *   - `admission-does-not-fix`  — the signature consists ONLY of `test-file` entries and NONE of
 *                                 them pass at the built commit: the admission fixes nothing it
 *                                 claims to. When the signature carries other kinds (lint-leg,
 *                                 workspace-task, post-suite-leg, seed) a test run cannot prove
 *                                 "fixes nothing", so only imports-red applies.
 *
 * Unmeasured files (route error, matched=0, runner crash) refuse as unavailable; they never
 * establish a failed assertion or prove that an admission fixes nothing.
 *
 * The pre-check uses its own checkout beside the gate's checkpoint tree. A gate run that is
 * already active still reports `checkpoint-tree-busy` and the door ACCEPTS the admission with a
 * loud `precheck:{ran:false}` marker — the R-1 event-driven re-judge measures it. A gate run
 * starting later cannot re-pin the pre-check's checkout midway through its test files.
 *
 * Layering: `precheckPopulation` + `evaluateFixPrecheck` are PURE (unit-tested without a tree);
 * `FixPrecheckRunner` is the seam the door injects; `createCheckpointTreeFixPrecheckRunner` is
 * the real runner (setup-release-checkout into its dedicated checkout,
 * `scripts/test-files.mjs` per file), guarded by the gate's initial run-lock probe.
 */
import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, createWriteStream, existsSync, mkdirSync, statSync, type WriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDependencyGenerationRoot } from './dependency-generation-root';
import type { RepairSignatureEntry, RepairSignatureKind } from './frozen-candidate-repair-queue';
import { isCheckpointRunLockHeldCheap } from '../release-checkpoint-lock';
import { dependencyGenerationInfraCode } from './checkpoint-log-tags';
import { evaluateAdmissionRatchet, impliedPreviousHead, type RatchetNewFailure } from './admission-ratchet';
export { dependencyGenerationInfraCode, DEPENDENCY_GENERATION_INFRA_EXITS,
  type DependencyGenerationInfraCode } from './checkpoint-log-tags';
// Reuse the focused runner's maintained assertion-summary parser.
import { testsExecutedFrom } from '../../../../scripts/lib/vitest-summary.mjs';

export const ADMISSION_PRECHECK_REFUSALS = Object.freeze([
  'admission-does-not-fix',
  'admission-imports-red',
  'admission-precheck-unavailable',
] as const);
export type AdmissionPrecheckRefusalCode = (typeof ADMISSION_PRECHECK_REFUSALS)[number];

/** A repo-relative path the test router would run as a test file. */
export const TEST_FILE_RE = /\.(?:integration\.)?(?:test|spec|node-test)\.[cm]?[jt]sx?$/;

export function isTestFilePath(p: string): boolean {
  return TEST_FILE_RE.test(p);
}

export type SignatureLike = Pick<RepairSignatureEntry, 'kind' | 'id'> & Partial<Pick<RepairSignatureEntry, 'workspace'>>;

/**
 * P-007 (green-main-cycle-time-2026-10-08#D-036): an ordinary admission's related-test radius,
 * selected at the BUILT commit. `measured` = the radius files are in the population; `skipped`
 * = the radius was too wide or could not be computed, so the next targeted round (P-005)
 * measures it instead — a loud marker, never a silent omission; `not-applicable` = the
 * admission named no source path a test could import.
 */
export type AdmissionRadiusStatus = 'measured' | 'skipped' | 'not-applicable';

export interface AdmissionRadius {
  status: AdmissionRadiusStatus;
  /** `ok` when measured; otherwise why: `over-cap(n/cap)`, `selection-full:<reason>`, `radius-unavailable`, `no-source-paths`. */
  reason: string;
  detail?: string;
  /** Previously green radius test files: one failing at the built commit refuses `admission-imports-red`. */
  guarded: string[];
  /**
   * Radius files inside a workspace whose `workspace-task` leg the signature already names red:
   * measured and reported (`reportOnlyRed`), but they cannot refuse — that leg was not green.
   */
  reportOnly: string[];
  /** Test file (radius or admitted) → its leg: the owning npm workspace name, when known. */
  legs: Record<string, string>;
}

export interface FixPrecheckPopulation {
  /** Signature `test-file` ids — the reds the admission claims to fix. */
  signatureTestFiles: string[];
  /** Admitted paths that are test files and NOT in the signature — a fresh red here is an import. */
  admittedTestFiles: string[];
  /** Signature kinds other than `test-file` present (each defeats the does-not-fix proof). */
  nonTestKinds: RepairSignatureKind[];
  /** True only when the signature is non-empty and consists solely of `test-file` entries. */
  canProveDoesNotFix: boolean;
  /** P-007: the admitted paths' related-test radius; absent when none was computed (gitlink or legacy). */
  radius?: AdmissionRadius;
  /** Every file to run, in run order: signature, admitted, guarded radius, report-only radius. */
  files: string[];
}

function normalize(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

export function precheckPopulation(input: {
  signature: readonly SignatureLike[];
  admittedPaths: readonly string[];
  /** Dependency-selected files from the immutable admission, outside the signature. */
  affectedTestFiles?: readonly string[];
  /**
   * P-007: the ordinary admission's radius. Its files never count as admitted, even when they
   * also appear in `admittedPaths` (the managed worker rebuilds from the persisted `files`).
   * The inventory keeps radius and admitted test files disjoint, so an explicitly admitted
   * test file is never demoted to report-only.
   */
  radius?: AdmissionRadius;
}): FixPrecheckPopulation {
  const signatureTestFiles: string[] = [];
  const nonTestKinds = new Set<RepairSignatureKind>();
  for (const entry of input.signature) {
    if (entry.kind === 'test-file') {
      const id = normalize(entry.id);
      if (id && !signatureTestFiles.includes(id)) signatureTestFiles.push(id);
    } else {
      nonTestKinds.add(entry.kind);
    }
  }
  const radiusFiles = new Set(
    [...(input.radius?.guarded ?? []), ...(input.radius?.reportOnly ?? [])].map(normalize),
  );
  const admittedTestFiles: string[] = [];
  for (const raw of [...input.admittedPaths, ...(input.affectedTestFiles ?? [])]) {
    const p = normalize(raw);
    if (!p || !isTestFilePath(p) || radiusFiles.has(p)) continue;
    if (signatureTestFiles.includes(p) || admittedTestFiles.includes(p)) continue;
    admittedTestFiles.push(p);
  }
  let radius: AdmissionRadius | undefined;
  if (input.radius) {
    const taken = new Set([...signatureTestFiles, ...admittedTestFiles]);
    const keep = (list: readonly string[]): string[] => {
      const out: string[] = [];
      for (const raw of list) {
        const p = normalize(raw);
        if (!p || !isTestFilePath(p) || taken.has(p)) continue;
        taken.add(p);
        out.push(p);
      }
      return out;
    };
    const guarded = keep(input.radius.guarded);
    const reportOnly = keep(input.radius.reportOnly);
    const legs: Record<string, string> = {};
    for (const [file, leg] of Object.entries(input.radius.legs ?? {})) {
      const p = normalize(file);
      if (p && typeof leg === 'string' && leg) legs[p] = leg;
    }
    radius = {
      status: input.radius.status,
      reason: input.radius.reason,
      ...(input.radius.detail ? { detail: input.radius.detail } : {}),
      guarded,
      reportOnly,
      legs,
    };
  }
  return {
    signatureTestFiles,
    admittedTestFiles,
    nonTestKinds: [...nonTestKinds],
    canProveDoesNotFix: signatureTestFiles.length > 0 && nonTestKinds.size === 0,
    ...(radius ? { radius } : {}),
    files: [...signatureTestFiles, ...admittedTestFiles, ...(radius?.guarded ?? []), ...(radius?.reportOnly ?? [])],
  };
}

/** `path (leg <workspace>)` when the leg is known, else the bare path. */
function withLeg(population: FixPrecheckPopulation, file: string): string {
  const leg = population.radius?.legs[file];
  return leg ? `${file} (leg ${leg})` : file;
}

export type FixPrecheckFileStatus = 'pass' | 'fail' | 'unmeasured';

export interface FixPrecheckFileResult {
  path: string;
  status: FixPrecheckFileStatus;
  /** Why an `unmeasured` file could not be judged (route error, matched=0, timeout, crash). */
  detail?: string;
  exitCode?: number | null;
  durationMs?: number;
}

export type FixPrecheckBusyReason = 'checkpoint-tree-busy';

export type FixPrecheckRunResult =
  | { ran: true; commit: string; results: FixPrecheckFileResult[]; setup?: { durationMs: number } }
  | { ran: false; reason: FixPrecheckBusyReason; detail: string; holder?: { pid?: number; elapsedSec: number | null } }
  | { ran: false; reason: 'runner-failed'; detail: string };

/** A durable liveness snapshot during setup or measurement of the current file. */
export interface FixPrecheckProgress {
  /** Repo-relative file being prepared or measured. Setup retains the first queued file. */
  currentFile: string;
  /** Number of files that completed before `currentFile` started. */
  completedCount: number;
  /** Total files in this pre-check operation. */
  totalCount: number;
  /** Wall-clock time at which this snapshot was observed. */
  heartbeatAtMs: number;
}

/**
 * The progress callback is observability only: a failed persistence attempt must not turn a
 * measured test result into a runner failure. Implementations should nevertheless await their
 * CAS write so `op:get` sees the snapshot before the corresponding test process starts.
 */
export type FixPrecheckProgressCallback = (progress: FixPrecheckProgress) => Promise<void> | void;

/** The seam the admit door injects: measure `files` at `commit` (a real, unpublished object in the root's store). */
export type FixPrecheckRunner = (input: {
  commit: string;
  files: readonly string[];
  onProgress?: FixPrecheckProgressCallback;
}) => Promise<FixPrecheckRunResult>;

export type FixPrecheckVerdict =
  | {
      ok: true;
      ran: true;
      commit: string;
      population: FixPrecheckPopulation;
      results: FixPrecheckFileResult[];
      passing: string[];
      failing: string[];
      unmeasured: string[];
      /** Signature test files that pass at the built commit — what the admission provably fixes. */
      fixes: string[];
      /** P-007: report-only radius files (their leg was already red) that fail; never a refusal. */
      reportOnlyRed?: string[];
    }
  | { ok: true; ran: false; reason: 'nothing-to-run'; population: FixPrecheckPopulation }
  | {
      ok: true;
      ran: false;
      reason: FixPrecheckBusyReason;
      detail: string;
      population: FixPrecheckPopulation;
      holder?: { pid?: number; elapsedSec: number | null };
    }
  | {
      ok: false;
      ran: false;
      code: 'admission-precheck-unavailable';
      reason: 'runner-failed';
      detail: string;
      population: FixPrecheckPopulation;
    }
  | {
      ok: false;
      ran: true;
      commit: string;
      code: AdmissionPrecheckRefusalCode;
      detail: string;
      population: FixPrecheckPopulation;
      results: FixPrecheckFileResult[];
      passing: string[];
      failing: string[];
      unmeasured: string[];
      /** Admitted-outside-signature and guarded radius test files that fail (the imports-red set), always reported. */
      importedRed: string[];
      /** Whether BOTH refusals apply — `code` names the primary one. */
      alsoImportsRed: boolean;
      /** P-007: report-only radius files (their leg was already red) that fail; never a refusal. */
      reportOnlyRed?: string[];
      /** P-007: the previously green legs the imported reds belong to, when known. */
      newlyRedLegs?: string[];
      /**
       * green-main-ratchet-convergence-2026-10-17 P-006: the admission ratchet's attribution —
       * each imported red with what it was at the previous head, and the actor the refusal is for.
       */
      ratchet?: { newFailures: RatchetNewFailure[]; routeTo: { actor: string | null; unattributed: boolean } };
    };

/**
 * Pure verdict. Missing measurements refuse as unavailable before drawing a code conclusion.
 * With complete measurements, does-not-fix precedes imports-red and retains both findings.
 */
export function evaluateFixPrecheck(
  population: FixPrecheckPopulation,
  run: FixPrecheckRunResult,
  /** The admitting actor: an `admission-imports-red` refusal is routed to it (P-006). */
  opts: { actor?: string | null } = {},
): FixPrecheckVerdict {
  if (population.files.length === 0) return { ok: true, ran: false, reason: 'nothing-to-run', population };
  if (!run.ran) {
    return run.reason === 'runner-failed'
      ? {
          ok: false,
          ran: false,
          code: 'admission-precheck-unavailable',
          reason: 'runner-failed',
          detail:
            `the admission pre-check runner failed before it could measure the built commit: ${run.detail}; ` +
            'nothing may be published without either a measured result, the checkpoint-tree-busy exception, or an explicit reasoned skipPrecheck opt-out',
          population,
        }
      : { ok: true, ran: false, reason: run.reason, detail: run.detail, population, ...(run.holder ? { holder: run.holder } : {}) };
  }
  const byPath = new Map(run.results.map((r) => [normalize(r.path), r] as const));
  const results: FixPrecheckFileResult[] = population.files.map(
    (p) => byPath.get(p) ?? { path: p, status: 'unmeasured', detail: 'the runner returned no result for this file' },
  );
  const passing = results.filter((r) => r.status === 'pass').map((r) => r.path);
  const failing = results.filter((r) => r.status === 'fail').map((r) => r.path);
  const unmeasured = results.filter((r) => r.status === 'unmeasured').map((r) => r.path);
  const fixes = population.signatureTestFiles.filter((p) => passing.includes(p));
  // P-007: guarded radius files are previously green, so a failure there imports a red exactly like
  // an admitted test file. Report-only radius files sit in a leg the signature already names red.
  // green-main-ratchet-convergence-2026-10-17 P-006: the ADMISSION RATCHET owns that decision —
  // a test that passed (guarded) or was absent (admitted) at the previous head and fails now.
  const ratchet = evaluateAdmissionRatchet({
    admission: { actor: opts.actor ?? null, commit: run.commit },
    radius: [...population.admittedTestFiles, ...(population.radius?.guarded ?? [])],
    previousHead: impliedPreviousHead({
      signatureTestFiles: population.signatureTestFiles,
      guardedRadius: population.radius?.guarded ?? [],
    }),
    postAdmission: Object.fromEntries(results.map((r) => [r.path, r.status] as const)),
  });
  const importedRed = ratchet.verdict === 'reject' ? ratchet.newFailures.map((f) => f.test) : [];
  const ratchetFinding = ratchet.verdict === 'reject'
    ? { ratchet: { newFailures: ratchet.newFailures, routeTo: ratchet.routeTo } }
    : {};
  const reportOnlyRed = (population.radius?.reportOnly ?? []).filter((p) => failing.includes(p));
  const newlyRedLegs = [...new Set(importedRed.map((p) => population.radius?.legs[p]).filter((leg): leg is string => !!leg))].sort();
  const radiusFindings = population.radius ? { reportOnlyRed, newlyRedLegs } : {};
  const importedList = importedRed.map((p) => withLeg(population, p)).join(', ');
  const legNote = newlyRedLegs.length ? `; previously green leg(s) turned red: ${newlyRedLegs.join(', ')}` : '';
  const doesNotFix = population.canProveDoesNotFix && fixes.length === 0;
  const importsRed = importedRed.length > 0;
  const base = { ran: true as const, commit: run.commit, population, results, passing, failing, unmeasured };
  // P-006: an admission whose radius was not measured cannot be shown to add no failure, so it
  // never publishes on the ratchet's behalf. The reasoned `skipPrecheck` override is the one way past.
  if (population.radius?.status === 'skipped' && importedRed.length === 0) {
    return {
      ok: false,
      ...base,
      code: 'admission-precheck-unavailable',
      detail:
        `admission ratchet: the admitted paths' radius was not measured (${population.radius.reason}` +
        `${population.radius.detail ? `: ${population.radius.detail}` : ''}), so this admission cannot be shown to ` +
        'add no failure; split it into narrower admissions, or opt out deliberately with skipPrecheck:true + precheckReason',
      importedRed,
      alsoImportsRed: false,
      ...radiusFindings,
    };
  }
  if (unmeasured.length > 0) {
    return {
      ok: false,
      ...base,
      code: 'admission-precheck-unavailable',
      detail: `${unmeasured.length} admission pre-check file(s) were not measured: ${unmeasured.join(', ')}; ` +
        'missing assertion evidence cannot establish that an admission fixes nothing or has no imported reds',
      importedRed,
      alsoImportsRed: importsRed,
      ...radiusFindings,
    };
  }
  if (doesNotFix) {
    const unmeasuredNote = unmeasured.length
      ? ` (${unmeasured.length} unmeasured — an unmeasured file never counts as passing)`
      : '';
    return {
      ok: false,
      ...base,
      code: 'admission-does-not-fix',
      detail:
        `none of the ${population.signatureTestFiles.length} signature test file(s) pass at the built admission commit ` +
        `${run.commit.slice(0, 12)}${unmeasuredNote}; the admission fixes nothing the frozen queue is red about` +
        (importsRed ? `, and it also imports ${importedRed.length} new red test file(s): ${importedList}${legNote}` : ''),
      importedRed,
      alsoImportsRed: importsRed,
      ...radiusFindings,
      ...ratchetFinding,
    };
  }
  if (importsRed) {
    return {
      ok: false,
      ...base,
      code: 'admission-imports-red',
      detail:
        `${importedRed.length} ${population.radius ? "test file(s) outside the frozen signature (admitted, or in the admitted paths' radius)" : 'admitted test file(s) outside the frozen signature'} fail at the built admission commit ` +
        `${run.commit.slice(0, 12)}: ${importedList} — the admission would import a new red onto the lineage${legNote}` +
        (ratchet.verdict === 'reject' && ratchet.routeTo.actor ? ` (admission ratchet: routed to ${ratchet.routeTo.actor})` : ''),
      importedRed,
      alsoImportsRed: false,
      ...radiusFindings,
      ...ratchetFinding,
    };
  }
  return { ok: true, ...base, fixes, ...(population.radius ? { reportOnlyRed } : {}) };
}

// ─── the real runner ─────────────────────────────────────────────────────────────────────────

/** `git rev-parse --git-common-dir` for `root`, absolute; null when git cannot answer. */
export const defaultGitCommonDir = (root: string): string | null => {
  try {
    const out = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
};

/**
 * The MAIN worktree of the repository `root` belongs to — the root whose `.git` is a directory.
 *
 * The admit door's `integrationRoot()` is whatever tree the serving host runs from, and on the
 * `:3170` staging host that is `…/papercusp-staging`, a LINKED worktree whose `.git` is a
 * gitdir FILE. Handing that root to the checkpoint-tree runner breaks all three of its legs at
 * once (measured 2026-09-11 on the d5c9f96b admission): `setup-release-checkout.sh` refuses it
 * (`-d "$INTEGRATION_ROOT/.git"`, exit 1 → `runner-failed` → the door fails OPEN and publishes
 * unmeasured), `checkpointRootMirror` of it names a `…-staging-checkpoint` tree that does not
 * exist, and the run-lock probe looks beside the wrong root so a live gate run reads as idle.
 * Every linked worktree shares the main worktree's object store, so the unpublished admission
 * commit is reachable from the canonical root by construction. A root git cannot classify is
 * returned unchanged (the runner then reports the failure loudly rather than guessing).
 */
export function resolveCanonicalIntegrationRoot(root: string, gitCommonDir: (root: string) => string | null = defaultGitCommonDir): string {
  const common = gitCommonDir(root);
  if (!common) return root;
  const abs = path.resolve(root, common);
  return path.basename(abs) === '.git' ? path.dirname(abs) : root;
}

export interface CheckpointTreeRunnerOptions {
  /** The canonical integration checkout (where the unpublished commit object lives). */
  integrationRoot: string;
  /** Operator checkout containing the shared materializer; distinct from a foreign app. */
  toolingRoot?: string;
  /** Registered foreign-pot test suite argv; never substitute a build-only command. */
  testCommand?: string[];
  /** Foreign routing removes operator credentials from the app's test environment. */
  clearEnv?: string[];
  /** The gate's isolated checkout — setup-release-checkout materializes `commit` here. */
  checkpointRoot: string;
  /** Registered harness for test-ledger attribution; never inferred from a checkout path. */
  testRunHarness?: string;
  /** Per-file wall-clock budget (default 10 min). */
  perFileTimeoutMs?: number;
  /** Setup budget (default 20 min — dependency materialization can take minutes). */
  setupTimeoutMs?: number;
  /** Injectable for tests: is a gate run holding the checkpoint tree right now? */
  runLockHeld?: (root: string) => { held: boolean; pid?: number; elapsedSec: number | null };
  /** Injectable for tests: run one child and capture its exit + output. */
  exec?: (argv: readonly string[], opts: ExecOptions) => Promise<ExecResult>;
  log?: (line: string) => void;
  /**
   * Directory for the durable per-pre-check log (WI-10006014). Default
   * `~/.papercusp/checkpoint-logs`, beside the gate's own run logs.
   */
  logDir?: string;
  /**
   * Explicit pre-check tree. Default: {@link deriveAdmissionPrecheckRoot}, which
   * keeps the tree on the dependency-generation store's filesystem (WI-10006789).
   */
  precheckRoot?: string;
  /**
   * Injectable for tests: the dependency-generation store for `integrationRoot`.
   * Default {@link resolveDependencyGenerationRoot} (env, recorded root, tree-local).
   */
  resolveGenerationRoot?: (integrationRoot: string) => string | null;
}

export interface ExecOptions {
  cwd: string;
  /** Hard wall-clock ceiling — a runaway backstop, not a progress budget. */
  timeoutMs: number;
  /**
   * Kill when the child emits NO output for this long (WI-10006014). A progressing setup
   * keeps logging (one line per materialized tree, growth-only copy progress), so this is
   * what detects a stall; the wall-clock ceiling only bounds a runaway.
   */
  idleTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Append the child's full stdout+stderr here, so a failure is attributable after the fact. */
  logFile?: string;
  /** Observe real stdout/stderr activity while the child is running; not a measurement verdict. */
  onOutput?: () => void;
}

export interface ExecResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** True when the kill came from the idle watchdog rather than the wall-clock ceiling. */
  idleTimedOut?: boolean;
  /** Head + REAL tail of the output (the middle is elided past the capture cap). */
  output: string;
  durationMs: number;
}

/**
 * Setup budget shared by the runner AND the queue's pre-check deadline
 * (repair-queue.ts admissionPrecheckDeadline), so the two can never disagree.
 * WI-10006014: the setup used to get a 20-min WALL-CLOCK budget that killed a cold
 * dependency materialization under load while it was still progressing. Stall detection
 * is now the idle watchdog; this ceiling is only the runaway backstop.
 */
export const ADMISSION_PRECHECK_SETUP_BUDGET_MS = 40 * 60_000;
/** No setup output for this long = stalled (the gate's own setup watchdog is 30 min idle). */
export const ADMISSION_PRECHECK_SETUP_IDLE_MS = 15 * 60_000;
export const ADMISSION_PRECHECK_PER_FILE_BUDGET_MS = 10 * 60_000;
/** Bound queue writes from chatty children; silent children never manufacture a heartbeat. */
export const ADMISSION_PRECHECK_HEARTBEAT_INTERVAL_MS = 5_000;
/** Output kept in memory: the first HEAD bytes plus the LAST TAIL bytes. */
export const EXEC_OUTPUT_HEAD_CHARS = 32_000;
export const EXEC_OUTPUT_TAIL_CHARS = 224_000;

/**
 * How long after the direct child EXITS we keep waiting for its stdio to close. A grandchild
 * that inherited stdout (WI-10004928 part 5: a dependency-generation `cp` under the :3170
 * runner) keeps 'close' from ever firing, which held the single pre-check slot far past its
 * setup budget. Past this grace the leftover process group is killed and we resolve anyway.
 */
export const EXEC_STDIO_CLOSE_GRACE_MS = 2_000;

/** Signal the child's whole process group (it leads one: spawned detached). */
function signalGroup(child: { pid?: number; kill: (sig: NodeJS.Signals) => boolean }, sig: NodeJS.Signals): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, sig);
      return;
    } catch {
      // group already gone, or not a group leader — fall through to the direct child
    }
  }
  try {
    child.kill(sig);
  } catch {
    // already exited
  }
}

export const defaultExec: NonNullable<CheckpointTreeRunnerOptions['exec']> = (argv, opts) =>
  new Promise<ExecResult>((resolve) => {
    const startedAt = Date.now();
    const [cmd, ...rest] = argv;
    // detached ONLY to lead a process group, so a timeout kills grandchildren too; the child
    // is awaited and never outlives this call (allowlisted in check-no-unenrolled-detached-spawn).
    const child = spawn(cmd, rest, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    // WI-10006014: keep the HEAD and the REAL TAIL. The old capture stopped appending at
    // 256 KB, so a failure detail citing `output.slice(-600)` quoted the end of the first
    // 256 KB — possibly long before the point of death — instead of the actual last lines.
    const capture = createHeadTailCapture(EXEC_OUTPUT_HEAD_CHARS, EXEC_OUTPUT_TAIL_CHARS);
    const logStream = opts.logFile ? openExecLog(opts.logFile, argv, opts.cwd) : null;
    let timedOut = false;
    let idleTimedOut = false;
    let directExited = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    const kill = () => {
      signalGroup(child, 'SIGTERM');
      setTimeout(() => signalGroup(child, 'SIGKILL'), 5_000).unref();
    };
    const armIdle = () => {
      if (!opts.idleTimeoutMs || settled || directExited) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        idleTimedOut = true;
        kill();
      }, opts.idleTimeoutMs);
    };
    const collect = (buf: Buffer) => {
      const s = buf.toString('utf8');
      capture.push(s);
      logStream?.write(s);
      armIdle();
      try {
        opts.onOutput?.();
      } catch (err) {
        logStream?.write(`\n[admission-precheck-exec] output callback failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const finish = (r: Omit<ExecResult, 'durationMs' | 'timedOut' | 'idleTimedOut'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (idleTimer) clearTimeout(idleTimer);
      const durationMs = Date.now() - startedAt;
      logStream?.end(
        `\n[admission-precheck-exec] exit=${r.exitCode ?? 'null'} signal=${r.signal ?? 'none'} ` +
          `timedOut=${timedOut} idleTimedOut=${idleTimedOut} durationMs=${durationMs} at ${new Date().toISOString()}\n`,
      );
      resolve({ ...r, timedOut, ...(idleTimedOut ? { idleTimedOut } : {}), durationMs });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    armIdle();
    child.on('error', (err) => {
      finish({ exitCode: null, signal: null, output: `${capture.text()}\n${err.message}` });
    });
    child.on('exit', (code, signal) => {
      // Execution ended; inherited pipes have a separate cleanup budget. Leaving
      // these watchdogs armed can turn a successful exit into a timeout during
      // that cleanup, and descendant output must not start another idle window.
      directExited = true;
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      // The direct child is gone. Normally 'close' follows at once; if a grandchild still holds
      // the pipes, kill the leftover group and resolve on the exit status instead of hanging.
      graceTimer = setTimeout(() => {
        signalGroup(child, 'SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ exitCode: code, signal, output: capture.text() });
      }, EXEC_STDIO_CLOSE_GRACE_MS);
      graceTimer.unref();
    });
    child.on('close', (code, signal) => {
      finish({ exitCode: code, signal, output: capture.text() });
    });
  });

/**
 * Bounded output capture that keeps the first `headChars` and the LAST `tailChars`,
 * eliding the middle with an explicit marker (WI-10006014). Exported for tests.
 */
export function createHeadTailCapture(headChars: number, tailChars: number): { push(s: string): void; text(): string } {
  let head = '';
  let tail = '';
  let elided = 0;
  return {
    push(s: string) {
      if (head.length < headChars) {
        const take = s.slice(0, headChars - head.length);
        head += take;
        s = s.slice(take.length);
        if (!s) return;
      }
      tail += s;
      if (tail.length > tailChars * 2) {
        const drop = tail.length - tailChars;
        elided += drop;
        tail = tail.slice(drop);
      }
    },
    text() {
      let t = tail;
      let dropped = elided;
      if (t.length > tailChars) {
        dropped += t.length - tailChars;
        t = t.slice(t.length - tailChars);
      }
      return dropped > 0 ? `${head}\n…[${dropped} chars elided — full output in the pre-check log]…\n${t}` : head + t;
    },
  };
}

/** Open (append) the durable exec log, writing a header naming the command. Never throws. */
function openExecLog(file: string, argv: readonly string[], cwd: string): WriteStream | null {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const stream = createWriteStream(file, { flags: 'a' });
    stream.on('error', () => {
      // A log write failure must never fail or hang the measurement it describes.
    });
    stream.write(`\n[admission-precheck-exec] ${new Date().toISOString()} cwd=${cwd} argv=${JSON.stringify(argv)}\n`);
    return stream;
  } catch {
    return null;
  }
}

/**
 * Router exit codes that MEASURED NOTHING. The contract lives in
 * `scripts/lib/test-file-exit-codes.mjs` (only 0 = passed and 1 = failed are measured);
 * 2 = NOT MEASURED (route/launch/admission error, watchdog reap, every collected test
 * skipped) and 75 = EX_TEMPFAIL. The literals stay local so operator-core does not import
 * `scripts/`; `admission-fix-precheck.test.ts` pins them to the contract module.
 * WI-10003617: treating 2 as a failure refused an admission as `admission-imports-red`
 * for two admitted files whose every test was skipped in the precheck checkout.
 */
export const ROUTER_EXIT_NOT_MEASURED = 2;
export const ROUTER_EXIT_TEMPFAIL = 75;

/**
 * Classify one `scripts/test-files.mjs <file>` run. Route errors, zero matches and the router's
 * not-measured exits are UNMEASURED — never a pass, and never a failure: a run that measured
 * nothing cannot import a red.
 */
export function classifyTestFileRun(r: ExecResult): { status: FixPrecheckFileStatus; detail?: string } {
  if (r.timedOut) return { status: 'unmeasured', detail: `timed out after ${r.durationMs}ms` };
  if (/TEST_FILE_ROUTE_ERROR|matched=0\b|No test files found/.test(r.output)) {
    return { status: 'unmeasured', detail: 'the router matched zero test files (route error / matched=0)' };
  }
  if (r.exitCode === 0) return { status: 'pass' };
  if (r.exitCode === null) return { status: 'unmeasured', detail: `runner exited by signal ${r.signal ?? 'unknown'}` };
  if (r.exitCode === ROUTER_EXIT_NOT_MEASURED || r.exitCode === ROUTER_EXIT_TEMPFAIL) {
    const reason = /reason=([\w-]+)/.exec(r.output)?.[1];
    return {
      status: 'unmeasured',
      detail: `the router measured nothing (exit ${r.exitCode}${reason ? `, reason=${reason}` : ''})`,
    };
  }
  // Foreign app commands include npm's pretest lifecycle. Its build/copy errors use exit 1
  // too, but do not execute assertions. Reuse the router's summary parser/terminal contract.
  const assertionsExecuted = testsExecutedFrom(r.output);
  const routerMeasuredFailure = /^TEST_FILE_RESULT\b[^\n]*\bstatus=failed\b/m.test(r.output);
  if (!(assertionsExecuted !== null && assertionsExecuted > 0) && !routerMeasuredFailure) {
    return { status: 'unmeasured', detail: `runner failed without readable assertion results (exit ${r.exitCode})` };
  }
  return { status: 'fail', detail: `exit ${r.exitCode}` };
}

/**
 * Environment for the pre-check's `setup-release-checkout.sh` call (WI-10004928, D-129).
 *
 * The pre-check tree's node_modules is materialized from an immutable dependency
 * generation. When the generation changes, an independent copy costs ~20 min for
 * ~22 GB on ext4 (no reflink), on the admission critical path. A hardlink
 * materialization (`DEPENDENCY_GENERATION_ALLOW_HARDLINK=1`) costs seconds and is
 * safe for this tree:
 *  - generation files are frozen `chmod a-w` (0444), and an independent copy keeps
 *    that mode, so an in-place write already fails in the pre-check today. A
 *    hardlink adds no new write path into the generation;
 *  - `cp -al` creates distinct directories, so caches that create new entries
 *    (vitest's `node_modules/.vite`) stay private to this tree, and the
 *    generation prunes those cache dirs;
 *  - the pre-check only runs `scripts/test-files.mjs` (vitest). There are no
 *    installers or patchers here, which are the writers the copy default guards against.
 * The shell decides per tree and falls back to an independent copy on a
 * cross-device root or any `cp -al` failure (dependency-generation.test.ts).
 * The checkpoint tree itself keeps the copy default.
 */
export function admissionPrecheckSetupEnv(): NodeJS.ProcessEnv {
  return { DEPENDENCY_GENERATION_ALLOW_HARDLINK: '1' };
}

/** Filesystem facts {@link deriveAdmissionPrecheckRoot} needs; injectable for tests. */
export interface AdmissionPrecheckRootProbe {
  /** `st_dev` of exactly `p`, or null when `p` does not exist. */
  deviceOf(p: string): number | null;
  /** Whether `dir` is a directory the current user can create entries in. */
  writableDir(dir: string): boolean;
}

export type AdmissionPrecheckRootPlacement =
  | 'explicit'
  | 'beside-checkpoint'
  | 'beside-generation-store'
  | 'inside-generation-store';

export interface AdmissionPrecheckRoot {
  root: string;
  placement: AdmissionPrecheckRootPlacement;
  /** One line naming why this placement was chosen, for the pre-check log. */
  reason: string;
  /** The default location, when the tree was moved away from it. */
  displaced?: string;
}

const defaultAdmissionPrecheckRootProbe: AdmissionPrecheckRootProbe = {
  deviceOf(p) {
    try {
      return statSync(p).dev;
    } catch {
      return null;
    }
  },
  writableDir(dir) {
    try {
      if (!statSync(dir).isDirectory()) return false;
      accessSync(dir, fsConstants.W_OK | fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Where the admission pre-check tree lives (WI-10006789).
 *
 * The tree's node_modules is materialized from the dependency-generation store
 * with `DEPENDENCY_GENERATION_ALLOW_HARDLINK=1` ({@link admissionPrecheckSetupEnv}).
 * A hardlink — and a reflink — only works when source and destination share a
 * filesystem. The default location, `<checkpointRoot>-admission-precheck`, sits
 * beside the gate's checkout; on a host whose store lives on another device
 * (measured: store on /mnt/data xfs, checkout on / ext4) every cold pre-check
 * became a full ~12 GiB copy that could not finish inside its setup budget.
 *
 * So when the default location is on a different device from the store, the
 * tree moves onto the store's filesystem: beside the store when its parent is
 * writable, otherwise in a reserved `.worktrees/` directory inside it. The
 * store's own maintenance only ever enumerates `v1-*` generations and its own
 * dot-prefixed bookkeeping, so a `.worktrees/` entry is never treated as a
 * generation. When the store does not exist yet, or already shares the default
 * location's filesystem, nothing moves.
 */
export function deriveAdmissionPrecheckRoot(input: {
  checkpointRoot: string;
  generationRoot: string | null;
  probe?: AdmissionPrecheckRootProbe;
}): AdmissionPrecheckRoot {
  const probe = input.probe ?? defaultAdmissionPrecheckRootProbe;
  const besideCheckpoint = `${path.resolve(input.checkpointRoot)}-admission-precheck`;
  const keep = (reason: string): AdmissionPrecheckRoot => ({ root: besideCheckpoint, placement: 'beside-checkpoint', reason });
  if (!input.generationRoot) return keep('dependency-generation store unresolved');
  const store = path.resolve(input.generationRoot);
  const storeDevice = probe.deviceOf(store);
  if (storeDevice === null) return keep(`dependency-generation store ${store} does not exist`);
  let probeAt = path.dirname(besideCheckpoint);
  let defaultDevice = probe.deviceOf(probeAt);
  while (defaultDevice === null && path.dirname(probeAt) !== probeAt) {
    probeAt = path.dirname(probeAt);
    defaultDevice = probe.deviceOf(probeAt);
  }
  if (defaultDevice === null || defaultDevice === storeDevice) {
    return keep(`same filesystem as the dependency-generation store ${store}`);
  }
  const name = path.basename(besideCheckpoint);
  const storeParent = path.dirname(store);
  const moved = `the default ${besideCheckpoint} is on another filesystem than the dependency-generation store ${store}, so node_modules could not be hardlinked`;
  if (storeParent !== store && probe.writableDir(storeParent) && probe.deviceOf(storeParent) === storeDevice) {
    return { root: path.join(storeParent, name), placement: 'beside-generation-store', reason: moved, displaced: besideCheckpoint };
  }
  return { root: path.join(store, '.worktrees', name), placement: 'inside-generation-store', reason: moved, displaced: besideCheckpoint };
}

export function createCheckpointTreeFixPrecheckRunner(opts: CheckpointTreeRunnerOptions): FixPrecheckRunner {
  const exec = opts.exec ?? defaultExec;
  const runLockHeld = opts.runLockHeld ?? ((root: string) => isCheckpointRunLockHeldCheap(root));
  const perFileTimeoutMs = opts.perFileTimeoutMs ?? ADMISSION_PRECHECK_PER_FILE_BUDGET_MS;
  const setupTimeoutMs = opts.setupTimeoutMs ?? ADMISSION_PRECHECK_SETUP_BUDGET_MS;
  const log = opts.log ?? (() => {});
  const logDir = opts.logDir ?? papercuspPath('checkpoint-logs');
  return async ({ commit, files, onProgress }) => {
    // WI-10006014: one durable log per pre-check (setup + every file), named in every
    // runner-failed detail, so a failure is attributable after the in-memory output is gone.
    const logFile = path.join(
      logDir,
      `admission-precheck-${commit.slice(0, 12)}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
    );
    const toolingRoot = opts.toolingRoot ?? opts.integrationRoot;
    const clearedEnv: NodeJS.ProcessEnv = Object.fromEntries((opts.clearEnv ?? []).map((key) => [key, undefined]));
    // The current-build host can supply tooling from a linked worktree while
    // integrationRoot names the canonical checkout holding the built commit.
    // A different path is not a foreign app when both share the same repository.
    const foreignTooling = toolingRoot !== opts.integrationRoot &&
      path.resolve(resolveCanonicalIntegrationRoot(toolingRoot)) !==
        path.resolve(resolveCanonicalIntegrationRoot(opts.integrationRoot));
    if (foreignTooling && !opts.testCommand?.length) {
      return { ran: false, reason: 'runner-failed',
        detail: 'foreign admission pre-check has no registered test-suite command; refusing to infer one from operator tooling' };
    }
    const held = runLockHeld(opts.integrationRoot);
    if (held.held) {
      return {
        ran: false,
        reason: 'checkpoint-tree-busy',
        detail:
          `a green-checkpoint run holds the checkpoint tree (pid ${held.pid ?? '?'}, ${held.elapsedSec ?? '?'}s in); ` +
          'the admission pre-check did not run — the gate re-judges the admission itself (R-1)',
        holder: { pid: held.pid, elapsedSec: held.elapsedSec },
      };
    }
    // The gate may acquire its run lock and re-pin checkpointRoot AFTER the one-time
    // probe above. Keep admission measurement in a different, queue-serialized worktree.
    // setup-release-checkout already creates/refreshes this checkout at the exact ref.
    // WI-10006789: it lives on the dependency-generation store's filesystem so the
    // node_modules materialization can hardlink instead of copying.
    const placement: AdmissionPrecheckRoot = opts.precheckRoot
      ? { root: path.resolve(opts.precheckRoot), placement: 'explicit', reason: 'caller-provided pre-check root' }
      : deriveAdmissionPrecheckRoot({
          checkpointRoot: opts.checkpointRoot,
          generationRoot: (opts.resolveGenerationRoot ?? resolveDependencyGenerationRoot)(opts.integrationRoot),
        });
    const precheckRoot = placement.root;
    log(`[admission-precheck] tree ${precheckRoot} (${placement.placement}: ${placement.reason})`);
    if (placement.displaced && existsSync(placement.displaced)) {
      log(
        `[admission-precheck] the earlier tree ${placement.displaced} is no longer used; ` +
          `reclaim it with: git -C ${opts.integrationRoot} worktree remove --force ${placement.displaced}`,
      );
    }
    if (placement.placement !== 'beside-checkpoint' && placement.placement !== 'explicit') {
      mkdirSync(path.dirname(precheckRoot), { recursive: true });
    }
    if (existsSync(precheckRoot)) {
      const integrationGitDir = defaultGitCommonDir(opts.integrationRoot);
      const precheckGitDir = defaultGitCommonDir(precheckRoot);
      if (!integrationGitDir || !precheckGitDir || path.resolve(integrationGitDir) !== path.resolve(precheckGitDir)) {
        return {
          ran: false,
          reason: 'runner-failed',
          detail: `dedicated admission checkout ${precheckRoot} exists but is not a worktree of ${opts.integrationRoot}; refusing to reset it`,
        };
      }
    }
    const setupScript = path.join(toolingRoot, 'apps/operator/bin/release/setup-release-checkout.sh');
    const reportProgress = async (progress: FixPrecheckProgress): Promise<void> => {
      if (!onProgress) return;
      try {
        await onProgress(progress);
      } catch (err) {
        // Progress is a liveness aid, never a substitute for the measured verdict. A transient
        // queue/DB write failure must not convert a real test result into runner-failed.
        log(
          `[admission-precheck] progress callback failed for ${progress.currentFile}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    const execWithProgress = async (
      argv: readonly string[],
      execOpts: ExecOptions,
      fileProgress: Omit<FixPrecheckProgress, 'heartbeatAtMs'>,
    ): Promise<ExecResult> => {
      let lastHeartbeatAtMs = -Infinity;
      let pendingProgress: FixPrecheckProgress | null = null;
      let reporting: Promise<void> | null = null;
      const onOutput = () => {
        if (!onProgress) return;
        const heartbeatAtMs = Date.now();
        if (heartbeatAtMs - lastHeartbeatAtMs < ADMISSION_PRECHECK_HEARTBEAT_INTERVAL_MS) return;
        lastHeartbeatAtMs = heartbeatAtMs;
        pendingProgress = { ...fileProgress, heartbeatAtMs };
        if (reporting) return;
        // Keep at most one pending snapshot while a CAS write is in flight. Await the last
        // write before advancing phases so delayed setup progress cannot overwrite a file.
        reporting = (async () => {
          while (pendingProgress) {
            const progress = pendingProgress;
            pendingProgress = null;
            await reportProgress(progress);
          }
        })().finally(() => { reporting = null; });
      };
      try {
        return await exec(argv, { ...execOpts, onOutput });
      } finally {
        await reporting;
      }
    };
    log(`[admission-precheck] materializing ${commit.slice(0, 12)} into ${precheckRoot}`);
    const setup = await execWithProgress(
      [
        // The publisher brackets its snapshot with fingerprints, but those only
        // detect a concurrent install after the expensive copy. Use the same
        // repo-keyed reader lease as checkpoint prewarming so guarded installers
        // cannot reify the source dependencies during admission setup.
        process.execPath,
        path.join(toolingRoot, 'scripts/npm-install-safe.mjs'),
        '--repo-root',
        opts.integrationRoot,
        '--exec-under-lock',
        '--',
        'bash',
        setupScript,
        '--ref',
        commit,
        '--integration',
        opts.integrationRoot,
        '--release',
        precheckRoot,
        '--node-modules',
        'auto',
        '--node-modules-copy',
        'copy',
      ],
      {
        cwd: opts.integrationRoot,
        timeoutMs: setupTimeoutMs,
        idleTimeoutMs: ADMISSION_PRECHECK_SETUP_IDLE_MS,
        env: { ...admissionPrecheckSetupEnv(), ...clearedEnv },
        logFile,
      },
      { currentFile: files[0] as string, completedCount: 0, totalCount: files.length },
    );
    if (setup.exitCode !== 0) {
      const infra = dependencyGenerationInfraCode(setup.exitCode, setup.output);
      const timeoutNote = setup.idleTimedOut
        ? ` (stalled: no output for ${Math.round(ADMISSION_PRECHECK_SETUP_IDLE_MS / 60_000)} min)`
        : setup.timedOut
          ? ` (timed out at the ${Math.round(setupTimeoutMs / 60_000)}-min ceiling after ${Math.round(setup.durationMs / 1000)}s)`
          : '';
      return {
        ran: false,
        reason: 'runner-failed',
        detail: `${infra ? `infra=${infra} ` : ''}setup-release-checkout exited ${setup.exitCode ?? setup.signal} for ${commit.slice(0, 12)}${timeoutNote}; log=${logFile}: ${setup.output.slice(-600)}`,
      };
    }
    const results: FixPrecheckFileResult[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index] as string;
      await reportProgress({
        currentFile: file,
        completedCount: index,
        totalCount: files.length,
        heartbeatAtMs: Date.now(),
      });
      log(`[admission-precheck] test-file ${file} @ ${commit.slice(0, 12)}`);
      const argv = opts.testCommand?.length
        ? [...opts.testCommand, '--', file]
        : ['node', 'scripts/test-files.mjs', file];
      const r = await execWithProgress(argv, {
        cwd: precheckRoot,
        timeoutMs: perFileTimeoutMs,
        env: {
          PAPERCUSP_ADMISSION_PRECHECK: '1',
          PAPERCUSP_TEST_RUN_GROUP: `admission-precheck:${commit.slice(0, 12)}`,
          ...(opts.testRunHarness ? { PAPERCUSP_TEST_RUN_HARNESS: opts.testRunHarness } : {}),
          ...clearedEnv,
        },
        logFile,
      }, { currentFile: file, completedCount: index, totalCount: files.length });
      const c = classifyTestFileRun(r);
      results.push({ path: file, status: c.status, ...(c.detail ? { detail: c.detail } : {}), exitCode: r.exitCode, durationMs: r.durationMs });
    }
    return { ran: true, commit, results, setup: { durationMs: setup.durationMs } };
  };
}
