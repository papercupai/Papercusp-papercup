import { papercuspPath } from '@papercusp/host-platform/home';
/** Host independent, task-managed runner for the frozen repair admission pre-check. */
import { dirname, join } from 'node:path';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJson } from '@papercusp/hash-chain';
import { getTask } from '../task-manager/store';
import { getHarnessAdminUrl } from '../embedded-pg-discovery';
import { managedSpawn, type ManagedSpawnResult } from '../task-manager/managed-spawn';
import { isValidTaskId, type TaskRow } from '../task-manager/types';
import { resolveSidecarSpawnPlan, type SidecarSpawnPlan } from '../process-supervision/sidecar-spawn-shared';
import {
  applyFrozenCandidateRepairQueueTransition,
  readFrozenCandidateRepairQueueState,
} from '../harness/routines/release-actions';
import {
  admissionPrecheckFileConcurrency,
  createCheckpointTreeFixPrecheckRunner,
  evaluateFixPrecheck,
  precheckPopulation,
  previousHeadBaselineFiles,
  confirmationRerunFiles,
  ADMISSION_PRECHECK_MAX_FILES,
  type FixPrecheckConfirmation,
  type FixPrecheckFileResult,
  type FixPrecheckPopulation,
  type FixPrecheckPreviousHead,
  type FixPrecheckRunner,
  type FixPrecheckProgress,
  type FixPrecheckRunResult,
  type FixPrecheckVerdict,
} from './admission-fix-precheck';
import { ADMISSION_RADIUS_CAP } from './admission-jobs';
import { startAdmissionTestEnvironment, type AdmissionTestEnvironment } from './admission-private-test-pg';
export { ADMISSION_TEST_ENVIRONMENT } from './admission-private-test-pg';
import type {
  FrozenCandidateRepairQueue,
  FrozenCandidateRepairQueueRead,
  FrozenRepairAdmissionPrecheck,
  RepairSignatureEntry,
} from './frozen-candidate-repair-queue';

export const ADMISSION_PRECHECK_WORKER_MODE_ENV = 'PAPERCUSP_REPAIR_PRECHECK_WORKER_MODE';
export const ADMISSION_PRECHECK_WORKER_INPUT_ENV = 'PAPERCUSP_REPAIR_PRECHECK_WORKER_INPUT';

export interface AdmissionPrecheckQueueTarget {
  workspaceId: string;
  installSlug: string;
}

export interface AdmissionPrecheckWorkerInput {
  /** Proposal work uses the same confined worker but never settles an admission. */
  proposal?: { candidate: string; repairHead: string };
  operationId: string;
  taskId: string;
  queueTarget: AdmissionPrecheckQueueTarget;
  integrationRoot: string;
  toolingRoot?: string;
  testCommand?: string[];
  clearEnv?: string[];
  checkpointRoot: string;
  expiresAtMs: number;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

export function buildAdmissionPrecheckSpawnPlan(options: {
  selfPath?: string;
  moduleDirOverride?: string;
  execPath?: string;
  spawnerPid?: number;
} = {}): SidecarSpawnPlan {
  const plan = resolveSidecarSpawnPlan({
    selfPath: options.selfPath ?? fileURLToPath(import.meta.url),
    devScriptPath: join(options.moduleDirOverride ?? moduleDir, 'admission-fix-precheck-worker-bin.ts'),
    bundledModeEnvVar: ADMISSION_PRECHECK_WORKER_MODE_ENV,
    execPath: options.execPath ?? process.execPath,
    spawnerPid: options.spawnerPid ?? process.pid,
  });
  // This task survives its launching host; only parent-bound sidecars declare this lifetime.
  delete plan.env.PAPERCUSP_DESKTOP_PARENT_PID;
  return plan;
}

export async function startAdmissionPrecheckWorker(
  input: AdmissionPrecheckWorkerInput,
  options: { spawnPlan?: SidecarSpawnPlan; logDir?: string; spawn?: typeof managedSpawn } = {},
): Promise<ManagedSpawnResult> {
  if (!isValidTaskId(input.taskId)) throw new Error('invalid admission pre-check task id');
  const plan = options.spawnPlan ?? buildAdmissionPrecheckSpawnPlan();
  const args = [...plan.args];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...plan.env,
    [ADMISSION_PRECHECK_WORKER_INPUT_ENV]: JSON.stringify(input),
  };
  // Also discard inherited or injected sidecar metadata at the actual spawn boundary.
  delete env.PAPERCUSP_DESKTOP_PARENT_PID;
  const logDir = options.logDir ?? papercuspPath('checkpoint-logs');
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logPath = join(logDir, `admission-precheck-worker-${input.taskId}.log`);
  const logFd = openSync(logPath, 'a', 0o600);
  try {
    // The scope client and worker inherit file descriptors, so startup failures
    // survive host replacement without a host-owned pipe or output listener.
    return await (options.spawn ?? managedSpawn)(
    plan.cmd,
    args,
    {
      class: 'test-run',
      title: `R6 admission pre-check ${input.operationId}`,
      argv: [plan.cmd, ...args],
      cwd: input.integrationRoot,
      launchedBy: 'release:repair-queue:admission-precheck',
      logPath,
      detail: { operationId: input.operationId, subsystem: 'frozen-repair-admission-precheck' },
      runtimeMaxSec: Math.max(1, Math.ceil((input.expiresAtMs - Date.now()) / 1000)),
    },
    {
      taskId: input.taskId,
      workspaceId: input.queueTarget.workspaceId,
      spawnOptions: { cwd: input.integrationRoot, env, stdio: ['ignore', logFd, logFd] },
    },
    );
  } catch (error) {
    writeSync(logFd, `[release:repair-queue] worker launch failed: ${String(error)}\n`);
    throw error;
  } finally {
    closeSync(logFd);
  }
}

