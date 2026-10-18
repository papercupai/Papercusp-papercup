/**
 * task-manager/managed-spawn — the chokepoint every long-lived process is born
 * through (task-manager-no-escape-2026-07-27, P-007).
 *
 * Three things happen here, in this order, and the order is the design:
 *
 *   1. REGISTER the row as `pending` — BEFORE the fork. A crash in the window
 *      between register and spawn then leaves a visible pending row that the
 *      reconciler strands, instead of a process nobody recorded. Spawn-then-record
 *      loses the process entirely if the operator dies in the window.
 *   2. CONFINE into `pc-<taskId>.scope` under `papercusp-<class>.slice`. The scope
 *      NAME carries the ledger key, so reconciliation is a join; the slice makes
 *      every descendant enumerable no matter how it forked.
 *   3. STAMP the kernel identity (`linux:<bootId>:<startTicks>`) and flip to
 *      `running`, so nothing downstream ever has to trust a bare pid.
 *
 * FAILS SOFT, ALWAYS. If systemd cannot give us a scope — no bus, no binary, a
 * container, macOS — the process still spawns and is still ledgered, just with
 * `confined: false`. Degrading to "unconfined but accounted" is right; refusing to
 * spawn because the task manager is unavailable would make an observability
 * feature into an outage.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { readProcessIdentity } from '../process-identity';
import { redactSensitiveText } from '../sensitive-text';
import {
  buildTaskScopeArgvWithTransport,
  SCOPE_LAUNCH_FAILURE_RE,
  probeTransientScopeSupport,
  taskDeadlineEnv,
} from '../systemd-scope';
import {
  absCgroupDir,
  nodeCgroupFs,
  readCgroupProcs,
  readProcessCgroupPath,
  sampleCgroup,
  type CgroupFs,
} from './cgroup-read';
import { isTaskManagerEnabled } from './enabled';
import { onTaskKillRequested } from './kill-notify';
import { inspectTaskUnitTerminals, resetFailedTaskUnit } from './scope-terminal-state';
import { closeTask, markSpawned, registerTask } from './store';
import {
  deriveUserManagerRoot,
  isValidTaskId,
  newTaskId,
  scopeCgroupRelPath,
  scopeUnitForTask,
  sliceForClass,
  type TaskRow,
  type TaskSpec,
} from './types';

export interface ManagedSpawnOptions {
  /** Metered executions require enrollment before any process can send. */
  requireRegistration?: boolean;
  /** Optional tracer; observes spawn and awaited completion phases without secrets. */
  stage?: (name: string) => void;
  /** Observe the child synchronously before post-fork ledger writes can outlive it. */
  onSpawn?: (child: ChildProcess, taskId: string) => void;
  /** Anything `child_process.spawn` takes. `detached` is honoured — a detached
   *  child still cannot leave its cgroup, which is the point. */
  spawnOptions?: SpawnOptions;
  /** Force confinement off (tests, or a caller that knows it is unsupported). */
  confine?: boolean;
  workspaceId?: string;
  /**
   * Caller-minted durable identity. A release coordinator that must persist its
   * task id before the child starts uses this seam to bind the task ledger,
   * cgroup name, and child environment to one identity. Omit for the ordinary
   * managedSpawn-owned identity.
   */
  taskId?: string;
  /** Injected for tests. */
  spawnFn?: typeof spawn;
  fs?: CgroupFs;
  /** Injected for tests — overrides the cached systemd probe. */
  scopeAvailable?: boolean;
}

export type ManagedSpawnCompletion =
  | { status: 'recorded' }
  | { status: 'delegated'; reason: string }
  | { status: 'unavailable'; reason: string };

export interface ManagedSpawnResult {
  taskId: string;
  row: TaskRow;
  child: ChildProcess;
  scopeUnit: string | null;
  confined: boolean;
  /** Await this before exiting a short-lived caller. Child exit alone does not
   * await ledger persistence; a live scope is explicitly delegated to reconciliation. */
  waitForCompletion: () => Promise<ManagedSpawnCompletion>;
  /** Set when confinement was requested but unavailable — surfaced so a caller
   *  (and the pane) can say WHY a task is unconfined rather than guessing. */
  confinementSkippedReason?: string;
}

/**
 * Child handles whose owning task is being torn down deliberately. The handle
 * is the systemd-run client, so it can emit a signal while the payload scope is
 * still draining; that is an expected handoff during release, not an orphan.
 */
type ManagedSpawnHandle = Pick<ChildProcess, 'kill'>;
const intentionalTeardownChildren = new WeakSet<ManagedSpawnHandle>();
/** Explicit taskId kill signal, captured before systemd-run's client can exit. */
const requestedKillSignals = new WeakMap<ManagedSpawnHandle, NodeJS.Signals>();

