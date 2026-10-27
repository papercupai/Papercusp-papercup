import { papercuspPath } from '@papercusp/host-platform/home';
/**
 * `system:operator-e2e-isolated` — the standing nightly run of the operator Playwright suite
 * inside the isolated `verify-tauri-headless` rig (plan operator-e2e-standing-isolated-run-2026-10-06
 * P-002, WI-10006805; umbrella WI-10006736).
 *
 * WHY. Nothing ran `apps/operator/e2e/*.spec.ts` on a cadence: 40 of 58 specs last finished
 * non-pass and nobody noticed, because no gate or routine produced the signal (WI-10006736).
 * P-001 built the one-command runner (`scripts/run-operator-e2e-isolated.sh`): it boots the
 * rig with `VERIFY_TAURI_ISOLATED_DB=1` (throwaway PG + WebView profile, so the suite's writes
 * never touch live state) and pins the ledger reporter to the SHARED `test_runs` table. This
 * module is the routine leg that FIRES that runner, so the signal exists without a human.
 *
 * SHAPE — a small dispatcher, like `nightly-release-cut-action.ts`. A run is ~8-10 min of
 * Playwright plus a ~5 min rig boot, and it can queue behind other heavy work for up to
 * pc-heavy's 15-minute wait. Holding a DBOS routine step that long would occupy a routines-queue
 * slot for nothing, so the action launches the runner through `managedSpawn` (enrolled in the
 * task ledger, its own transient scope, bounded by `runtimeMaxSec`, survives a bg-host restart)
 * and returns. The runner's ledger reporter records every spec result itself, so the action
 * does not need to wait for an exit code to make the run visible.
 *
 * RUN-GROUP IDENTITY (plan D-001 #1). Every row is stamped
 * `PAPERCUSP_TEST_RUN_GROUP=operator-e2e-nightly:<routine fire id>`. Ledger `source` is
 * `local` for both a routine fire and a manual run, so the group prefix is the only way a
 * reader can tell them apart. The fire id is the DBOS workflow id when the routine engine
 * dispatched the action, otherwise the managed task id.
 *
 * LEDGER IDENTITY. The rig rebinds `PAPERCUSP_WORKSPACE_ID` to its throwaway workspace before
 * running the suite. The runner pins `PAPERCUSP_TEST_RUN_WORKSPACE` / `_HARNESS` from its
 * caller first, so this action passes the routine's own workspace and harness explicitly;
 * otherwise the rows would carry the throwaway ids and be invisible to workspace-scoped reads.
 *
 * SINGLE FLIGHT. `concurrency:'skip'` on the routine row only covers an in-process fire that is
 * still running, and this action returns at once. The task ledger is the real liveness oracle:
 * a pending/running row launched by `system:operator-e2e-isolated` means a run is in flight, and
 * a second fire (a manual trigger, a catch-up) skips instead of booting a second rig.
 *
 * EXIT CODES are not classified here. The managed task records the child's exit. `75` from
 * pc-heavy means "undetermined" (for example, an install held the slot). Turning reds into
 * owned work-items is P-003's job, which reads the ledger, not this process.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, unlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { managedSpawn } from '../../task-manager/managed-spawn';
import {
  listTasks,
  OPERATOR_E2E_TASK_CLASS,
  OPERATOR_E2E_TASK_LAUNCHED_BY,
  OPERATOR_E2E_TASK_RETENTION_RUNS,
  OPERATOR_E2E_TASK_SUBSYSTEM,
} from '../../task-manager/store';
import { newTaskId, type TaskRow } from '../../task-manager/types';
import { registerSystemAction, type SystemActionCtx, type SystemActionResult } from './system-actions';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

export const OPERATOR_E2E_ISOLATED_ACTION = 'operator-e2e-isolated';
/** The PAPERCUSP_SID a routine fire hands the rig when no caller session id is inherited. */
export const OPERATOR_E2E_ISOLATED_SID = OPERATOR_E2E_TASK_LAUNCHED_BY;