export async function persistAdmissionPrecheckProgress(
  queueTarget: AdmissionPrecheckQueueTarget,
  operationId: string,
  progress: FixPrecheckProgress,
): Promise<void> {
  await applyFrozenCandidateRepairQueueTransition(queueTarget, (fresh) =>
    admissionPrecheckProgressTransition(fresh, operationId, progress));
}

export async function settleAdmissionPrecheck(
  queueTarget: AdmissionPrecheckQueueTarget,
  operationId: string,
  verdict: FixPrecheckVerdict,
): Promise<void> {
  const settledAtMs = Date.now();
  await applyFrozenCandidateRepairQueueTransition(queueTarget, (fresh) =>
    admissionPrecheckSettlementTransition(fresh, operationId, verdict, settledAtMs));
}

export function admissionPrecheckProgressTransition(
  fresh: FrozenCandidateRepairQueue,
  operationId: string,
  progress: FixPrecheckProgress,
): FrozenCandidateRepairQueue {
  const current = fresh.admissionPrecheck;
  if (!current || current.operationId !== operationId || current.status !== 'running') return fresh;
  const updatedAtMs = Math.max(fresh.updatedAtMs + 1, progress.heartbeatAtMs);
  return {
    ...fresh,
    updatedAtMs,
    admissionPrecheck: {
      ...current,
      currentFile: progress.currentFile,
      completedCount: progress.completedCount,
      totalCount: progress.totalCount,
      heartbeatAtMs: progress.heartbeatAtMs,
      updatedAtMs,
    },
  };
}

export function admissionPrecheckSettlementTransition(
  fresh: FrozenCandidateRepairQueue,
  operationId: string,
  verdict: FixPrecheckVerdict,
  settledAtMs: number,
): FrozenCandidateRepairQueue {
  const current = fresh.admissionPrecheck;
  if (!current || current.operationId !== operationId || current.status !== 'running') return fresh;
  const { dispatchReservation, ...rest } = fresh;
  // The settlement clock is sampled before acquiring the row lock. A worker
  // heartbeat can win that lock first; never make the settled marker older than
  // its retained progress, which would make the strict reader discard it.
  const updatedAtMs = Math.max(fresh.updatedAtMs + 1, current.updatedAtMs, current.heartbeatAtMs ?? 0, settledAtMs);
  return {
    ...rest,
    ...(dispatchReservation?.token === operationId ? {} : { dispatchReservation }),
    admissionPrecheck: {
      ...current,
      status: verdict.ok ? (verdict.ran ? 'passed' : 'deferred') : 'failed',
      verdict,
      updatedAtMs,
    },
    updatedAtMs,
  };
}

export interface AdmissionPrecheckWorkerDeps {
  startTestEnvironment?: typeof startAdmissionTestEnvironment;
  runProposal?: (input: AdmissionPrecheckWorkerInput) => Promise<void>;
  getTask: (taskId: string) => Promise<Pick<TaskRow, 'state' | 'confined'> | null>;
  readQueue: (target: AdmissionPrecheckQueueTarget) => Promise<FrozenCandidateRepairQueueRead>;
  transition: (
    target: AdmissionPrecheckQueueTarget,
    update: (fresh: FrozenCandidateRepairQueue) => FrozenCandidateRepairQueue,
  ) => Promise<unknown>;
  createRunner: (options: { integrationRoot: string; checkpointRoot: string; testRunHarness: string;
    fileConcurrency?: number;
    reusePreparedTree?: boolean;
    prepareTestEnvironment?: (root: string, onOutput: () => void) => Promise<NodeJS.ProcessEnv>;
    /** D-004: the paired previous-head baseline measures in a second tree. */
    precheckRootSuffix?: string }) => FixPrecheckRunner;
  now?: () => number;
}

export type AdmissionPrecheckWorkerOutcome =
  | { status: 'settled'; verdict: FixPrecheckVerdict }
  | { status: 'interrupted'; reason: string }
  | { status: 'proposed' }
  | { status: 'ignored'; reason: string };

const defaultWorkerDeps: AdmissionPrecheckWorkerDeps = {
  getTask,
  readQueue: readFrozenCandidateRepairQueueState,
  transition: applyFrozenCandidateRepairQueueTransition,
  createRunner: createCheckpointTreeFixPrecheckRunner,
};

/**
 * Ordered membership and every classification/queue pin are part of the resume identity.
 *
 * EI-27092183951452642: the signature enters ONLY as the classification the pre-check judges
 * with — `precheckPopulation`'s signature test-file ids and non-test kinds, as sorted sets.
 * Every gate verdict rewrites each entry's `measuredHead` / `cases` / `errors`, may reorder
 * entries, and may add an id of a non-test kind that is already present. None of that changes
 * what the pre-check measures or how it classifies a result, so none of it may abort an
 * in-flight pre-check or orphan its saved measurement. A changed test-file id set or a new
 * non-test kind DOES change the classification, and still changes the identity.
 *
 * EI-27114233692780034: the operation is persisted in `routines.metadata` jsonb, which
 * re-orders object keys (by length, then bytes). The identity is computed once over the
 * in-memory operation and re-verified later over the jsonb read-back, so it MUST be a
 * canonical (sorted-key) serialization — `JSON.stringify` key order made every measured
 * pre-check fail its own identity check on confirm and silently relaunch.
 */
