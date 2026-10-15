/** Host independent, task-managed runner for the frozen repair admission pre-check. */
import { dirname, join } from 'node:path';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getTask } from '../task-manager/store';
import { managedSpawn, type ManagedSpawnResult } from '../task-manager/managed-spawn';
import { isValidTaskId, type TaskRow } from '../task-manager/types';
import { resolveSidecarSpawnPlan, type SidecarSpawnPlan } from '../process-supervision/sidecar-spawn-shared';
import {
  applyFrozenCandidateRepairQueueTransition,
  readFrozenCandidateRepairQueueState,
} from '../harness/routines/release-actions';
import {
  createCheckpointTreeFixPrecheckRunner,
  evaluateFixPrecheck,
  precheckPopulation,
  type FixPrecheckProgress,
  type FixPrecheckRunResult,
  type FixPrecheckVerdict,
} from './admission-fix-precheck';
import type {
  FrozenCandidateRepairQueue,
  FrozenCandidateRepairQueueRead,
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
  return resolveSidecarSpawnPlan({
    selfPath: options.selfPath ?? fileURLToPath(import.meta.url),
    devScriptPath: join(options.moduleDirOverride ?? moduleDir, 'admission-fix-precheck-worker-bin.ts'),
    bundledModeEnvVar: ADMISSION_PRECHECK_WORKER_MODE_ENV,
    execPath: options.execPath ?? process.execPath,
    spawnerPid: options.spawnerPid ?? process.pid,
  });
}

export async function startAdmissionPrecheckWorker(
  input: AdmissionPrecheckWorkerInput,
  options: { spawnPlan?: SidecarSpawnPlan; logDir?: string; spawn?: typeof managedSpawn } = {},
): Promise<ManagedSpawnResult> {
  if (!isValidTaskId(input.taskId)) throw new Error('invalid admission pre-check task id');
  const plan = options.spawnPlan ?? buildAdmissionPrecheckSpawnPlan();
  const args = [...plan.args];
  const env = {
    ...process.env,
    ...plan.env,
    [ADMISSION_PRECHECK_WORKER_INPUT_ENV]: JSON.stringify(input),
  };
  const logDir = options.logDir ?? join(homedir(), '.papercusp', 'checkpoint-logs');
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
  return {
    ...rest,
    ...(dispatchReservation?.token === operationId ? {} : { dispatchReservation }),
    admissionPrecheck: {
      ...current,
      status: verdict.ok ? (verdict.ran ? 'passed' : 'deferred') : 'failed',
      verdict,
      updatedAtMs: settledAtMs,
    },
    updatedAtMs: Math.max(fresh.updatedAtMs + 1, settledAtMs),
  };
}

export interface AdmissionPrecheckWorkerDeps {
  runProposal?: (input: AdmissionPrecheckWorkerInput) => Promise<void>;
  getTask: (taskId: string) => Promise<Pick<TaskRow, 'state' | 'confined'> | null>;
  readQueue: (target: AdmissionPrecheckQueueTarget) => Promise<FrozenCandidateRepairQueueRead>;
  transition: (
    target: AdmissionPrecheckQueueTarget,
    update: (fresh: FrozenCandidateRepairQueue) => FrozenCandidateRepairQueue,
  ) => Promise<unknown>;
  createRunner: (options: { integrationRoot: string; checkpointRoot: string; testRunHarness: string }) => (
    input: {
      commit: string;
      files: readonly string[];
      onProgress?: (progress: FixPrecheckProgress) => Promise<void> | void;
    },
  ) => Promise<FixPrecheckRunResult>;
  now?: () => number;
}

export type AdmissionPrecheckWorkerOutcome =
  | { status: 'settled'; verdict: FixPrecheckVerdict }
  | { status: 'proposed' }
  | { status: 'ignored'; reason: string };

const defaultWorkerDeps: AdmissionPrecheckWorkerDeps = {
  getTask,
  readQueue: readFrozenCandidateRepairQueueState,
  transition: applyFrozenCandidateRepairQueueTransition,
  createRunner: createCheckpointTreeFixPrecheckRunner,
};

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
    // P-007 (#D-037): without the persisted partition every radius file would count as admitted.
    ...(operation.radius ? { radius: operation.radius } : {}),
  });
  const runner = deps.createRunner({
    integrationRoot: input.integrationRoot,
    checkpointRoot: input.checkpointRoot,
    testRunHarness: input.queueTarget.installSlug,
    ...(input.toolingRoot ? { toolingRoot: input.toolingRoot } : {}),
    ...(input.testCommand ? { testCommand: input.testCommand } : {}),
    ...(input.clearEnv ? { clearEnv: input.clearEnv } : {}),
  });
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

  const verdict = evaluateFixPrecheck(population, run);
  const settledAtMs = (deps.now ?? Date.now)();
  await deps.transition(input.queueTarget, (fresh) =>
    admissionPrecheckSettlementTransition(fresh, input.operationId, verdict, settledAtMs));
  return { status: 'settled', verdict };
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