/** Ledger run-group prefix for routine fires (plan D-001 #1). */
export const OPERATOR_E2E_RUN_GROUP_PREFIX = 'operator-e2e-nightly';

/** Repository-relative runner (P-001) and the host-wide heavy-work admission wrapper. */
export const OPERATOR_E2E_RUNNER_REL = 'scripts/run-operator-e2e-isolated.sh';
export const PC_HEAVY_REL = 'scripts/pc-heavy.sh';

/**
 * Hard deadline on the whole child, applied to its transient scope. Budget: up to 15 min
 * waiting for a pc-heavy slot (its default PC_HEAVY_TIMEOUT_SEC), ~5 min rig boot including a
 * warm cargo build, ~8-10 min of Playwright measured on run 2 of WI-10006736. That is ~30 min;
 * 60 min leaves room for a cold cargo build and a busy box while still bounding a wedged rig.
 */
export const OPERATOR_E2E_RUNTIME_MAX_SEC = 60 * 60;

/**
 * Memory ceiling for the managed scope. [inferred, not yet measured] The rig runs embedded PG,
 * the operator sidecar, Vite, a WebKit webview and the Playwright workers, so it is sized as a
 * runaway bound rather than from a peak. Re-size it from pc-heavy's job-peaks ledger once the
 * first routine fires have recorded a peak.
 */
export const OPERATOR_E2E_MEMORY_MAX_BYTES = 24 * 1024 ** 3;

/** How many per-run log files to keep. Nightly, so two weeks of history. */
export const OPERATOR_E2E_LOGS_KEPT = OPERATOR_E2E_TASK_RETENTION_RUNS;

export function integrationRoot(): string {
  return process.env.PAPERCUSP_INTEGRATION_ROOT ?? path.resolve(process.cwd(), '..', '..');
}

export function operatorE2eLogDir(): string {
  return process.env.OPERATOR_E2E_LOG_DIR ?? papercuspPath('logs', OPERATOR_E2E_ISOLATED_ACTION);
}

/** The run group a fire stamps on every ledger row. */
export function operatorE2eRunGroup(fireId: string): string {
  return `${OPERATOR_E2E_RUN_GROUP_PREFIX}:${fireId}`;
}

export interface OperatorE2eInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  runGroup: string;
}

/**
 * PURE: the command, argv and environment for one fire. The runner is wrapped in pc-heavy
 * when the wrapper exists, so a nightly run queues politely behind other heavy work instead of
 * piling a full rig onto a saturated box. A tree without the wrapper runs the runner directly,
 * the same fallback `gitnexus-reindex-action.ts`'s `buildAnalyzeInvocation` uses.
 */
export function buildOperatorE2eInvocation(
  root: string,
  ids: { fireId: string; workspaceId: string; harnessSlug: string; receiptBasePath?: string },
  baseEnv: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): OperatorE2eInvocation {
  const runner = path.join(root, OPERATOR_E2E_RUNNER_REL);
  const pcHeavy = path.join(root, PC_HEAVY_REL);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) if (value !== undefined) env[key] = value;
  const runGroup = operatorE2eRunGroup(ids.fireId);
  env.PAPERCUSP_TEST_RUN_GROUP = runGroup;
  env.PAPERCUSP_TEST_RUN_WORKSPACE = ids.workspaceId;
  env.PAPERCUSP_TEST_RUN_HARNESS = ids.harnessSlug;
  // The default suite includes native post-onboarding journeys. Request the
  // rig's verified ready seed and isolated worker placement, and give receipt
  // writers distinct per-attempt outputs rather than inherited stale paths.
  env.VERIFY_TAURI_ISOLATED_SEED = 'ready';
  env.PAPERCUSP_DEV_BACKGROUND_WORKERS = '1';
  const receiptBase = path.resolve(ids.receiptBasePath
    ?? path.join(operatorE2eLogDir(), encodeURIComponent(ids.fireId)));
  env.PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE = `${receiptBase}.inbox-ack.json`;
  env.PAPERCUSP_TEST_RUN_RECEIPT_FILE = `${receiptBase}.test-runs.jsonl`;
  // This standing routine must snapshot committed current-build source. The
  // generic runner treats an explicitly empty VERIFY_TAURI_SOURCE_REF as a
  // request for mutable working-tree mode, which can fail on unrelated peer
  // file locks. Pin HEAD here; manual invocations retain the runner's opt-in
  // working-tree behavior.
  env.VERIFY_TAURI_SOURCE_REF = 'HEAD';
  // verify-tauri-headless.sh refuses to launch without PAPERCUSP_SID (its provenance anchor).
  // bg-host has no session id, so the first real routine fire died at launch with
  // "PAPERCUSP_SID is unset" while every probe run inherited the agent's own id. A routine
  // fire is attributed to the action; a manual run keeps the caller's identity.
  if (!env.PAPERCUSP_SID?.trim()) env.PAPERCUSP_SID = OPERATOR_E2E_ISOLATED_SID;
  // The runner also unsets this; removing it here keeps the env we record on the task honest.
  delete env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER;
  const args = exists(pcHeavy) ? [pcHeavy, '--', 'bash', runner] : [runner];
  return { command: 'bash', args, cwd: root, env, runGroup };
}