export function admissionPrecheckMeasurementIdentity(operation: FrozenRepairAdmissionPrecheck, signature: readonly RepairSignatureEntry[]): string {
  const population = precheckPopulation({
    signature,
    admittedPaths: operation.files,
    removedTestFiles: operation.removedTestFiles,
  });
  const classification = {
    signatureTestFiles: [...population.signatureTestFiles].sort(),
    nonTestKinds: [...population.nonTestKinds].sort(),
  };
  return createHash('sha256').update(canonicalJson({ operationId: operation.operationId, candidate: operation.candidate,
    repairHead: operation.repairHead, builtCommit: operation.builtCommit, builtTree: operation.builtTree,
    sourceCommit: operation.sourceCommit, files: operation.files, removedTestFiles: operation.removedTestFiles,
    radius: operation.radius, classification,
    testEnvironment: operation.testEnvironment })).digest('hex');
}

export function validateAdmissionPrecheckResults(files: readonly string[], results: readonly FixPrecheckFileResult[], complete = false): void {
  const seen = new Set<string>();
  for (const result of results) {
    if (!files.includes(result.path) || seen.has(result.path) || !['pass', 'fail', 'unmeasured'].includes(result.status))
      throw new Error('duplicate, foreign or invalid per-file measurement');
    seen.add(result.path);
  }
  if (complete && (results.length !== files.length || files.some(file => !seen.has(file))))
    throw new Error('incomplete execution-group measurement');
}

/** The second tree the paired previous-head baseline measures in (D-004). */
export const ADMISSION_PRECHECK_BASELINE_ROOT_SUFFIX = '-previous-head';

/**
 * measured-wide-repair-admission-2026-10-24#D-004 ruling 1: the PAIRED BASELINE. Re-measure, at
 * the previous repair head, exactly the guarded radius files that failed at the built commit —
 * same runner, same per-file command and the operation's own test environment, in a second tree —
 * so a guarded red is attributed against a MEASURED previous-head verdict, never an assumed pass.
 *
 * Returns undefined when no guarded file failed (nothing to pair). A baseline that cannot run,
 * or runs only partly, returns what it measured plus a `detail`; the evaluator then refuses the
 * unpaired reds as unavailable. It never throws a runner failure into a measured verdict.
 */
