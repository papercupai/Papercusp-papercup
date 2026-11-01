/**
 * The spawner sidecar's generic "run a process and give me its output" seam,
 * behind the `process:exec` JSON-RPC method.
 *
 * Lives in its OWN module rather than inside spawner-sidecar-server.ts so it can
 * be tested against real `git` without importing the server, which pulls in
 * `spawnInvokeOnce` (the whole orchestrator-runner chain) purely to serve a
 * different RPC method. Nothing here knows about agent spawning.
 *
 * ## The fd handoff (WI-6404)
 *
 * `process:exec` originally piped stdout and returned it as a STRING on the
 * line-delimited JSON reply. That is fine for plumbing output (oids, refs,
 * `rev-parse`), and wrong for the `git cat-file --batch` seam, which carries
 * multi-MB blob CONTENTS whose exact byte offsets are load-bearing — frames are
 * `<oid> SP <type> SP <size> LF <contents> LF`, so a single shifted byte
 * desynchronises the whole stream.
 *
 * Sending those bytes inline would mean base64 (+33%, plus JSON escaping) and a
 * multi-MB `JSON.parse` on the MAIN THREAD at both ends — plausibly a bigger
 * stall than the ~165ms fork the sidecar exists to remove, which would defeat
 * the point entirely. So `stdinPath`/`stdoutPath` hand real FILE DESCRIPTORS to
 * the child instead: git reads and writes them at kernel level, the bytes never
 * enter this process or the JSON channel, and byte fidelity is structural
 * rather than promised.
 */
import * as fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcess } from 'node:child_process';
import { processGroupLifetime } from './process-group-lifetime';
import { FORKSERVER_LOST_CODE, spawnSidecarChild, type SidecarChild, type SidecarSpawnRequest } from './forkserver/forkserver-client';
import { SIDECAR_PROCESS_KILL_GRACE_MS } from './sidecar-exec-lifetime';
import { observeAdmission, type AdmissionHealthObserver } from './sidecar-admission-wedge';

import { isReadOnlyGitBatchExec } from '../git-batch';
import { gitSubcommandOf, qualifiesForLazyReceipt as qualifiesForLazyGitExec } from './sidecar-read-only-git';

import type { AdmissionContext, ResourceDemand } from '../resource-governor/admission';
import {
  admissionContextFromEnvironment,
  beginGovernedExecution,
  governedExecutionRuntime,
  settleGovernedExecutionInBackground,
  type GovernedExecutionAdmissionPhaseEvent,
  type GovernedExecution,
} from '../resource-governor/execution';
import { activeWorkspaceId } from '../workspace-registry';

export const PROCESS_EXEC_CALLER_LABELS = {
  command: 'git-via-sidecar.runCommandViaSpawnerSidecar',
  stdin: 'git-via-sidecar.runGitStdinViaSpawnerSidecar',
} as const;

export type ProcessExecCallerLabel =
  (typeof PROCESS_EXEC_CALLER_LABELS)[keyof typeof PROCESS_EXEC_CALLER_LABELS];

export interface ExecParams {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Include process.env in the child environment; defaults to true. */
  inheritEnv?: boolean;
  /** Per-stream byte cap for captured stdout/stderr. */
  maxBuffer?: number;
  /** Safe, static callsite identity for transport-fault diagnostics. */
  callerLabel?: ProcessExecCallerLabel;
  /** Optional no-output deadline. Unlike `timeoutMs` (the absolute hard
   * ceiling), this timer refreshes on observed stdout/stderr progress. File
   * output is sampled at idle deadlines, without copying its bytes into JS. */
  idleTimeoutMs?: number;
  timeoutMs?: number;
  /**
   * FD HANDOFF, input leg. When set, the child's stdin IS this file: the sidecar
   * opens it and passes the fd as `stdio[0]`, so the child reads it directly.
   * Absent ⇒ stdin is `'ignore'`, exactly as before.
   */
  stdinPath?: string;
  /**
   * FD HANDOFF, output leg. When set, the child's stdout is written STRAIGHT to
   * this file (see the module header for why). Absent ⇒ stdout is piped and
   * accumulated into `stdout`, exactly as before.
   */
  stdoutPath?: string;
  /** Explicit scope for the durable admission receipt. */
  workspaceId?: string;
  /** Stable caller identity for receipt ownership and operator visibility. */
  ownerId?: string;
  /** Optional retry key. Omitted calls are unique process starts. */
  idempotencyKey?: string;
  /** Typed nested lineage. When absent, the propagated process env is decoded. */
  admissionContext?: AdmissionContext;
  /** Bind dispatch to the server/connection observed before starting work.
   * Validated by the IPC server before admission, never by a durable receipt. */
  fence?: { serverGeneration: string; connectionId: string; forkserverIdentity?: string | null };
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Actual process failure, retained separately from argv-heavy stderr. */
  error?: { code: string | null; signal: string | null; killed: boolean };
  /** The captured stream that crossed maxBuffer, when a cap was supplied. */
  maxBufferExceeded?: 'stdout' | 'stderr';
  /** Bytes the child wrote to `stdoutPath` (fd-handoff mode only), so the
   *  caller can cross-check the file it reads back against what git produced. */
  stdoutBytes?: number;
}