/**
 * Mark a managed-spawn client before its owning task scope is intentionally
 * killed. The returned cleanup is used when scope control is refused so a
 * later, unrelated client exit remains observable as an abnormal handoff.
 */
export function markManagedSpawnTeardown(child: ManagedSpawnHandle): () => void {
  intentionalTeardownChildren.add(child);
  return () => {
    intentionalTeardownChildren.delete(child);
  };
}

/**
 * systemd-run can report its client gone before the payload has joined the
 * transient scope. Keep the row live for a short, bounded handoff window so a
 * one-shot empty cgroup read cannot turn a resident payload into `unaccounted`.
 * The timer is unref'd below, so this safety window never keeps the operator
 * alive during shutdown.
 */
export const SCOPE_HANDOFF_GRACE_MS = 250;
export const SCOPE_HANDOFF_RECHECK_MS = 25;

/** A missing ledger write must not gate the child, but it also must not become permanent. */
const LEDGER_REGISTRATION_RETRY_BASE_MS = 1_000;
const LEDGER_REGISTRATION_RETRY_MAX_MS = 30_000;
const MAX_LEDGER_REGISTRATION_FAILURES = 8;

type SpawnStdioArray = Exclude<SpawnOptions['stdio'], string | undefined>;

function normalizeSpawnStdio(stdio: SpawnOptions['stdio']): SpawnStdioArray {
  const normalized =
    stdio === undefined || stdio === 'pipe'
      ? ['pipe', 'pipe', 'pipe']
      : typeof stdio === 'string'
        ? [stdio, stdio, stdio]
        : [...stdio];
  while (normalized.length < 3) normalized.push('pipe');
  return normalized as SpawnStdioArray;
}

function errorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function rememberLedgerRegistrationFailure(failures: string[], error: unknown): string {
  const message = errorMessage(error);
  failures.push(message);
  if (failures.length > MAX_LEDGER_REGISTRATION_FAILURES) {
    failures.splice(1, failures.length - MAX_LEDGER_REGISTRATION_FAILURES);
  }
  return message;
}

// ── systemd availability probe ──────────────────────────────────────────────

let scopeProbe: Promise<{ ok: boolean; reason?: string }> | null = null;

/**
 * Probe ONCE per operator process whether transient user scopes can be created.
 *
 * A probe beats the alternative — launch into a scope, watch for a launch-failure
 * signature on stderr, then relaunch direct — because that alternative
 * double-spawns on every call on a host where it will never work, and because
 * "did the payload fail or did the SCOPE fail" is genuinely ambiguous to parse
 * (the existing seams carry a regex for exactly that ambiguity). One deterministic
 * probe answers it before any real work is at stake.
 */
export function probeScopeSupport(spawnFn: typeof spawn = spawn): Promise<{ ok: boolean; reason?: string }> {
  return scopeProbe ??= probeTransientScopeSupport({ spawnFn });
}

/** Test seam — forget the cached probe. */
export function resetScopeProbe(): void {
  scopeProbe = null;
  scopeProbeResult = null;
}

let scopeProbeResult: { ok: boolean; reason?: string } | null = null;

/**
 * Kick the probe off without waiting for it, and remember the answer for
 * SYNCHRONOUS callers.
 *
 * Some spawn seams cannot become async without changing a signature every caller
 * and test depends on (`capability:bash`'s `startBackground` is the case that
 * forced this). Those seams need the confinement decision at call time, with no
 * await available. So: warm the probe at module load, answer synchronously
 * afterwards, and have the first job before it resolves run UNCONFINED but still
 * ledgered.
 *
 * That is the correct bias. Confinement is an observability and safety
 * enhancement; the job itself is the user's actual work. A task manager that is
 * still warming up must never be the reason a command does not run.
 */
export function warmScopeProbe(spawnFn: typeof spawn = spawn): void {
  // WI-6499: resolve the flag FIRST. Three spawn modules call this at module
  // import, so an unconditional probe means every operator boot fires a
  // `systemd-run` for a subsystem the owner has switched off. Resolving the flag
  // here also warms the sync cache that `beginSyncEnrolment` reads, so one call
  // arms both decisions.
  void isTaskManagerEnabled('task-manager:probe')
    .then(async (on) => {
      if (!on) {
        scopeProbeResult = { ok: false, reason: 'task manager disabled (papercusp-task-manager)' };
        return;
      }
      scopeProbeResult = await probeScopeSupport(spawnFn);
    })
    .catch(() => {
      scopeProbeResult = { ok: false, reason: 'probe threw' };
    });
}