/** Keep the newest `keep` routine-owned logs. The directory also contains manual
 * verifier logs (including live writers); their names are not chronological and
 * this routine must never delete them (WI-10007105). Fail-soft on prune errors. */
export function pruneOperatorE2eLogs(dir: string, keep: number): void {
  try {
    const logs = readdirSync(dir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[A-Za-z0-9_-]+\.log$/.test(name))
      .sort();
    for (const name of logs.slice(0, Math.max(0, logs.length - keep))) unlinkSync(path.join(dir, name));
  } catch {
    /* fail-soft */
  }
}

export interface OperatorE2eRunResult {
  status: 'launched' | 'skipped';
  reason?: string;
  runGroup?: string;
  taskId?: string;
  logPath?: string;
}

export interface OperatorE2eRunOptions {
  env?: NodeJS.ProcessEnv;
  root?: string;
  platform?: NodeJS.Platform;
  now?: Date;
  taskId?: string;
  logDir?: string;
  exists?: (p: string) => boolean;
  spawnFn?: typeof managedSpawn;
  /** Live ledger rows launched by this action; injected in tests. */
  listInFlight?: (workspaceId: string) => Promise<TaskRow[]>;
}

async function defaultListInFlight(workspaceId: string): Promise<TaskRow[]> {
  return listTasks({
    workspaceId,
    launchedBy: `system:${OPERATOR_E2E_ISOLATED_ACTION}`,
    states: ['pending', 'running'],
    limit: 5,
  });
}