/** Static lifecycle markers only: no command, paths, environment or output. */
export type ExecProcessStage =
  | 'handoff-open' | 'admission-start' | 'admission-ready' | 'admission-failed'
  | 'spawn-start' | 'child-spawn' | 'child-close' | 'group-exit-confirmed'
  | 'settlement-start' | 'settlement-complete' | 'handoff-close' | 'exec-complete';

export interface ExecProcessDeps {
  /** Observer failures must never change process lifetime or receipt settlement. */
  onStage?: (stage: ExecProcessStage) => void;
  onAdmissionPhase?: (event: GovernedExecutionAdmissionPhaseEvent) => void;
  beginExecution?: (
    params: ExecParams,
    onAdmissionPhase?: (event: GovernedExecutionAdmissionPhaseEvent) => void,
  ) => Promise<GovernedExecution>;
  /** Control stays local to the sidecar; AbortSignal is never serialized. */
  signal?: AbortSignal;
  onPid?: (pid: number) => void;
  onOutputActivity?: () => void;
  /** Injectable grace for real-process cancellation tests. */
  killGraceMs?: number;
  /**
   * How long a read-only git exec (see `qualifiesForLazyReceipt`) may run before
   * it mints its durable admission receipt. `0` restores eager admit-before-spawn
   * for EVERY command. Default `SIDECAR_LAZY_RECEIPT_DELAY_MS`. Commands that do
   * not qualify are always admitted eagerly, whatever this says.
   */
  lazyReceiptMs?: number;
  /**
   * Observes every admission outcome (WI-6554700010008488). The spawner
   * sidecar server passes its wedge breaker here; omitted elsewhere.
   */
  admissionHealth?: AdmissionHealthObserver;
  /** Test seam: replaces the forkserver spawn (default spawnSidecarChild). */
  spawnChild?: (request: SidecarSpawnRequest) => Promise<SidecarChild>;
}

/**
 * WI-10004674 / WI-10003465 — a read-only git exec lives ~4 ms, but its durable
 * receipt costs four awaited PG statements (admit INSERT, lease UPDATE,
 * markRunning UPDATE, release UPDATE). Fleet-wide that is ~10 execs/s = ~40
 * statements/s through the sidecar's 2-connection pool on a WAL-saturated disk:
 * measured enqueue->complete p50 0.5-3.5 s per read against 5 ms for bare git,
 * and ~59% of native-PG WAL. The receipt is observe-only evidence here
 * (decision reason `observe-only-targeted-lease`), so a read that is already
 * finished by the time anyone could look at the ledger does not need one.
 *
 * A qualifying exec therefore spawns FIRST and mints its receipt only if it is
 * still running after this delay. Slow reads (a network `ls-remote`, a huge
 * `log`) keep full ledger visibility, merely `delay` late.
 */
export const SIDECAR_LAZY_RECEIPT_DELAY_MS = 750;

/**
 * The read-only git classification (which subcommands may defer their receipt)
 * lives in `sidecar-read-only-git.ts` so the CLIENT-side latency sampler shares
 * one definition without importing this module's resource-governor/PG chain.
 * Re-exported here so every existing importer keeps working.
 */
export { gitSubcommandOf, qualifiesForLazyReceipt } from './sidecar-read-only-git';

/** Lazy admission covers ordinary read-only Git and the strictly verified dev-deploy batch. */
export function qualifiesForLazyReceiptProcess(
  params: Pick<ExecParams, 'command' | 'args'>,
): boolean {
  return qualifiesForLazyGitExec(params) || isReadOnlyGitBatchExec(params);
}