/** The probe's answer if it has landed, else null ("not known yet — do not confine"). */
export function scopeSupportKnown(): { ok: boolean; reason?: string } | null {
  return scopeProbeResult;
}

// ── the chokepoint ──────────────────────────────────────────────────────────

/**
 * Spawn `command` with `args` as a ledgered, (where possible) cgroup-confined task.
 *
 * The returned `child` is a normal ChildProcess with normal stdio — confinement
 * uses `--scope`, not `--unit`, precisely so callers keep piped stdio and
 * process-group semantics and nothing downstream has to change.
 */
export async function managedSpawn(
  command: string,
  args: readonly string[],
  spec: TaskSpec,
  opts: ManagedSpawnOptions = {},
): Promise<ManagedSpawnResult> {
  const spawnFn = opts.spawnFn ?? spawn;
  const fs = opts.fs ?? nodeCgroupFs;
  const taskId = opts.taskId ?? newTaskId();
  if (!isValidTaskId(taskId)) {
    throw new Error(
      `task-manager: invalid caller taskId ${JSON.stringify(taskId)} — must match /^[0-9a-z]{4,64}$/`,
    );
  }

  // WI-6499 — the master switch. OFF ⇒ a plain spawn: no scope, no ledger row,
  // no ledger exit wiring. Byte-identical to what this seam's callers did before the
  // task manager existed, which is what makes the flag an honest kill-switch
  // rather than a dashboard blanker.
  opts.stage?.('spawn-read-flag');
  if (!(await isTaskManagerEnabled('task-manager:spawn'))) {
    if (opts.requireRegistration) throw new Error('Required task enrollment is disabled; no process started.');
    opts.stage?.('spawn-fork');
    const child = spawnFn(command, args as string[], opts.spawnOptions ?? {});
    const completion = new Promise<ManagedSpawnCompletion>((resolve) => {
      const finish = () => resolve({ status: 'unavailable', reason: 'task manager disabled' });
      child.once('exit', finish);
      child.once('error', finish);
    });
    opts.onSpawn?.(child, taskId);
    return {
      taskId,
      row: unledgeredRow(taskId, { ...spec, argv: [command, ...args] }, opts.workspaceId, child.pid ?? null),
      child,
      scopeUnit: null,
      confined: false,
      waitForCompletion: () => completion,
      confinementSkippedReason: 'task manager disabled (papercusp-task-manager)',
    };
  }

  const wantConfine = opts.confine !== false;

  let scopeOk = false;
  let skippedReason: string | undefined;
  if (wantConfine) {
    if (opts.scopeAvailable !== undefined) {
      scopeOk = opts.scopeAvailable;
      if (!scopeOk) skippedReason = 'confinement disabled by caller';
    } else {
      opts.stage?.('spawn-scope-probe');
      const probe = await probeScopeSupport(spawnFn);
      scopeOk = probe.ok;
      skippedReason = probe.reason;
    }
  } else {
    skippedReason = 'confine: false';
  }

  const argvSpec: TaskSpec = { ...spec, argv: [command, ...args] };

  // FAILS SOFT, ALWAYS (see the header) — and that has to cover the LEDGER leg,
  // not just the systemd one. `registerTask` is an unguarded INSERT, so before
  // this a PG blip threw straight out of the chokepoint and REFUSED THE SPAWN:
  // exactly the "observability feature into an outage" the contract disclaims.
  // It matters most for the callers that can least afford it — the spawner
  // sidecar (EI-19479764372783341) is the fleet's agent-spawn path, and it must
  // not be gated on a database write.
  //
  // Degrade the same way the scope leg does: spawn anyway, unledgered, and SAY
  // SO via `confinementSkippedReason` rather than pretending it was accounted.
  let row: TaskRow;
  let ledgered = true;
  let registrationAttempts = 1;
  const registrationFailures: string[] = [];
  const registerOptions = {
    taskId,
    workspaceId: opts.workspaceId,
    reserveScope: scopeOk,
  };
  try {
    opts.stage?.('spawn-register-task');
    row = await registerTask(argvSpec, registerOptions, undefined, opts.stage ? { stage: opts.stage } : undefined);
  } catch (e) {
    if (opts.requireRegistration) throw new Error(`Required task enrollment failed; no process started: ${errorMessage(e)}`);
    ledgered = false;
    const why = `ledger register failed: ${rememberLedgerRegistrationFailure(registrationFailures, e)}`;
    skippedReason = skippedReason ? `${skippedReason}; ${why}` : why;
    console.warn(`[managed-spawn] ${why} — spawning UNLEDGERED (task ${taskId})`);
    row = unledgeredRow(taskId, argvSpec, opts.workspaceId, null, why);
  }

  const scopeUnit = scopeOk ? scopeUnitForTask(taskId) : null;

  // WI-40906 — a caller-supplied env belongs to the PAYLOAD, never to the
  // `systemd-run` client. The client reaches the user manager over
  // `$DBUS_SESSION_BUS_ADDRESS`; handed an env that points it elsewhere, the launch
  // fails before the payload execs and the caller gets a handle to a process that
  // never ran. (Merely UNSETTING it is safe — systemd falls back to
  // $XDG_RUNTIME_DIR/bus — so the hazard is a redirect, not a thin env; measured
  // both ways in `buildExactEnvPayload`'s comment.)
  //
  // So the two environments are split here: the client keeps ours, and the
  // payload gets the caller's exactly, via a memory-only fd transport. Unconfined spawns are
  // untouched — there is no client to protect, and node applies `env` itself.
  const payloadEnv = opts.spawnOptions?.env;
  const environmentStdio =
    scopeOk && payloadEnv !== undefined ? normalizeSpawnStdio(opts.spawnOptions?.stdio) : null;
  const environmentFdIndex = environmentStdio ? Math.max(3, environmentStdio.length) : undefined;
  opts.stage?.('spawn-environment-transport');
  const builtLaunch = scopeOk
    ? buildTaskScopeArgvWithTransport([command, ...args], {
        unit: scopeUnit!,
        slice: sliceForClass(spec.class),
        env: payloadEnv,
        environmentFdIndex,
        memoryMaxBytes: spec.memoryMaxBytes,
        // WI-41206: carry the caller's swap policy through. Omitted => 'allow' (page, don't
        // OOM-kill) — see ScopeSwapPolicy in systemd-scope.ts.
        swap: spec.swap ?? undefined,
        cpuWeight: spec.cpuWeight,
        tasksMax: spec.tasksMax,
        runtimeMaxSec: spec.runtimeMaxSec,
        collectFailedUnit: false,
      })
    : null;
  const launchArgv = builtLaunch?.argv ?? [command, ...args];
  const environmentTransport = builtLaunch?.transport ?? null;

  // Everything else the caller asked for (stdio, cwd, detached) still applies to
  // the client, and a `--scope` payload inherits all three from it.
  let launchSpawnOptions: SpawnOptions = opts.spawnOptions ?? {};
  if (scopeOk && payloadEnv !== undefined) {
    const { env: _payloadEnvMovedIntoArgv, ...rest } = launchSpawnOptions;
    const inheritedFd = builtLaunch?.inheritFd;
    if (environmentStdio && inheritedFd) {
      environmentStdio[inheritedFd.index] = inheritedFd.fd;
    }
    launchSpawnOptions = {
      ...rest,
      ...(environmentStdio ? { stdio: environmentStdio } : {}),
    };
  } else if (scopeOk && spec.runtimeMaxSec && spec.runtimeMaxSec > 0) {
    // WI-1639265: with no payload env there is no exact-env transport to fold the deadline
    // into, and a `--scope` payload is forked from THIS client — so the client's env is the
    // only seam that reaches it. Spelling out `process.env` changes nothing about what the
    // payload sees (node's default for an omitted `env` is exactly that); it just makes the
    // one added variable expressible. `RuntimeMaxSec` alone is enforced by systemd and
    // invisible to the payload, which is how a bounded run gets SIGKILLed with no verdict.
    launchSpawnOptions = {
      ...launchSpawnOptions,
      env: { ...process.env, ...taskDeadlineEnv(spec.runtimeMaxSec) },
    };
  }

  let child: ChildProcess;
  try {
    opts.stage?.('spawn-fork');
    child = spawnFn(launchArgv[0]!, launchArgv.slice(1), launchSpawnOptions);
  } catch (e) {
    environmentTransport?.release();
    // The row already exists; close it honestly rather than leaving a pending
    // row the reconciler will later strand with a vaguer reason. A failure to
    // close must not MASK the spawn error the caller actually needs to see.
    if (ledgered) {
      try {
        await closeTask(taskId, {
          state: 'exited',
          exitCode: null,
          exitReason: `spawn threw: ${(e as Error).message}`,
        });
      } catch (closeErr) {
        console.warn(`[managed-spawn] closeTask after a failed spawn also failed: ${(closeErr as Error).message}`);
      }
    }
    throw e;
  }

  // The runner reads the anonymous fd during its own startup. Keep it alive for
  // the asynchronous systemd admission handoff, then release it as soon as the
  // client exits (the transport also has a bounded timer as a last resort for a
  // long-lived scope or an abnormal client handoff).
  if (environmentTransport) {
    const releaseEnvironmentTransport = (): void => environmentTransport.release();
    if (builtLaunch?.inheritFd) {
      // libuv duplicated the descriptor into the systemd-run client before spawn returned.
      // The scope runner owns its inherited copy now, so the operator can release its copy
      // immediately even when it exits before systemd admits the scope.
      releaseEnvironmentTransport();
    } else {
      child.once('exit', releaseEnvironmentTransport);
      child.once('error', releaseEnvironmentTransport);
    }
  }

  const pid = child.pid ?? null;
  // WI-37509: for a CONFINED task the scope's cgroup is DERIVED, never read off the
  // child pid. `systemd-run --scope` forks the payload, so `child` is the client and
  // reading its `/proc/<pid>/cgroup` this early returns the SPAWNER's cgroup — which
  // is how a sidecar came to be recorded as living inside `papercup-dev-api.service`,
  // and another inside a GNOME Terminal window scope. Unconfined tasks keep the /proc
  // read, where it is correct: the child really does live in our cgroup.
  const scopeCgroupPath =
    scopeOk && scopeUnit
      ? scopeCgroupRelPath(deriveUserManagerRoot(readProcessCgroupPath(process.pid, fs)), spec.class, scopeUnit)
      : null;

  // The child is ALREADY RUNNING by here, so a throw out of `markSpawned` would
  // be the worst of both worlds: the caller sees a failed spawn and abandons a
  // live process nobody is holding. Record what we can, degrade to unaccounted.
  opts.stage?.('spawn-process-identity');
  const spawnedFacts = {
    pid,
    processIdentity: pid ? readProcessIdentity(pid) : null,
    scopeUnit,
    cgroupPath: scopeCgroupPath ?? (pid ? readProcessCgroupPath(pid, fs) : null),
    confined: scopeOk,
  };
  const markSpawnedRow = async (): Promise<void> => {
    try {
      await markSpawned(taskId, spawnedFacts);
    } catch (e) {
      console.warn(
        `[managed-spawn] ledger markSpawned failed for task ${taskId} (pid ${pid ?? '?'}): ${errorMessage(e)} — ` +
          'the process IS running; its row stays `pending` for the reconciler.',
      );
    }
  };

  // Recover a failed pre-spawn registration independently from the caller's
  // launch path. The retry keeps the original id/scope so registerTask can adopt
  // the reconciler's exact unaccounted placeholder. If the child exits first,
  // retain its terminal write until registration succeeds, then mark + close it.
  const pendingCloseWrites: Array<() => Promise<void>> = [];
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryIndex = 0;
  let recoveryInFlight: Promise<boolean> | null = null;

  const scheduleRegistrationRetry = (): void => {
    if (ledgered || retryTimer) return;
    const exponent = Math.min(retryIndex, 10);
    const delayMs = Math.min(LEDGER_REGISTRATION_RETRY_BASE_MS * 2 ** exponent, LEDGER_REGISTRATION_RETRY_MAX_MS);
    retryIndex += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void attemptRegistrationRecovery();
    }, delayMs);
    retryTimer.unref?.();
  };

  const attemptRegistrationRecovery = async (): Promise<boolean> => {
    if (ledgered) return true;
    if (recoveryInFlight) return recoveryInFlight;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }

    recoveryInFlight = (async () => {
      registrationAttempts += 1;
      const recoverySpec: TaskSpec = {
        ...argvSpec,
        detail: {
          ...(argvSpec.detail ?? {}),
          managedSpawnRegistrationRecovery: {
            firstFailure: registrationFailures[0] ?? 'unknown registration failure',
            failures: [...registrationFailures],
            attempts: registrationAttempts,
            recoveredAt: new Date().toISOString(),
          },
        },
      };

      try {
        row = await registerTask(recoverySpec, registerOptions);
      } catch (e) {
        const message = rememberLedgerRegistrationFailure(registrationFailures, e);
        if (pendingCloseWrites.length > 0) {
          console.warn(
            `[managed-spawn] final ledger registration retry failed for task ${taskId}: ${message} — ` +
              'the terminal write remains queued for the next retry.',
          );
        }
        scheduleRegistrationRetry();
        return false;
      }

      await markSpawnedRow();
      ledgered = true;
      console.info(`[managed-spawn] ledger registration recovered for task ${taskId} after ${registrationAttempts} attempt(s)`);
      for (const write of pendingCloseWrites.splice(0)) {
        try {
          await write();
        } catch (e) {
          console.warn(`[managed-spawn] queued closeTask after ledger recovery failed for task ${taskId}: ${errorMessage(e)}`);
        }
      }
      return true;
    })();

    try {
      return await recoveryInFlight;
    } finally {
      recoveryInFlight = null;
    }
  };

  const persistCloseWhenRegistered = async (write: () => Promise<void>): Promise<boolean> => {
    if (ledgered) {
      await write();
      return true;
    }
    pendingCloseWrites.push(write);
    return attemptRegistrationRecovery();
  };

  // A short child can finish while markSpawned waits on PG. Both ledger and
  // caller observers must be installed before that await; events are not replayed.
  const waitForCompletion = wireExit(child, taskId, scopeOk, scopeUnit, scopeCgroupPath, fs, persistCloseWhenRegistered, opts.stage);
  opts.onSpawn?.(child, taskId);

  if (ledgered) {
    opts.stage?.('spawn-mark-running');
    await markSpawnedRow();
  }
  else scheduleRegistrationRetry();

  return {
    taskId,
    row,
    child,
    scopeUnit,
    confined: scopeOk,
    waitForCompletion,
    confinementSkippedReason: scopeOk ? undefined : skippedReason,
  };
}