export async function runOperatorE2eIsolated(
  ctx: Pick<SystemActionCtx, 'installSlug' | 'workspaceId'> & Partial<Pick<SystemActionCtx, 'workflowId' | 'routineId'>>,
  opts: OperatorE2eRunOptions = {},
): Promise<OperatorE2eRunResult> {
  const platform = opts.platform ?? process.platform;
  // The rig needs Xvfb + VirtualGL; it exists only on Linux.
  if (platform !== 'linux') return { status: 'skipped', reason: 'the isolated Tauri rig is Linux-only' };
  const home = operatorHomeHarnessSlug();
  // The operator suite only exists in the operator-home repo. A blank installSlug (a manual
  // fire) is treated as operator-home, the same convention as cargo-test-action.ts.
  if (ctx.installSlug && ctx.installSlug !== home) {
    return { status: 'skipped', reason: `not the operator-home harness (got "${ctx.installSlug}", home is "${home}")` };
  }
  const root = opts.root ?? integrationRoot();
  const exists = opts.exists ?? existsSync;
  if (!exists(path.join(root, OPERATOR_E2E_RUNNER_REL))) {
    return { status: 'skipped', reason: `${OPERATOR_E2E_RUNNER_REL} not found under ${root}` };
  }
  const inFlight = await (opts.listInFlight ?? defaultListInFlight)(ctx.workspaceId);
  if (inFlight.length > 0) {
    return {
      status: 'skipped',
      reason: `a run is already in flight (task ${inFlight.map((row) => row.taskId).join(', ')})`,
    };
  }

  const taskId = opts.taskId ?? newTaskId();
  const fireId = ctx.workflowId || taskId;
  const harnessSlug = ctx.installSlug || home;
  const logDir = opts.logDir ?? operatorE2eLogDir();
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(logDir, `${stamp}-${taskId}.log`);
  const invocation = buildOperatorE2eInvocation(
    root,
    { fireId, workspaceId: ctx.workspaceId, harnessSlug, receiptBasePath: logPath },
    opts.env ?? process.env,
    exists,
  );

  let logFd: number | null = null;
  try {
    mkdirSync(logDir, { recursive: true });
    // keep - 1: the file about to be created is the newest.
    pruneOperatorE2eLogs(logDir, OPERATOR_E2E_LOGS_KEPT - 1);
    logFd = openSync(logPath, 'a');
  } catch (error) {
    console.warn(
      `[${OPERATOR_E2E_ISOLATED_ACTION}] cannot open ${logPath}; the child's output is discarded: ${String(error)}`,
    );
  }

  const spawn = opts.spawnFn ?? managedSpawn;
  try {
    const managed = await spawn(
      invocation.command,
      invocation.args,
      {
        class: OPERATOR_E2E_TASK_CLASS,
        title: `operator e2e (isolated) ${invocation.runGroup}`,
        argv: [invocation.command, ...invocation.args],
        cwd: invocation.cwd,
        launchedBy: OPERATOR_E2E_TASK_LAUNCHED_BY,
        harnessSlug,
        memoryMaxBytes: OPERATOR_E2E_MEMORY_MAX_BYTES,
        runtimeMaxSec: OPERATOR_E2E_RUNTIME_MAX_SEC,
        ...(logFd == null ? {} : { logPath }),
        detail: {
          subsystem: OPERATOR_E2E_TASK_SUBSYSTEM,
          runGroup: invocation.runGroup,
          routineId: ctx.routineId ?? null,
          workflowId: ctx.workflowId ?? null,
          plan: 'operator-e2e-standing-isolated-run-2026-10-06',
        },
      },
      {
        workspaceId: ctx.workspaceId,
        taskId,
        spawnOptions: {
          cwd: invocation.cwd,
          env: invocation.env,
          detached: true,
          stdio: logFd == null ? 'ignore' : ['ignore', logFd, logFd],
        },
      },
    );
    return {
      status: 'launched',
      runGroup: invocation.runGroup,
      taskId: managed.taskId,
      ...(logFd == null ? {} : { logPath }),
    };
  } catch (error) {
    return {
      status: 'skipped',
      reason: `managed spawn failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    // The child holds its own copy of the descriptor.
    if (logFd != null) closeSync(logFd);
  }
}

registerSystemAction(
  OPERATOR_E2E_ISOLATED_ACTION,
  async (ctx: SystemActionCtx): Promise<SystemActionResult> => {
    const result = await runOperatorE2eIsolated(ctx);
    if (result.status === 'skipped') {
      console.warn(`[${OPERATOR_E2E_ISOLATED_ACTION}] skip: ${result.reason}`);
    } else {
      console.log(
        `[${OPERATOR_E2E_ISOLATED_ACTION}] launched ${result.runGroup} (task ${result.taskId}, log ${result.logPath ?? 'none'})`,
      );
    }
    return { diagnostics: { ...result } };
  },
  // The action returns once the managed child is enrolled, so a short routine step is right even
  // though the child has a one-hour budget. WI-10005745: the child runs the LIVE tree's runner,
  // rig and Playwright specs, so a held restricted write must skip this fire.
  { routineTimeoutMs: 60_000, executesIntegrationTreeCode: true },
);