/** What `execProcess` needs from the durable receipt, whether minted eagerly or late. */
interface ReceiptHandle {
  /** Env override handed to the child (its nested-lineage context). */
  readonly childEnv: Record<string, string>;
  /** Call right after spawn: starts the lazy mint timer (no-op when eager). */
  armAfterSpawn(): void;
  finish(demand: ResourceDemand, onSettled?: () => void): Promise<void>;
  cancel(reason: string): Promise<void>;
}

function eagerReceipt(execution: GovernedExecution): ReceiptHandle {
  return {
    childEnv: { PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(execution.context) },
    armAfterSpawn: () => {},
    // Eager settlement failures propagate: the caller reports them in stderr.
    finish: async (demand, onSettled) => {
      await execution.finish(demand);
      onSettled?.();
    },
    cancel: async (reason) => { await execution.cancel(reason); },
  };
}

function lazyReceipt(
  begin: (params: ExecParams) => Promise<GovernedExecution>,
  params: ExecParams,
  delayMs: number,
): ReceiptHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let minting: Promise<void> | null = null;
  let execution: GovernedExecution | null = null;
  let admissionStarted = false;
  let settlementScheduled = false;
  type PendingSettlement =
    | { kind: 'finish'; demand: ResourceDemand; onSettled?: () => void }
    | { kind: 'cancel'; reason: string };
  let pendingSettlement: PendingSettlement | null = null;
  const applyPendingSettlement = (): void => {
    if (!pendingSettlement || settlementScheduled) return;
    if (!execution) {
      if (minting) return;
      settlementScheduled = true;
      // No receipt exists (the read finished before admission or best-effort
      // admission failed), so terminal handling is complete without a write.
      if (pendingSettlement.kind === 'finish') {
        try { pendingSettlement.onSettled?.(); } catch { /* observers cannot own the read result */ }
      }
      return;
    }

    settlementScheduled = true;
    if (pendingSettlement.kind === 'finish') {
      settleGovernedExecutionInBackground(
        execution,
        { kind: 'release', actualDemand: pendingSettlement.demand },
        pendingSettlement.onSettled,
      );
    } else {
      settleGovernedExecutionInBackground(execution, { kind: 'cancel', reason: pendingSettlement.reason });
    }
  };
  const requestSettlement = (settlement: PendingSettlement): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // First terminal outcome wins. If admission is still minting, retain the
    // release/cancel decision and apply it when the durable receipt arrives.
    pendingSettlement ??= settlement;
    applyPendingSettlement();
    return Promise.resolve();
  };
  return {
    // The child inherits the caller-supplied parent lineage; there is no receipt of its own yet.
    childEnv: params.admissionContext
      ? { PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(params.admissionContext) }
      : {},
    armAfterSpawn: () => {
      timer = setTimeout(() => {
        timer = null;
        admissionStarted = true;
        minting = Promise.resolve().then(() => begin(params)).then(
          (e) => { execution = e; },
          () => undefined, // admission failure never disturbs the completed read
        ).finally(() => {
          minting = null;
          applyPendingSettlement();
        });
      }, delayMs);
      timer.unref?.();
    },
    finish: (demand, onSettled) => requestSettlement({ kind: 'finish', demand, onSettled }),
    cancel: (reason) => requestSettlement({ kind: 'cancel', reason }),
  };
}

/**
 * Receipt metadata. A git receipt also names its SUBCOMMAND and whether it was
 * eligible for the lazy path: the ledger carries no argv, so without these a
 * "which git execs still mint receipts after the lazy-receipt fix" question is
 * unanswerable — a read-only subcommand here is a read that outlived the delay,
 * a non-read-only one was always going to be eager (WI-10004674 done-when (b)).
 * Derived deterministically from `params`, so a retry under the same
 * idempotency key keeps the same request digest.
 */
export function sidecarReceiptMetadata(
  params: Pick<ExecParams, 'command' | 'args'>,
): Record<string, string | boolean> {
  const base = { processKind: 'sidecar-exec', command: params.command };
  if (params.command === 'git') {
    return {
      ...base,
      gitSubcommand: gitSubcommandOf(params.args ?? []) ?? 'unknown',
      readOnlyGit: qualifiesForLazyGitExec(params),
    };
  }
  if (isReadOnlyGitBatchExec(params)) {
    return { ...base, gitSubcommand: 'batch', readOnlyGit: true };
  }
  return base;
}