/**
 * The row a caller gets back when the task manager is OFF.
 *
 * Never persisted and never reconciled — it exists only so the return shape does
 * not change under the flag, sparing every caller a null check for a subsystem
 * that is off. `state: 'running'` is the honest reading: the process really is
 * running, we simply are not keeping a ledger of it.
 */
function unledgeredRow(
  taskId: string,
  spec: TaskSpec,
  workspaceId: string | undefined,
  pid: number | null,
  reason = 'papercusp-task-manager off',
): TaskRow {
  const now = new Date().toISOString();
  return {
    ...spec,
    taskId,
    workspaceId: workspaceId ?? 'default',
    rootTaskId: spec.parentTaskId ?? taskId,
    scopeUnit: null,
    cgroupPath: null,
    pid,
    processIdentity: null,
    confined: false,
    state: 'running',
    startedAt: now,
    lastSeenAt: now,
    detail: { unledgered: true, reason },
  };
}

/**
 * Close the row on exit — and distinguish the ways a process can end, because a
 * pane that reports every ending as "exited" is a pane that cannot tell you your
 * build was OOM-killed.
 *
 * ── WHY THE CHILD'S EXIT IS EVIDENCE, NOT A VERDICT (WI-37509) ───────────────
 *
 * For a CONFINED task, `child` is the `systemd-run --scope` CLIENT, not the payload.
 * systemd-run forks the real work into the new scope; normally the client then lives
 * exactly as long as its payload, which is why watching it worked for so long. But
 * the two can be separated — a signal delivered to the client, its spawner's own
 * cgroup being torn down — and then the client's death says nothing whatsoever about
 * the payload.
 *
 * Filed that way the row goes TERMINAL while the work runs on. Nothing reaps it
 * afterwards (reapers act on live rows), and `upsertUnaccounted` deliberately
 * preserves a terminal state, so the survivor never reappears in the pane either —
 * it just re-enters the reconciler's `unaccounted` set every 30s forever. Measured
 * on this box: two `fleet spawner sidecar` tasks recorded `killed / signal SIGTERM`
 * 7s and 12s after launch, all six processes still alive 5.5h and 9.4h later, and a
 * fleet-wide "N unaccounted cgroup(s)" alarm that could never clear.
 *
 * So: only a scope we can POSITIVELY see is still populated suppresses the close.
 * Empty, missing, or unreadable all fall through to closing exactly as before —
 * the asymmetry matters, because failing the other way would invent rows that never
 * close at all. When we do suppress it, the reconciler issues the terminal verdict
 * from the real cgroup tree, which is D-018's rule applied to the close path.
 */