export async function measurePreviousHeadBaseline(input: {
  population: FixPrecheckPopulation;
  results: readonly FixPrecheckFileResult[];
  previousHead: string;
  runner: FixPrecheckRunner;
  deadlineAtMs: number;
  now?: () => number;
  onProgress?: (file: string) => Promise<void> | void;
}): Promise<FixPrecheckPreviousHead | undefined> {
  const files = previousHeadBaselineFiles(input.population, input.results);
  if (!files.length) return undefined;
  const now = input.now ?? Date.now;
  const commit = input.previousHead;
  const results: FixPrecheckFileResult[] = [];
  const partial = (detail: string): FixPrecheckPreviousHead => ({ commit, results, detail });
  for (let start = 0; start < files.length; start += ADMISSION_PRECHECK_MAX_FILES) {
    if (now() >= input.deadlineAtMs) return partial('the bounded pre-check deadline expired before the paired baseline completed');
    const group = files.slice(start, start + ADMISSION_PRECHECK_MAX_FILES);
    let run: FixPrecheckRunResult;
    try {
      run = await input.runner({
        commit,
        files: group,
        ...(input.onProgress ? { onProgress: async (progress: FixPrecheckProgress) => { await input.onProgress!(progress.currentFile); } } : {}),
      });
    } catch (error) {
      return partial(`the paired baseline runner failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!run.ran) return partial(`the paired baseline did not run (${run.reason}): ${run.detail}`);
    if (run.commit !== commit) return partial('the paired baseline measured a different commit');
    try { validateAdmissionPrecheckResults(group, run.results, true); }
    catch (error) { return partial(`the paired baseline returned an invalid measurement: ${String(error)}`); }
    results.push(...run.results);
  }
  return { commit, results };
}

/**
 * EI-27083585698781986: the CONFIRMATION RE-RUN. Re-measure ONCE, at the SAME built commit and by
 * the same per-file runner (each file its own test process), every guarded file the ratchet would
 * otherwise attribute: red at the built commit, measured green at the previous head. A pass there
 * marks a flake at the built commit (advisory); a second fail — or no reading — keeps the red.
 *
 * Returns undefined when nothing needs confirming. A re-run that cannot complete returns what it
 * measured plus a `detail`; an unconfirmed file then keeps its measured red. Never throws.
 */
export async function measureConfirmationRerun(input: {
  population: FixPrecheckPopulation;
  results: readonly FixPrecheckFileResult[];
  previousHead: FixPrecheckPreviousHead | undefined;
  builtCommit: string;
  expectedTree?: string;
  runner: FixPrecheckRunner;
  deadlineAtMs: number;
  now?: () => number;
  onProgress?: (file: string) => Promise<void> | void;
}): Promise<FixPrecheckConfirmation | undefined> {
  const files = confirmationRerunFiles(input.population, input.results, input.previousHead);
  if (!files.length) return undefined;
  const now = input.now ?? Date.now;
  const commit = input.builtCommit;
  const results: FixPrecheckFileResult[] = [];
  const partial = (detail: string): FixPrecheckConfirmation => ({ commit, results, detail });
  for (let start = 0; start < files.length; start += ADMISSION_PRECHECK_MAX_FILES) {
    if (now() >= input.deadlineAtMs) return partial('the bounded pre-check deadline expired before the confirmation re-run completed');
    const group = files.slice(start, start + ADMISSION_PRECHECK_MAX_FILES);
    let run: FixPrecheckRunResult;
    try {
      run = await input.runner({
        commit,
        ...(input.expectedTree ? { expectedTree: input.expectedTree } : {}),
        files: group,
        ...(input.onProgress ? { onProgress: async (progress: FixPrecheckProgress) => { await input.onProgress!(progress.currentFile); } } : {}),
      });
    } catch (error) {
      return partial(`the confirmation re-run runner failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!run.ran) return partial(`the confirmation re-run did not run (${run.reason}): ${run.detail}`);
    if (run.commit !== commit) return partial('the confirmation re-run measured a different commit');
    try { validateAdmissionPrecheckResults(group, run.results, true); }
    catch (error) { return partial(`the confirmation re-run returned an invalid measurement: ${String(error)}`); }
    results.push(...run.results);
  }
  return { commit, results };
}

async function runBoundedAdmissionPrecheck(
  input: AdmissionPrecheckWorkerInput,
  queue: FrozenCandidateRepairQueue,
  deps: AdmissionPrecheckWorkerDeps,
  runner: FixPrecheckRunner,
  finalize: () => Promise<void>,
  /** D-004: measures the paired previous-head baseline in a second tree. */
  baselineRunner: FixPrecheckRunner,
): Promise<AdmissionPrecheckWorkerOutcome> {
  const operation = queue.admissionPrecheck!;
  const identity = admissionPrecheckMeasurementIdentity(operation, queue.signature);
  const now = deps.now ?? Date.now;
  const assertFresh = (fresh: FrozenCandidateRepairQueue): FrozenRepairAdmissionPrecheck => {
    const current = fresh.admissionPrecheck;
    if (!current || current.status !== 'running' || current.operationId !== input.operationId ||
        current.runnerTaskId !== input.taskId || fresh.candidate !== operation.candidate || fresh.repairHead !== operation.repairHead ||
        admissionPrecheckMeasurementIdentity(current, fresh.signature) !== identity)
      throw new Error('pre-check immutable operation identity changed');
    return current;
  };
  const unavailable = async (detail: string): Promise<AdmissionPrecheckWorkerOutcome> => {
    await finalize();
    const population = precheckPopulation({ signature: queue.signature, admittedPaths: operation.files,
      removedTestFiles: operation.removedTestFiles, ...(operation.radius ? { radius: operation.radius } : {}) });
    const verdict = evaluateFixPrecheck(population, { ran: false, reason: 'runner-failed', detail });
    await deps.transition(input.queueTarget, fresh => {
      assertFresh(fresh);
      return admissionPrecheckSettlementTransition(fresh, input.operationId, verdict, now());
    });
    return { status: 'settled', verdict };
  };
  // WI-6554700010030199: an interrupted run (runner threw, or the runner could not run, e.g. the
  // checkpoint tree was busy) settles AT ONCE exactly as inspectQueue later would: runner-failed,
  // per-file measurement kept, dispatch reservation released. Returning 'interrupted' with the
  // operation still 'running' left the reservation fencing the gate (wait-for-dispatch-reservation)
  // until some unrelated status read noticed the dead task. retryPrecheck:true resumes the kept
  // rows. Only when settlement itself is refused (a concurrent identity change: the operation is no
  // longer ours, or the queue write failed) does the worker report 'interrupted' and write nothing.
  const interrupted = async (reason: string): Promise<AdmissionPrecheckWorkerOutcome> => {
    try {
      return await unavailable(`pre-check interrupted before a verdict (${reason}); durable per-file progress is kept`);
    } catch (error) {
      return { status: 'interrupted', reason: `${reason}; settlement refused: ${String(error)}` };
    }
  };
  // WI-6554700010030460: a gate run holding the checkpoint tree (at the start, or taken between
  // execution groups) makes the runner report `checkpoint-tree-busy`. Nothing ran, so this is a
  // DEFERRAL, not a runner failure: settle it with the runner's own reason (status `deferred`,
  // per-file rows kept) so the door's "wait for the gate run to release the tree" guidance is
  // accurate and the next confirm resumes the kept rows. Settling it as runner-failed sent callers
  // into retryPrecheck loops that re-failed for as long as the suite held the tree.
  const deferred = async (run: Extract<FixPrecheckRunResult, { reason: 'checkpoint-tree-busy' }>): Promise<AdmissionPrecheckWorkerOutcome> => {
    try {
      await finalize();
      const population = precheckPopulation({ signature: queue.signature, admittedPaths: operation.files,
        removedTestFiles: operation.removedTestFiles, ...(operation.radius ? { radius: operation.radius } : {}) });
      const verdict = evaluateFixPrecheck(population, run);
      await deps.transition(input.queueTarget, fresh => {
        assertFresh(fresh);
        return admissionPrecheckSettlementTransition(fresh, input.operationId, verdict, now());
      });
      return { status: 'settled', verdict };
    } catch (error) {
      return { status: 'interrupted', reason: `${run.detail}; settlement refused: ${String(error)}` };
    }
  };
  if (!operation.builtTree || new Set(operation.files).size !== operation.files.length)
    return unavailable('wide pre-check requires a built-tree identity and unique immutable population');
  const saved = operation.measurement;
  if (saved && saved.identity !== identity) return unavailable('saved measurement identity does not match commit/tree/population');
  try { validateAdmissionPrecheckResults(operation.files, saved?.results ?? []); }
  catch (error) { return unavailable(String(error)); }
  let completed = [...(saved?.results ?? [])];
  const measuredCount = (results: readonly FixPrecheckFileResult[]) =>
    results.filter(result => result.status !== 'unmeasured').length;
  const mergeDetail = (...details: Array<string | undefined>): string | undefined => {
    const unique = [...new Set(details.map(detail => detail?.trim()).filter((detail): detail is string => Boolean(detail)))];
    return unique.length ? unique.join('; ') : undefined;
  };
  try {
    await deps.transition(input.queueTarget, fresh => {
      const current = assertFresh(fresh);
      if (!isDeepStrictEqual(current.measurement ?? null, saved ?? null))
        throw new Error('saved measurement moved before resume');
      const measurement = saved
        ? { ...saved, results: completed }
        : { schemaVersion: 1 as const, identity, results: completed };
      return { ...fresh, admissionPrecheck: { ...current, measurement } };
    });
    const pending = operation.files.filter(file =>
      !completed.some(result => result.path === file && result.status !== 'unmeasured'));
    const groupSize = Math.min(ADMISSION_RADIUS_CAP, ADMISSION_PRECHECK_MAX_FILES);
    for (let start = 0; start < pending.length; start += groupSize) {
      if (now() >= operation.expiresAtMs) return unavailable('bounded pre-check deadline expired before complete aggregation');
      const files = pending.slice(start, start + groupSize);
      const before = measuredCount(completed);
      const observedThisRun = new Map<string, FixPrecheckFileResult>();
      const record = async (result: FixPrecheckFileResult): Promise<void> => {
        validateAdmissionPrecheckResults(files, [result]);
        const previousIndex = completed.findIndex(prior => prior.path === result.path);
        if (previousIndex >= 0 && completed[previousIndex]!.status !== 'unmeasured')
          throw new Error('duplicate measured per-file result');
        await deps.transition(input.queueTarget, fresh => {
          const current = assertFresh(fresh);
          const prior = current.measurement;
          if (!prior || prior.identity !== identity || !isDeepStrictEqual(prior.results, completed))
            throw new Error('persisted measurement moved while recording a file');
          const results = previousIndex < 0
            ? [...completed, result]
            : completed.map((row, index) => index === previousIndex ? result : row);
          const at = now();
          return { ...fresh, updatedAtMs: Math.max(fresh.updatedAtMs + 1, at), admissionPrecheck: { ...current,
            measurement: { ...prior, results }, completedCount: measuredCount(results), totalCount: operation.files.length,
            currentFile: result.path, heartbeatAtMs: at, updatedAtMs: Math.max(current.updatedAtMs + 1, at) } };
        });
        completed = previousIndex < 0
          ? [...completed, result]
          : completed.map((row, index) => index === previousIndex ? result : row);
      };
      let run: FixPrecheckRunResult;
      try {
        run = await runner({ commit: operation.builtCommit, expectedTree: operation.builtTree, files,
          onFileResult: async result => {
            await record(result);
            observedThisRun.set(result.path, result);
          },
          onProgress: async progress => {
            await deps.transition(input.queueTarget, fresh => {
              assertFresh(fresh);
              return admissionPrecheckProgressTransition(fresh, input.operationId, { ...progress, completedCount: before + progress.completedCount, totalCount: operation.files.length });
            });
          } });
      } catch (error) {
        // retryPrecheck:true resumes this SAME operation from its durable per-file rows.
        // Measured rows stay fixed; only missing or unmeasured rows are retried.
        return interrupted(String(error));
      }
      if (!run.ran) return run.reason === 'checkpoint-tree-busy' ? deferred(run) : interrupted(run.detail);
      if (run.commit !== operation.builtCommit) return unavailable('execution-group commit mismatch');
      try { validateAdmissionPrecheckResults(files, run.results, true); }
      catch (error) { return unavailable(String(error)); }
      for (const result of run.results) {
        const observed = observedThisRun.get(result.path);
        if (observed) {
          if (!isDeepStrictEqual(observed, result))
            return unavailable('native final result disagrees with persisted per-file evidence');
          continue;
        }
        const prior = completed.find(item => item.path === result.path);
        if (prior?.status === 'unmeasured' || !prior) await record(result);
        else if (!isDeepStrictEqual(prior, result))
          return unavailable('native final result disagrees with persisted per-file evidence');
      }
    }
    if (now() >= operation.expiresAtMs) return unavailable('bounded pre-check deadline expired before settlement');
    validateAdmissionPrecheckResults(operation.files, completed, true);
    const population = precheckPopulation({ signature: queue.signature, admittedPaths: operation.files,
      removedTestFiles: operation.removedTestFiles, ...(operation.radius ? { radius: operation.radius } : {}) });
    const ordered = operation.files.map(file => completed.find(result => result.path === file)!);
    // D-004 ruling 1: pair every guarded red with a MEASURED previous-head verdict while the
    // operation's own test environment is still running. Reuse valid paired rows from the same
    // immutable operation and measure only rows that are new or still unavailable.
    const baselineFiles = previousHeadBaselineFiles(population, ordered);
    const savedBaseline = saved?.previousHead?.commit === operation.repairHead ? saved.previousHead : undefined;
    let savedBaselineRows = (savedBaseline?.results ?? []).filter(result => baselineFiles.includes(result.path));
    try { validateAdmissionPrecheckResults(baselineFiles, savedBaselineRows); }
    catch { savedBaselineRows = []; }
    const baselineRows = new Map(savedBaselineRows.map(result => [result.path, result]));
    const measuredBaselineFiles = new Set(savedBaselineRows
      .filter(result => result.status !== 'unmeasured').map(result => result.path));
    const baselineMissing = baselineFiles.filter(file => !measuredBaselineFiles.has(file));
    const baselineAttempt = baselineMissing.length ? await measurePreviousHeadBaseline({
      population,
      results: ordered.filter(result => baselineMissing.includes(result.path)),
      previousHead: operation.repairHead,
      runner: baselineRunner,
      deadlineAtMs: operation.expiresAtMs,
      now,
      onProgress: async file => {
        await deps.transition(input.queueTarget, fresh => {
          assertFresh(fresh);
          return admissionPrecheckProgressTransition(fresh, input.operationId, { currentFile: file,
            completedCount: operation.files.length, totalCount: operation.files.length, heartbeatAtMs: now() });
        });
      },
    }) : undefined;
    for (const result of baselineAttempt?.results ?? []) baselineRows.set(result.path, result);
    const previousHead = baselineFiles.length ? {
      commit: operation.repairHead,
      results: baselineFiles.flatMap(file => {
        const result = baselineRows.get(file);
        return result ? [result] : [];
      }),
      ...(baselineFiles.some(file => {
        const result = baselineRows.get(file);
        return !result || result.status === 'unmeasured';
      }) && mergeDetail(savedBaseline?.detail, baselineAttempt?.detail)
        ? { detail: mergeDetail(savedBaseline?.detail, baselineAttempt?.detail)! } : {}),
    } : undefined;
    await deps.transition(input.queueTarget, fresh => {
      const current = assertFresh(fresh);
      const prior = current.measurement;
      if (!prior || prior.identity !== identity || !isDeepStrictEqual(prior.results, completed))
        throw new Error('persisted measurement moved while recording the paired baseline');
      const measurement = { ...prior };
      if (previousHead) measurement.previousHead = {
        commit: previousHead.commit, results: [...previousHead.results],
        ...(previousHead.detail ? { detail: previousHead.detail } : {}),
      };
      else delete measurement.previousHead;
      return { ...fresh, admissionPrecheck: { ...current, measurement } };
    });
    // EI-27083585698781986: confirm each would-be-attributed guarded red with ONE re-run at the SAME
    // built commit while the operation's test environment is still up, and persist it beside the
    // baseline so a re-judged wide measurement sees the same confirmation.
    const confirmationFiles = confirmationRerunFiles(population, ordered, previousHead);
    const savedConfirmation = saved?.confirmation?.commit === operation.builtCommit ? saved.confirmation : undefined;
    let savedConfirmationRows = (savedConfirmation?.results ?? []).filter(result => confirmationFiles.includes(result.path));
    try { validateAdmissionPrecheckResults(confirmationFiles, savedConfirmationRows); }
    catch { savedConfirmationRows = []; }
    const confirmationRows = new Map(savedConfirmationRows.map(result => [result.path, result]));
    const confirmationMissing = confirmationFiles.filter(file => confirmationRows.get(file)?.status === 'unmeasured' ||
      !confirmationRows.has(file));
    const confirmationPreviousHead = previousHead && confirmationMissing.length ? {
      commit: previousHead.commit,
      results: previousHead.results.filter(result => confirmationMissing.includes(result.path)),
      ...(previousHead.detail ? { detail: previousHead.detail } : {}),
    } : undefined;
    const confirmationAttempt = confirmationMissing.length ? await measureConfirmationRerun({
      population,
      results: ordered.filter(result => confirmationMissing.includes(result.path)),
      previousHead: confirmationPreviousHead,
      builtCommit: operation.builtCommit,
      expectedTree: operation.builtTree,
      runner,
      deadlineAtMs: operation.expiresAtMs,
      now,
      onProgress: async file => {
        await deps.transition(input.queueTarget, fresh => {
          assertFresh(fresh);
          return admissionPrecheckProgressTransition(fresh, input.operationId, { currentFile: file,
            completedCount: operation.files.length, totalCount: operation.files.length, heartbeatAtMs: now() });
        });
      },
    }) : undefined;
    for (const result of confirmationAttempt?.results ?? []) confirmationRows.set(result.path, result);
    const confirmation = confirmationFiles.length ? {
      commit: operation.builtCommit,
      results: confirmationFiles.flatMap(file => {
        const result = confirmationRows.get(file);
        return result ? [result] : [];
      }),
      ...(mergeDetail(savedConfirmation?.detail, confirmationAttempt?.detail)
        ? { detail: mergeDetail(savedConfirmation?.detail, confirmationAttempt?.detail)! } : {}),
    } : undefined;
    await deps.transition(input.queueTarget, fresh => {
      const current = assertFresh(fresh);
      const prior = current.measurement;
      if (!prior || prior.identity !== identity || !isDeepStrictEqual(prior.results, completed))
        throw new Error('persisted measurement moved while recording the confirmation re-run');
      const measurement = { ...prior };
      if (confirmation) measurement.confirmation = {
        commit: confirmation.commit, results: [...confirmation.results],
        ...(confirmation.detail ? { detail: confirmation.detail } : {}),
      };
      else delete measurement.confirmation;
      return { ...fresh, admissionPrecheck: { ...current, measurement } };
    });
    if (now() >= operation.expiresAtMs) return unavailable('bounded pre-check deadline expired before settlement');
    await finalize();
    const verdict = evaluateFixPrecheck(population, { ran: true, commit: operation.builtCommit, results: ordered },
      { actor: operation.actor, ...(previousHead ? { previousHead } : {}), ...(confirmation ? { confirmation } : {}) });
    await deps.transition(input.queueTarget, fresh => {
      assertFresh(fresh);
      return admissionPrecheckSettlementTransition(fresh, input.operationId, verdict, now());
    });
    return { status: 'settled', verdict };
  } catch (error) { return interrupted(String(error)); }
}

export async function runAdmissionPrecheckWorker(
  input: AdmissionPrecheckWorkerInput,
  deps: AdmissionPrecheckWorkerDeps = defaultWorkerDeps,
): Promise<AdmissionPrecheckWorkerOutcome> {
  const task = await deps.getTask(input.taskId);
  if (!task || !task.confined || (task.state !== 'pending' && task.state !== 'running')) {
    return { status: 'ignored', reason: 'managed task is absent, unconfined, or no longer live' };
  }

  if (input.proposal) {
    const runProposal = deps.runProposal ?? (await import('./staging-fix-proposal-cli')).runAutomaticStagingFixProposal;
    await runProposal(input);
    return { status: 'proposed' };
  }

  const read = await deps.readQueue(input.queueTarget);
  if (read.status !== 'value') return { status: 'ignored', reason: `repair queue is ${read.status}` };
  const queue = read.queue;
  const operation = queue.admissionPrecheck;
  if (
    !operation || operation.operationId !== input.operationId || operation.runnerTaskId !== input.taskId ||
    operation.status !== 'running'
  ) {
    return { status: 'ignored', reason: 'operationId no longer names the running queue pre-check' };
  }

  const population = precheckPopulation({
    signature: queue.signature as readonly RepairSignatureEntry[],
    admittedPaths: operation.files,
    removedTestFiles: operation.removedTestFiles,
    // P-007 (#D-037): without the persisted partition every radius file would count as admitted.
    ...(operation.radius ? { radius: operation.radius } : {}),
  });
  let environment: Promise<AdmissionTestEnvironment> | undefined;
  let fixture: AdmissionTestEnvironment | undefined;
  let bootstrapping = true;
  let finishing: Promise<void> | undefined;
  const finalize = async () => { if (environment) await (finishing ??= environment.then(fixture => fixture.stop())); };
  const runnerOptions = {
    integrationRoot: input.integrationRoot,
    checkpointRoot: input.checkpointRoot,
    testRunHarness: input.queueTarget.installSlug,
    // WI-6554700010030140: measure files concurrently; the baseline runner inherits it.
    fileConcurrency: admissionPrecheckFileConcurrency(),
    // One runner per operation; keep the 40-file groups and durable per-file settlement,
    // but avoid rebuilding the identical clean checkout at every group boundary.
    reusePreparedTree: true,
    ...(input.toolingRoot ? { toolingRoot: input.toolingRoot } : {}),
    ...(input.testCommand ? { testCommand: input.testCommand } : {}),
    ...(input.clearEnv ? { clearEnv: input.clearEnv } : {}),
    assertTestEnvironment: () => fixture?.assertRunning(),
    prepareTestEnvironment: async (root: string, onOutput: () => void) => {
      environment ??= (deps.startTestEnvironment ?? startAdmissionTestEnvironment)(root, {
        onOutput: () => { if (bootstrapping) onOutput(); }, log: line => console.log(line),
        testRunsDbUrl: process.env.PAPERCUSP_TEST_RUNS_DB_URL ?? getHarnessAdminUrl(),
      });
      fixture = await environment;
      bootstrapping = false;
      fixture.assertRunning();
      return fixture.env;
    },
  };
  const runner = deps.createRunner(runnerOptions);
  // D-004: the paired baseline shares the runner options and the ONE operation-owned test
  // environment; only its tree differs, so the previous head never re-pins the admission tree.
  // Built lazily: an admission with no guarded red never materializes a second tree.
  let lazyBaselineRunner: FixPrecheckRunner | undefined;
  const baselineRunner: FixPrecheckRunner = run =>
    (lazyBaselineRunner ??= deps.createRunner({ ...runnerOptions, precheckRootSuffix: ADMISSION_PRECHECK_BASELINE_ROOT_SUFFIX }))(run);
  try {
  try {
  if (operation.files.length > ADMISSION_RADIUS_CAP || operation.measurement)
    return await runBoundedAdmissionPrecheck(input, queue, deps, runner, finalize, baselineRunner);
  let run: FixPrecheckRunResult;
  try {
    run = await runner({
      commit: operation.builtCommit,
      files: operation.files,
      onProgress: async (progress) => {
        await deps.transition(input.queueTarget, (fresh) =>
          admissionPrecheckProgressTransition(fresh, input.operationId, progress));
      },
    });
  } catch (error) {
    run = {
      ran: false,
      reason: 'runner-failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  // D-004 ruling 1: pair each guarded red with a MEASURED previous-head verdict before the
  // operation's test environment stops; the verdict carries the baseline it was judged against.
  const previousHead = run.ran
    ? await measurePreviousHeadBaseline({
        population, results: run.results, previousHead: operation.repairHead, runner: baselineRunner,
        deadlineAtMs: operation.expiresAtMs, ...(deps.now ? { now: deps.now } : {}),
        onProgress: async file => {
          await deps.transition(input.queueTarget, fresh => admissionPrecheckProgressTransition(fresh, input.operationId, {
            currentFile: file, completedCount: operation.files.length, totalCount: operation.files.length,
            heartbeatAtMs: (deps.now ?? Date.now)() }));
        },
      })
    : undefined;
  // EI-27083585698781986: one confirmation re-run at the SAME built commit, before the test
  // environment stops, for every guarded red the ratchet would otherwise attribute.
  const confirmation = run.ran
    ? await measureConfirmationRerun({
        population, results: run.results, previousHead, builtCommit: operation.builtCommit, runner,
        deadlineAtMs: operation.expiresAtMs, ...(deps.now ? { now: deps.now } : {}),
        onProgress: async file => {
          await deps.transition(input.queueTarget, fresh => admissionPrecheckProgressTransition(fresh, input.operationId, {
            currentFile: file, completedCount: operation.files.length, totalCount: operation.files.length,
            heartbeatAtMs: (deps.now ?? Date.now)() }));
        },
      })
    : undefined;
  // Cleanup is evidence too: an unverified stop must never leave a passed marker.
  await finalize();
  // P-006: the admission ratchet routes an imports-red refusal to the admitting actor.
  const verdict = evaluateFixPrecheck(population, run, { actor: operation.actor ?? null,
    ...(previousHead ? { previousHead } : {}), ...(confirmation ? { confirmation } : {}) });
  const settledAtMs = (deps.now ?? Date.now)();
  await deps.transition(input.queueTarget, (fresh) =>
    admissionPrecheckSettlementTransition(fresh, input.operationId, verdict, settledAtMs));
  return { status: 'settled', verdict };
  } finally { await finalize(); }
  } catch (error) {
    // A dead fixture or failed cleanup cannot leave a running marker whose
    // terminal event never arrives. Preserve completed rows and settle unavailable.
    const verdict = evaluateFixPrecheck(population, { ran: false, reason: 'runner-failed',
      detail: error instanceof Error ? error.message : String(error) }, { actor: operation.actor ?? null });
    await deps.transition(input.queueTarget, fresh =>
      admissionPrecheckSettlementTransition(fresh, input.operationId, verdict, (deps.now ?? Date.now)()));
    return { status: 'settled', verdict };
  }
}

export function parseAdmissionPrecheckWorkerInput(raw: string | undefined): AdmissionPrecheckWorkerInput | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const target = row.queueTarget;
    if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
    const queueTarget = target as Record<string, unknown>;
    if (
      typeof row.operationId !== 'string' || !row.operationId.trim() ||
      typeof row.taskId !== 'string' || !row.taskId.trim() ||
      typeof queueTarget.workspaceId !== 'string' || !queueTarget.workspaceId.trim() ||
      typeof queueTarget.installSlug !== 'string' || !queueTarget.installSlug.trim() ||
      typeof row.integrationRoot !== 'string' || !row.integrationRoot.trim() ||
      typeof row.checkpointRoot !== 'string' || !row.checkpointRoot.trim() ||
      (row.toolingRoot !== undefined && (typeof row.toolingRoot !== 'string' || !row.toolingRoot.trim())) ||
      (row.testCommand !== undefined && (!Array.isArray(row.testCommand) || !row.testCommand.length ||
        !row.testCommand.every((arg) => typeof arg === 'string' && arg.trim()))) ||
      (row.clearEnv !== undefined && (!Array.isArray(row.clearEnv) ||
        !row.clearEnv.every((key) => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))) ||
      (row.proposal !== undefined && (!row.proposal || typeof row.proposal !== 'object' ||
        Array.isArray(row.proposal) ||
        !/^[a-f0-9]{40}$/.test(String((row.proposal as Record<string, unknown>).candidate)) ||
        !/^[a-f0-9]{40}$/.test(String((row.proposal as Record<string, unknown>).repairHead)))) ||
      typeof row.expiresAtMs !== 'number' || !Number.isFinite(row.expiresAtMs) || row.expiresAtMs < 0
    ) return null;
    return {
      operationId: row.operationId,
      taskId: row.taskId,
      queueTarget: { workspaceId: queueTarget.workspaceId, installSlug: queueTarget.installSlug },
      integrationRoot: row.integrationRoot,
      checkpointRoot: row.checkpointRoot,
      ...(typeof row.toolingRoot === 'string' ? { toolingRoot: row.toolingRoot } : {}),
      ...(Array.isArray(row.testCommand) ? { testCommand: row.testCommand as string[] } : {}),
      ...(Array.isArray(row.clearEnv) ? { clearEnv: row.clearEnv as string[] } : {}),
      expiresAtMs: row.expiresAtMs,
      ...(row.proposal ? { proposal: row.proposal as { candidate: string; repairHead: string } } : {}),
    };
  } catch {
    return null;
  }
}

export async function runAdmissionPrecheckWorkerFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const input = parseAdmissionPrecheckWorkerInput(env[ADMISSION_PRECHECK_WORKER_INPUT_ENV]);
  if (!input) {
    console.error('[release:repair-queue] worker input is missing or invalid');
    return 2;
  }
  try {
    const result = await runAdmissionPrecheckWorker(input);
    if (result.status === 'ignored') console.warn(`[release:repair-queue] pre-check ${input.operationId} ignored: ${result.reason}`);
    if (result.status === 'interrupted') {
      console.error(`[release:repair-queue] pre-check ${input.operationId} interrupted with durable progress: ${result.reason}`);
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(`[release:repair-queue] pre-check ${input.operationId} worker failed`, error);
    return 1;
  }
}

/** Finite entry role: finish queue settlement and diagnostics before terminating the worker. */
export async function runAdmissionPrecheckWorkerMain(): Promise<never> {
  let code: number;
  try {
    code = await runAdmissionPrecheckWorkerFromEnvironment();
  } catch (error) {
    console.error('[release:repair-queue] pre-check worker startup failed', error);
    code = 1;
  }
  // Host imports and database clients can retain referenced handles after the finite task
  // finishes. exitCode alone cannot terminate this role. Like restricted-hold-preflight-cli,
  // explicitly exit after the pipe writes flush; include stderr so startup errors survive.
  await Promise.all([process.stdout, process.stderr].map((stream) =>
    new Promise<void>((resolveFlush) => { stream.write('', () => resolveFlush()); }),
  ));
  process.exit(code);
}