async function beginSidecarProcessExecution(
  params: ExecParams,
  onAdmissionPhase?: (event: GovernedExecutionAdmissionPhaseEvent) => void,
): Promise<GovernedExecution> {
  const workspaceId =
    params.workspaceId?.trim() ||
    params.env?.PAPERCUSP_WORKSPACE_ID?.trim() ||
    params.env?.PAPERCUSP_WORKSPACE?.trim() ||
    activeWorkspaceId();
  const parent =
    params.admissionContext ??
    admissionContextFromEnvironment(params.env?.PAPERCUSP_ADMISSION_CONTEXT) ??
    admissionContextFromEnvironment(process.env.PAPERCUSP_ADMISSION_CONTEXT);
  const idempotencyKey = params.idempotencyKey?.trim() || `sidecar-process:${process.pid}:${randomUUID()}`;
  return beginGovernedExecution(
    {
      idempotencyKey,
      admissionClass: 'process',
      demand: { cpuWeight: 1 },
      payloadRef: `process:${params.command}`,
      parent,
      metadata: sidecarReceiptMetadata(params),
    },
    {
      owner: params.ownerId?.trim() || params.env?.PAPERCUSP_SID?.trim() || `spawner-sidecar:${process.pid}`,
      onAdmissionPhase,
    },
    governedExecutionRuntime(workspaceId, 'agent-process'),
  );
}