function wireExit(
  child: ChildProcess,
  taskId: string,
  confined: boolean,
  scopeUnit: string | null,
  scopeCgroupPath: string | null,
  fs: CgroupFs,
  persistClose: (write: () => Promise<void>) => Promise<boolean>,
  stage?: ManagedSpawnOptions['stage'],
): () => Promise<ManagedSpawnCompletion> {
  let closed = false;
  let resolveCompletion!: (outcome: ManagedSpawnCompletion) => void;
  const completion = new Promise<ManagedSpawnCompletion>((resolve) => { resolveCompletion = resolve; });
  let completionRequested = false;
  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
  // WI-10004434: a kill made through task-manager control (killTask /
  // processes:kill) is deliberate by definition, so it marks this handle as an
  // intentional teardown the same way markManagedSpawnTeardown does. The
  // notification fires synchronously BEFORE the signal is sent, so the mark is
  // in place when the client exits. Without it every caller had to remember to
  // mark its own kill: su-session-stdio-peer's close() did not, and a real omp
  // that outlived the 5s stdin-EOF grace turned its deliberate SIGKILL into an
  // "abnormal client exit" warning that failed the exact-resume acceptance.
  const stopKillNotify = onTaskKillRequested((killedTaskId, requestedSignal) => {
    if (killedTaskId === taskId) {
      intentionalTeardownChildren.add(child);
      requestedKillSignals.set(child, requestedSignal);
    }
  });
  child.once('exit', stopKillNotify);
  child.once('error', stopKillNotify);
  const close = (
    state: 'exited' | 'killed',
    code: number | null,
    reason: string | null,
    preserveKillIntent = false,
  ): void => {
    if (closed) return;
    closed = true;
    let recorded = false;
    void (async () => {
      stage?.('completion-inspect-terminal');
      const abnormal = state !== 'exited' || code !== 0 || Boolean(reason);
      const candidate =
        abnormal && !preserveKillIntent && confined && scopeUnit
          ? ((await inspectTaskUnitTerminals([scopeUnit])).get(scopeUnit) ?? null)
          : null;
      const terminal =
        candidate && (candidate.serviceResult || candidate.invocationId || candidate.loadState === 'loaded')
          ? candidate
          : null;
      const outcome = { state, exitCode: code, exitReason: reason };
      stage?.('completion-registration');
      const registered = await persistClose(async () => {
        stage?.('completion-close');
        const input = terminal ? { ...outcome, terminalProvenance: terminal } : outcome;
        recorded = await (stage ? closeTask(taskId, input, undefined, { stage }) : closeTask(taskId, input));
        if (terminal) await resetFailedTaskUnit(terminal);
      });
      stage?.('completion-finished');
      resolveCompletion(recorded ? { status: 'recorded' } : {
        status: 'unavailable', reason: registered ? 'terminal write did not update the row' : 'ledger registration pending',
      });
    })().catch((error) => {
      // A persistence failure leaves a retained failed unit available for the
      // reconciler's next tick. A close that merely loses the race is fine:
      // closeTask is idempotent on `ended_at`, so the first terminal writer wins.
      stage?.('completion-failed');
      resolveCompletion(recorded ? { status: 'recorded' } : { status: 'unavailable', reason: errorMessage(error) });
    });
  };

  /** Does the task's own scope still hold processes? Only a positive answer counts. */
  const payloadOutlivedClient = (): boolean => {
    if (!confined || !scopeCgroupPath) return false;
    const abs = absCgroupDir(scopeCgroupPath);
    if (readCgroupProcs(abs, fs).length > 0) return true;
    // `pids.current` is recursive in cgroup v2, so a payload that made its own
    // sub-cgroups is still counted where the flat read above sees nothing.
    const pidsCurrent = sampleCgroup(abs, fs).pidsCurrent;
    return pidsCurrent != null && pidsCurrent > 0;
  };

  const reportPayloadOutlivedClient = (
    code: number | null,
    signal: NodeJS.Signals | null,
    afterDelayedHandoff: boolean,
    intentionalTeardown: boolean,
  ): void => {
    const message =
      `[managed-spawn] task ${taskId}: the systemd-run client exited ` +
      `(${signal ? `signal ${signal}` : `code ${code}`}) ` +
      (afterDelayedHandoff ? 'after the delayed handoff window, ' : '') +
      'but its scope still holds processes — leaving the row live for the reconciler to close (WI-37509).' +
      (intentionalTeardown ? ' Intentional teardown.' : '');
    // A clean systemd-run client exit is an expected handoff to the reconciler,
    // not a warning. Keep abnormal exits loud so the task ledger still surfaces
    // a client that died while its payload remained alive. A release-triggered
    // signal is the same expected handoff in the opposite direction: the task
    // manager is already draining the scope on purpose, so preserve the message
    // at info level without raising a false orphan warning.
    if (intentionalTeardown || (!signal && code === 0)) console.info(message);
    else console.warn(message);
    stage?.('completion-delegated');
    resolveCompletion({ status: 'delegated', reason: 'scope still holds processes; reconciler owns terminal persistence' });
  };

  /**
   * Re-read the scope after the client exit. A single immediate read is not a
   * sufficient handoff barrier: systemd may have created the scope but not yet
   * attached the payload when it emits the client's exit. The window is finite
   * and every empty/missing/unreadable scope still closes at its deadline, so
   * this is a race guard rather than a leak-prone keepalive.
   */
  const waitForPayloadHandoff = (
    code: number | null,
    signal: NodeJS.Signals | null,
    intentionalTeardown: boolean,
    settle: () => void,
  ): void => {
    stage?.('completion-handoff');
    const deadline = Date.now() + SCOPE_HANDOFF_GRACE_MS;
    const recheck = (): void => {
      if (closed) return;
      if (payloadOutlivedClient()) {
        reportPayloadOutlivedClient(code, signal, true, intentionalTeardown);
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        stage?.('completion-handoff-complete');
        settle();
        return;
      }
      handoffTimer = setTimeout(recheck, Math.min(SCOPE_HANDOFF_RECHECK_MS, remaining));
      if (!completionRequested) handoffTimer.unref?.();
    };
    handoffTimer = setTimeout(recheck, SCOPE_HANDOFF_RECHECK_MS);
    if (!completionRequested) handoffTimer.unref?.();
  };

  const closeAfterExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
    requestedSignal: NodeJS.Signals | null,
  ): void => {
    if (requestedSignal) {
      // For confined tasks the observed child is systemd-run's client. Its exit
      // (and the unit's later exit-code result) can be clean or unrelated to the
      // signal that processes:kill deliberately sent. Preserve kill intent as a
      // cancelled attempt instead of fingerprinting the client's verdict.
      close('killed', 128 + osConstants.signals[requestedSignal], `processes:kill requested ${requestedSignal}`, true);
      return;
    }
    if (signal) {
      close('killed', code, `signal ${signal}`);
    } else if (confined && code !== 0) {
      // WI-40906 — for a confined task this is the CLIENT's exit, and a client that
      // exits non-zero with an empty scope has two very different readings: the
      // payload ran and failed, or the scope never started so the payload never ran
      // at all. P-012 retains a FAILED unit until the close writer snapshots its
      // terminal properties; a missing/collected unit still leaves these two
      // readings genuinely indistinguishable from here.
      //
      // Say that, instead of recording a bare exit code that reads as the first one.
      // The distinction is what a caller needs and cannot otherwise get: the whole
      // class of "my process silently never started" is invisible when the client's
      // stderr went to `stdio: 'ignore'`, which is exactly how the accessibility-bus
      // case above stayed hidden. This is evidence, deliberately not a verdict —
      // inventing one here is the mistake WI-37509 documents on the line above.
      close(
        'exited',
        code,
        `client exited ${code} with an empty scope — either the payload failed or the scope never started ` +
          '(a scope-launch failure means the payload never ran; systemd-run reports it on stderr, ' +
          'which is discarded when the caller passes stdio:"ignore")',
      );
    } else {
      close('exited', code, null);
    }
  };

  child.on('exit', (code, signal) => {
    stage?.('completion-child-exit');
    const intentionalTeardown = intentionalTeardownChildren.delete(child);
    const requestedSignal = requestedKillSignals.get(child) ?? null;
    requestedKillSignals.delete(child);
    if (confined && scopeCgroupPath) {
      // A populated scope at the instant the client exits is not yet proof that
      // the payload outlived it. Normal payload teardown can leave a short-lived
      // child in the scope (notably when an accessibility action closes a GTK app),
      // so use the same bounded handoff barrier for both initially-empty and
      // initially-populated scopes. Persistent occupants still produce the
      // warning after the grace window; a scope that drains closes normally.
      waitForPayloadHandoff(code, signal, intentionalTeardown, () => {
        if (payloadOutlivedClient()) {
          reportPayloadOutlivedClient(code, signal, true, intentionalTeardown);
          return;
        }
        closeAfterExit(code, signal, requestedSignal);
      });
      return;
    }
    closeAfterExit(code, signal, requestedSignal);
  });

  child.on('error', (e) => {
    intentionalTeardownChildren.delete(child);
    requestedKillSignals.delete(child);
    const msg = e.message ?? String(e);
    // A scope that could not start is NOT a payload failure — record it as such
    // so a box that has quietly lost its user bus is diagnosable from the ledger.
    const scopeFailed = confined && SCOPE_LAUNCH_FAILURE_RE.test(msg);
    close('exited', null, scopeFailed ? `scope launch failed: ${msg}` : `spawn error: ${msg}`);
  });
  return () => {
    completionRequested = true;
    // Merely awaiting a Promise does not keep a CLI alive. Only an explicit
    // waiter retains the short handoff timer; ordinary background spawns do not.
    handoffTimer?.ref?.();
    return completion;
  };
}