export async function execProcess(params: ExecParams, deps: ExecProcessDeps = {}): Promise<ExecResult> {
  const reportStage = (stage: ExecProcessStage): void => {
    try { deps.onStage?.(stage); } catch { /* diagnostics cannot own execution */ }
  };
  const aborted = (): ExecResult => ({ code: -1, stdout: '', stderr: 'process aborted before spawn' });
  if (deps.signal?.aborted) return aborted();
  // Open the handoff files BEFORE spawning: a bad path must come back as a
  // normal non-zero result the caller can fall back from, never a thrown RPC
  // error (every caller's contract is degrade-to-local, not fail).
  let stdinHandle: fsp.FileHandle | undefined;
  let stdoutHandle: fsp.FileHandle | undefined;
  reportStage('handoff-open');
  try {
    if (params.stdinPath) stdinHandle = await fsp.open(params.stdinPath, 'r');
    if (params.stdoutPath) stdoutHandle = await fsp.open(params.stdoutPath, 'w');
  } catch (e) {
    await stdinHandle?.close().catch(() => {});
    await stdoutHandle?.close().catch(() => {});
    return { code: -1, stdout: '', stderr: `spawner sidecar could not open a handoff file: ${String(e)}` };
  }

  // WI-6554700010008488: every admission outcome (eager AND lazy) feeds the
  // owner's wedge breaker, so a pool that can no longer begin is detected.
  const beginExecution = deps.beginExecution ?? beginSidecarProcessExecution;
  const observedBegin = observeAdmission(
    (request: ExecParams) => beginExecution(request, deps.onAdmissionPhase),
    deps.admissionHealth,
  );
  const begin = async (request: ExecParams): Promise<GovernedExecution> => {
    reportStage('admission-start');
    try {
      const receipt = await observedBegin(request);
      reportStage('admission-ready');
      return receipt;
    } catch (error) {
      reportStage('admission-failed');
      throw error;
    }
  };
  const lazyDelayMs = qualifiesForLazyReceiptProcess(params) ? (deps.lazyReceiptMs ?? SIDECAR_LAZY_RECEIPT_DELAY_MS) : 0;
  let execution: ReceiptHandle;
  try {
    // Lazy: nothing to admit yet — the receipt is minted only if the read outlives the delay.
    execution = lazyDelayMs > 0 ? lazyReceipt(begin, params, lazyDelayMs) : eagerReceipt(await begin(params));
  } catch (e) {
    await stdinHandle?.close().catch(() => {});
    await stdoutHandle?.close().catch(() => {});
    // Name WHICH process failed: a wedged pool is per-process, and without the
    // pid the error cannot say which sidecar to inspect (WI-6554700010008488).
    // The prefix is matched (isSidecarInfrastructureFault, log greps): keep it first.
    return { code: -1, stdout: '', stderr: `spawner sidecar admission failed (sidecar pid ${process.pid}): ${String(e)}` };
  }

  // Admission may have waited while the caller cancelled. Do not create a
  // child after cancellation merely because the admission promise settled.
  if (deps.signal?.aborted) {
    try {
      await execution.cancel('sidecar process aborted before spawn');
    } catch (e) {
      return { ...aborted(), stderr: `sidecar process aborted before spawn; admission cancellation failed: ${String(e)}` };
    } finally {
      await stdinHandle?.close().catch(() => {});
      await stdoutHandle?.close().catch(() => {});
    }
    return aborted();
  }

  let result: ExecResult;
  try {
    reportStage('spawn-start');
    // The fork runs in the forkserver (forkserver/forkserver-client.ts), not on this
    // event loop: forking from this large process blocked the loop that also runs
    // governed-admission I/O (WI-6554700010019379). Everything below reads only the
    // child's pid, exit fields, stdio streams and events, so every guard is the same
    // for a forkserver child and a direct one.
    const child = await (deps.spawnChild ?? spawnSidecarChild)({
      command: params.command,
      args: params.args ?? [],
      cwd: params.cwd,
      env: {
        ...(params.inheritEnv === false ? {} : process.env),
        ...(params.env ?? {}),
        ...execution.childEnv,
      },
      // Own the command's helper processes too. Keep the child referenced;
      // detached here creates a POSIX process group, not a fire-and-forget job.
      detached: process.platform !== 'win32',
      signal: deps.signal,
      spawnTimeoutMs: params.timeoutMs,
      ...(params.fence && Object.hasOwn(params.fence, 'forkserverIdentity')
        ? { forkserverIdentity: params.fence.forkserverIdentity } : {}),
      ...(stdinHandle && params.stdinPath ? { stdin: { path: params.stdinPath, fd: stdinHandle.fd } } : {}),
      ...(stdoutHandle && params.stdoutPath ? { stdout: { path: params.stdoutPath, fd: stdoutHandle.fd } } : {}),
    });
    result = await new Promise<ExecResult>((resolve) => {
      // A lazy receipt's delay measures the child's runtime, not the setup before it.
      execution.armAfterSpawn();
      // Decode across chunk boundaries: a multi-byte UTF-8 character split between
      // two `data` events decodes to replacement chars under a plain
      // `String(chunk)`, silently corrupting output (e.g. a non-ASCII author or
      // subject in `git log`). StringDecoder holds the partial sequence back.
      const outDecoder = new StringDecoder('utf8');
      const errDecoder = new StringDecoder('utf8');
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let maxBufferExceeded: 'stdout' | 'stderr' | undefined;
      let settled = false;
      let commandExited = false;
      let terminating = false;
      let spawnFailed = false;
      let processError: ExecResult['error'];
      let hardTimer: ReturnType<typeof setTimeout> | null = null;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let idleCheck: ReturnType<typeof setImmediate> | null = null;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let idleGeneration = 0;
      let exitGraceUsed = false;
      let observedStdoutBytes = 0;
      const childOutputFinished = (): boolean => {
        if (child.exitCode !== null || child.signalCode !== null) return true;
        const pipes = [child.stdout, child.stderr].filter((s): s is NonNullable<typeof s> => s != null);
        return pipes.length > 0 && pipes.every((s) => s.readableEnded);
      };
      let removeAbortListener = (): void => {};
      const groupLifetime = processGroupLifetime(child as unknown as ChildProcess, (message) => { stderr += `\nsidecar ${message}`; });
      const signalCommand = groupLifetime.signal;
      const waitForCommandExit = async (): Promise<void> => {
        await groupLifetime.waitForExit();
        commandExited = true;
      };
      const clearTimers = (): void => {
        idleGeneration += 1;
        if (hardTimer) clearTimeout(hardTimer);
        if (idleTimer) clearTimeout(idleTimer);
        if (idleCheck) clearImmediate(idleCheck);
        idleCheck = null;
      };
      const stopGuards = (): void => {
        clearTimers();
        if (killTimer) clearTimeout(killTimer);
        removeAbortListener();
      };
      const reportOutput = (): void => {
        try { deps.onOutputActivity?.(); } catch { /* observer failure cannot own child lifetime */ }
      };
      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        stopGuards();
        resolve({
          code: terminating ? -1 : code,
          stdout: stdout + outDecoder.end(),
          stderr: stderr + errDecoder.end(),
          ...((terminating || code < 0) ? { error: processError ?? {
            code: null, signal: child.signalCode, killed: terminating,
          } } : {}),
          ...(maxBufferExceeded ? { maxBufferExceeded } : {}),
        });
      };
      const timeoutMs = params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : 0;
      const idleTimeoutMs = params.idleTimeoutMs && params.idleTimeoutMs > 0 ? params.idleTimeoutMs : 0;
      const terminate = (reason: string, includeDiagnostic = true, errorCode = 'ETIMEDOUT'): void => {
        if (settled || commandExited || terminating) return;
        terminating = true;
        processError = { code: errorCode, signal: null, killed: true };
        clearTimers();
        if (includeDiagnostic) {
          stderr += `${stderr ? '\n' : ''}${params.command} ${(params.args ?? []).join(' ')} ${reason} — killed by the spawner sidecar guard`;
        }
        signalCommand('SIGTERM');
        killTimer = setTimeout(() => signalCommand('SIGKILL'), deps.killGraceMs ?? SIDECAR_PROCESS_KILL_GRACE_MS);
        killTimer.unref?.();
        // A kill signal is not an exit receipt. Only close (or a spawn error)
        // may settle this call and let the caller release repository locks.
      };
      const appendOutput = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
        const previousBytes = stream === 'stdout' ? stdoutBytes : stderrBytes;
        const limit = params.maxBuffer;
        const acceptedBytes = limit === undefined
          ? chunk.length
          : Math.max(0, Math.min(chunk.length, limit - previousBytes));
        const accepted = acceptedBytes === chunk.length ? chunk : chunk.subarray(0, acceptedBytes);
        if (stream === 'stdout') {
          stdoutBytes += chunk.length;
          stdout += outDecoder.write(accepted);
        } else {
          stderrBytes += chunk.length;
          stderr += errDecoder.write(accepted);
        }
        if (limit !== undefined && previousBytes + chunk.length > limit && !maxBufferExceeded) {
          maxBufferExceeded = stream;
          // Keep child stderr as the rejected execFile-style stderr. The local
          // adapter builds the maxBuffer error message from the typed marker.
          terminate(stream + ' maxBuffer length exceeded', false, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
        }
      };
      const armIdleTimer = (): void => {
        if (idleTimeoutMs <= 0 || settled || terminating) return;
        const generation = ++idleGeneration;
        if (idleTimer) clearTimeout(idleTimer);
        if (idleCheck) clearImmediate(idleCheck);
        idleCheck = null;
        idleTimer = setTimeout(() => {
          idleTimer = null;
          // A stalled parent can resume in TIMERS with child output already
          // waiting in an OS pipe. Let POLL deliver those bytes before deciding
          // the child was idle. A data event cancels this candidate and re-arms
          // the idle timer; the independent hard ceiling is never deferred.
          idleCheck = setImmediate(async () => {
            idleCheck = null;
            const current = (): boolean =>
              generation === idleGeneration && !settled && !commandExited && !terminating;
            if (!current()) return;
            if (stdoutHandle) {
              // A handed-off fd has no pipe events. Inspect its own inode,
              // not the path (which could have been replaced), only when the
              // existing idle deadline needs a verdict. A changed size is
              // observed output progress; an unchanged next sample can expire.
              // This is conservative by one sample interval after the final
              // write, while the independent absolute deadline stays exact.
              let bytes: number;
              try {
                bytes = (await stdoutHandle.stat()).size;
              } catch (error) {
                if (current()) terminate(`could not verify stdout-file progress: ${String(error)}`, true, 'SIDECAR_OUTPUT_UNVERIFIED');
                return;
              }
              // Pipe progress, cancellation or close may have won while fstat
              // was pending. That newer state invalidates this idle candidate.
              if (!current()) return;
              if (bytes !== observedStdoutBytes) {
                observedStdoutBytes = bytes;
                reportOutput();
                armIdleTimer();
                return;
              }
            }
            // A stalled parent can also resume with the child's EOF/exit already
            // observed in POLL while 'close' — and so the exit fence that sets
            // commandExited — only lands after this CHECK phase. A child that has
            // finished its output is not idle: grant ONE more idle window for the
            // fence. A child that closed its pipes yet stays alive past it is
            // still killed, and the absolute deadline is never deferred.
            if (!exitGraceUsed && childOutputFinished()) {
              exitGraceUsed = true;
              armIdleTimer();
              return;
            }
            terminate(`made no output progress for ${idleTimeoutMs}ms`);
          });
          // A file-only child has no pipe traffic to wake POLL. Keep this
          // one-shot check referenced so it runs even when the next event
          // would otherwise be child close or the absolute deadline.
        }, idleTimeoutMs);
        idleTimer.unref?.();
      };
      if (timeoutMs > 0) {
        hardTimer = setTimeout(() => terminate(`timed out after ${timeoutMs}ms`), timeoutMs);
        hardTimer.unref?.();
      }
      armIdleTimer();
      const onAbort = (): void => terminate('aborted by caller', true, 'ABORT_ERR');
      if (deps.signal) {
        removeAbortListener = () => deps.signal?.removeEventListener('abort', onAbort);
        deps.signal.addEventListener('abort', onAbort, { once: true });
        if (deps.signal.aborted) onAbort();
      }
      child.once('spawn', () => {
        try { if (child.pid) deps.onPid?.(child.pid); } catch { /* observer only */ }
        reportStage('child-spawn');
      });
      // In fd-handoff mode `child.stdout` is null — git writes to the file itself.
      child.stdout?.on('data', (d: Buffer) => {
        appendOutput('stdout', d);
        reportOutput();
        armIdleTimer();
      });
      child.stderr?.on('data', (d: Buffer) => {
        appendOutput('stderr', d);
        reportOutput();
        armIdleTimer();
      });
      child.on('error', async (e) => {
        spawnFailed = true;
        processError = { code: (e as NodeJS.ErrnoException).code ?? null, signal: null, killed: false };
        stderr += String(e);
        try {
          await execution.cancel(`sidecar process spawn error: ${String(e)}`);
        } catch (settlementError) {
          stderr += `; admission cancellation failed: ${String(settlementError)}`;
        } finally {
          finish(-1);
        }
      });
      child.on('close', async (code, signal) => {
        reportStage('child-close');
        if (processError) processError.signal = signal;
        if (signal && !maxBufferExceeded) stderr += `${stderr ? '\n' : ''}${params.command} terminated by signal ${signal}`;
        try {
          await waitForCommandExit();
          reportStage('group-exit-confirmed');
          // Admission settlement can itself wait on IO. Remove kill timers
          // after command exit, before awaiting admission settlement.
          stopGuards();
          if (!spawnFailed) {
            reportStage('settlement-start');
            await execution.finish({ cpuWeight: 1 }, () => reportStage('settlement-complete'));
          }
          finish(code ?? -1);
        } catch (settlementError) {
          processError = { code: 'SIDECAR_SETTLEMENT_FAILED', signal, killed: terminating };
          stderr += `${stderr ? '\n' : ''}sidecar process admission settlement failed: ${String(settlementError)}`;
          finish(-1);
        }
      });
    });
  } catch (e) {
    let settlementError = '';
    try {
      await execution.cancel(`sidecar process spawn threw: ${String(e)}`);
    } catch (cancelError) {
      settlementError = `; admission cancellation failed: ${String(cancelError)}`;
    }
    const uncertain = (e as NodeJS.ErrnoException)?.code === FORKSERVER_LOST_CODE;
    const controlled = ['ABORT_ERR', 'ETIMEDOUT'].includes((e as NodeJS.ErrnoException)?.code ?? '');
    result = { code: -1, stdout: '',
      // The generic spawn prefix permits local fallback. An acknowledged-or-
      // unknown execution is terminal, including a lost pre-PID reply.
      stderr: `${uncertain ? 'forkserver execution failed; outcome unknown; not re-run' : controlled ? 'process spawn cancelled before dispatch' : 'spawner sidecar could not spawn process'}: ${String(e)}${settlementError}`,
      ...((uncertain || controlled) ? { error: { code: (e as NodeJS.ErrnoException).code!, signal: null, killed: uncertain } } : {}),
    };
  }

  reportStage('handoff-close');
  // Size the output BEFORE closing, so the caller can detect a short read.
  let stdoutBytes: number | undefined;
  if (stdoutHandle) {
    try {
      stdoutBytes = (await stdoutHandle.stat()).size;
    } catch {
      /* An fstat failure just means no cross-check is offered. */
    }
  }
  await stdinHandle?.close().catch(() => {});
  await stdoutHandle?.close().catch(() => {});
  reportStage('exec-complete');
  return stdoutBytes === undefined ? result : { ...result, stdoutBytes };
}
