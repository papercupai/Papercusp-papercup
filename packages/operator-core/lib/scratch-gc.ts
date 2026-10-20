/**
 * Scratch storage garbage collection + quota — Phase 4 T2.3.
 *
 * Sweep policy (runs on SCRATCH_GC_CRONTAB — daily — so a run-dir lives up to
 * SCRATCH_RUN_DIR_MAX_AGE_MS = RETENTION_MS + one sweep period, i.e. 24–48h):
 *   1. Walk ~/.papercusp/scratch/<workspace>/<toolName>/<runId>/ dirs;
 *      delete any older than RETENTION_MS (24h default).
 *   2. List ~/.papercusp/scratch/ top-level entries; drop a whole tree ONLY
 *      when it is PROVABLY a dead workspace scratch root (WI-10006512):
 *      not in the registry, carries a valid WORKSPACE_SCRATCH_MARKER naming
 *      itself, nothing in it changed for DEAD_WORKSPACE_QUIET_MS, and a
 *      fail-closed /proc scan finds no process with a file open (or its cwd)
 *      inside it. Anything else at the top level — agent scratch dirs,
 *      `packs`, a benchmark's PG datadir — is not ours and is never deleted.
 *      The marker is written when a workspace root is created (the scratch
 *      writers) and backfilled onto every registered root each sweep.
 *   3. After deletion, check per-workspace usage against
 *      WORKSPACE_QUOTA_BYTES; FIFO-evict by run-dir mtime until
 *      under quota.
 *
 * Single-write overflow:
 *   - reserveScratchSpace(workspaceId, bytes) checks the workspace
 *     quota WITHOUT writing. Throws ScratchQuotaError on overflow.
 *   - The agent-tools route layer responds 507 Insufficient Storage
 *     when this throws on a tool's write path.
 *
 * The GC is conservative: it never deletes the currently-active run
 * of any tool (relies on mtime; the dispatcher bumps mtime on every
 * write). Acceptable race: a stale 24h+1min run with a slow trailing
 * write could be evicted mid-write; in practice tools either write
 * fast or extend mtime via fs.utimes if they keep the dir around.
 *
 * Plan ref: phase-4-endpoint-system-2026-05-12.md § T2.3.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir as mkdirAsync,
  readdir as readdirAsync,
  stat as statAsync,
  lstat as lstatAsync,
  rm as rmAsync,
  readFile as readFileAsync,
  writeFile as writeFileAsync,
  rename as renameAsync,
  realpath as realpathAsync,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pinModuleState } from '@papercusp/module-singleton';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { openWriterPidsMany, NATIVE_BG_SCAN_DEADLINE_MS, type OpenWriterScan } from './native-bg-task-ledger';
import { scratchRoot, scratchRootForWorkspace } from './scratch-uri';
import { withFsMutex } from '../../../scripts/lib/fs-mutex.mjs';
import { withUnpinnedPath } from './storage/retention-pins';

/** Serialize the final protection read and delete with storage:pin mutations. */
async function removeUnpinnedScratchPath(path: string, dryRun = false): Promise<boolean> {
  return withUnpinnedPath(path, async () => {
    if (!dryRun) await rmAsync(path, { recursive: true, force: true });
    return true;
  });
}

/** Retention window for run-dirs since last mtime. 24h default. */
export const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Per-workspace quota. 5 GB default. */
export const WORKSPACE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * Reserve 256 MiB below the hard quota so the existing background usage refresh can
 * reclaim old runs before a result spill needs request-time FIFO candidate work.
 */
export const SCRATCH_QUOTA_RECOVERY_HEADROOM_BYTES = 256 * 1024 * 1024;

/**
 * GC sweep schedule — the ONE source for it. `dbos/periodic-workflows.ts` registers the
 * `scratchGc` DBOS workflow with exactly this crontab (6-field, seconds first: daily 03:00
 * host-local). It replaces a hand-maintained `GC_INTERVAL_MS = 1h` that nothing read: the
 * sweep had been daily all along, and that constant led an investigation (WI-10004532) to
 * report retention as unenforced when the GC was working.
 */
export const SCRATCH_GC_CRONTAB = '0 0 3 * * *';

/** Interval between sweeps implied by SCRATCH_GC_CRONTAB (daily). */
export const SCRATCH_GC_SWEEP_PERIOD_MS = 24 * 60 * 60 * 1000;

const SHARED_SCRATCH_QUOTA_STATE_VERSION = 1;
const scratchMutexState = pinModuleState('@papercusp/operator-core.scratch-gc.mutex-queues', () =>
  new Map<string, Promise<void>>(),
);
const scratchMutexWaiters = pinModuleState('@papercusp/operator-core.scratch-gc.mutex-waiters', () =>
  new Map<string, Array<{ operation: string; startedAt: number; requestTraceId?: string }>>(),
);

interface SharedScratchQuotaState {
  version: typeof SHARED_SCRATCH_QUOTA_STATE_VERSION;
  workspaceRoot: string;
  bytes: number;
  /** Last full filesystem reconciliation; delta writes preserve this timestamp. */
  measuredAt: number;
  /** Last state mutation; an old state is reconciled before it can authorize a write. */
  updatedAt: number;
}

function scratchWorkspaceMutexName(workspaceId: string): string {
  const workspaceRoot = resolve(scratchRootForWorkspace(workspaceId));
  const digest = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 40);
  return 'papercusp-scratch-quota-' + digest;
}

function scratchWorkspaceDataMutexName(workspaceId: string): string {
  const workspaceRoot = resolve(scratchRootForWorkspace(workspaceId));
  const digest = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 40);
  return 'papercusp-scratch-data-' + digest;
}

function normalizeScratchMutexTimeout(error: unknown, timeoutMs?: number): unknown {
  if (timeoutMs == null || !error || typeof error !== 'object') return error;
  const row = error as { code?: unknown; message?: unknown };
  if (row.code == null && typeof row.message === 'string' && row.message.includes('Timed out after')) {
    Object.assign(error, { code: 'ETIMEDOUT' });
  }
  return error;
}

/**
 * Scratch quota admission is high-churn metadata work. Keep its queue, ticket,
 * and lease markers on the per-user runtime filesystem when one is available so
 * quota spills do not contend with the persistent home-disk mutex root used by
 * package installs and other control-plane operations. `withFsMutex` still gives
 * PAPERCUSP_FS_MUTEX_LOCK_DIR precedence, which keeps the test/operator override
 * authoritative and lets operators inspect or co-locate all locks deliberately.
 */
function scratchQuotaMutexLockRoot(): string | undefined {
  const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim();
  return runtimeDir ? join(runtimeDir, 'papercusp', 'fs-mutex-locks') : undefined;
}

function sharedScratchQuotaStatePath(workspaceId: string): string {
  const workspaceRoot = resolve(scratchRootForWorkspace(workspaceId));
  const digest = createHash('sha256').update(workspaceRoot).digest('hex');
  const path = join(dirname(scratchRoot()), 'scratch-quota-state', digest + '.json');
  usageState.sharedStatePaths.add(path);
  return path;
}

function withScratchWorkspaceMutex<T>(
  workspaceId: string,
  operation: string,
  run: () => Promise<T>,
  onWaiting?: (info: { owner: string; elapsedMs: number }) => void,
  onAcquired?: (info: {
    waitedMs: number;
    localWaitMs: number;
    fsMutexAdmissionMs: number;
    admissionSubphaseTimingsMs?: Record<string, number>;
  }) => void,
  requestTraceId?: string,
  mutexTimeoutMs?: number,
  onTimedOut?: (info: {
    waitedMs: number;
    localWaitMs: number;
    fsMutexAdmissionMs: number;
    admissionSubphaseTimingsMs?: Record<string, number>;
  }) => void,
): Promise<T> {
  const mutexName = scratchWorkspaceMutexName(workspaceId);
  const intent = {
    subsystem: 'scratch-quota',
    operation,
    workspaceId,
    ...(requestTraceId ? { requestTraceId: requestTraceId.slice(0, 120) } : {}),
  };
  const lockRootDir = scratchQuotaMutexLockRoot();
  if (process.env.PAPERCUSP_DISABLE_FS_MUTEX !== '1') {
    const filesystemAdmissionStartedAt = performance.now();
    return withFsMutex(mutexName, run, {
      intent,
      ...(lockRootDir ? { lockRootDir } : {}),
      ...(mutexTimeoutMs != null ? { timeoutMs: mutexTimeoutMs } : {}),
      waitingNoticeIntervalMs: 5_000,
      onWaiting,
      onAcquired: onAcquired
        ? (info) => {
          const filesystemWaitMs = Math.max(0, performance.now() - filesystemAdmissionStartedAt);
          onAcquired({
            waitedMs: filesystemWaitMs,
            localWaitMs: 0,
            fsMutexAdmissionMs: info.waitedMs,
            admissionSubphaseTimingsMs: info.admissionSubphaseTimingsMs,
          });
        }
        : undefined,
      onTimedOut: onTimedOut
        ? (info) => {
          onTimedOut({
            waitedMs: Math.max(0, performance.now() - filesystemAdmissionStartedAt),
            localWaitMs: 0,
            fsMutexAdmissionMs: info.waitedMs,
            admissionSubphaseTimingsMs: info.admissionSubphaseTimingsMs,
          });
        }
        : undefined,
    }).catch((error) => { throw normalizeScratchMutexTimeout(error, mutexTimeoutMs); });
  }

  const previous = scratchMutexState.get(mutexName) ?? Promise.resolve();
  const requests = scratchMutexWaiters.get(mutexName) ?? [];
  const request = {
    operation,
    startedAt: Date.now(),
    ...(requestTraceId ? { requestTraceId: requestTraceId.slice(0, 120) } : {}),
  };
  requests.push(request);
  const queuedLocally = requests[0] !== request;
  scratchMutexWaiters.set(mutexName, requests);
  let release!: () => void;
  const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
  const tail = previous.then(() => held, () => held);
  scratchMutexState.set(mutexName, tail);
  const localWaitStartedAt = performance.now();
  let localWaitTimer: ManagedHandle | undefined;
  if (requests[0] !== request && onWaiting) {
    // Instanced: one timer per queued waiter, aggregated into ONE schedule:inventory row.
    localWaitTimer = managedSetInterval('scratch-mutex-local-wait-progress', 5_000, () => {
      const holder = requests[0];
      if (!holder || holder === request) return;
      try {
        onWaiting({
          owner: JSON.stringify({
            layer: 'process-local',
            operation: holder.operation,
            requestTraceId: holder.requestTraceId,
            pid: process.pid,
            startedAt: new Date(holder.startedAt).toISOString(),
          }),
          elapsedMs: Math.max(0, performance.now() - localWaitStartedAt),
        });
      } catch {
        // Diagnostic observers must not change mutex admission behavior.
      }
    }, { category: 'lifecycle', instanced: true, classification: 'timeout-reaper' });
  }
  // A closure, so both call sites below stop the SAME handle without TS narrowing it to
  // `never` after the first stop (stop() is idempotent; the finally is the safety net).
  const stopLocalWaitTimer = () => {
    localWaitTimer?.stop();
    localWaitTimer = undefined;
  };
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    stopLocalWaitTimer();
    release();
    const requestIndex = requests.indexOf(request);
    if (requestIndex >= 0) requests.splice(requestIndex, 1);
    if (requests.length === 0) scratchMutexWaiters.delete(mutexName);
    if (scratchMutexState.get(mutexName) === tail) scratchMutexState.delete(mutexName);
  };

  return (async () => {
    try {
      const waitForPrevious = previous.catch(() => {});
      if (mutexTimeoutMs == null) {
        await waitForPrevious;
      } else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            waitForPrevious,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                const error = Object.assign(
                  new Error(`Timed out after ${mutexTimeoutMs}ms waiting for scratch quota mutex`),
                  { code: 'ETIMEDOUT' },
                );
                reject(error);
              }, mutexTimeoutMs);
              (timer as { unref?: () => void } | undefined)?.unref?.();
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    } catch (error) {
      cleanup();
      throw error;
    }
    const localWaitMs = queuedLocally
      ? Math.max(0, performance.now() - localWaitStartedAt)
      : 0;
    stopLocalWaitTimer();
    let firstFilesystemWaitElapsedMs: number | undefined;
    const observedOnWaiting = onWaiting || onAcquired
      ? (info: { owner: string; elapsedMs: number }) => {
        if (firstFilesystemWaitElapsedMs === undefined) {
          firstFilesystemWaitElapsedMs = info.elapsedMs;
        }
        onWaiting?.(info);
      }
      : undefined;
    try {
      return await withFsMutex(mutexName, run, {
        intent,
        ...(lockRootDir ? { lockRootDir } : {}),
        ...(mutexTimeoutMs != null ? { timeoutMs: mutexTimeoutMs } : {}),
        waitingNoticeIntervalMs: 5_000,
        onWaiting: observedOnWaiting,
        onAcquired: onAcquired
          ? (info) => {
            const filesystemWaitMs = firstFilesystemWaitElapsedMs === undefined
              ? 0
              : Math.max(0, info.waitedMs - firstFilesystemWaitElapsedMs);
            onAcquired({
              waitedMs: localWaitMs + filesystemWaitMs,
              localWaitMs,
              fsMutexAdmissionMs: info.waitedMs,
              admissionSubphaseTimingsMs: info.admissionSubphaseTimingsMs,
            });
          }
          : undefined,
      });
    } catch (error) {
      throw normalizeScratchMutexTimeout(error, mutexTimeoutMs);
    } finally {
      cleanup();
    }
  })();
}

/**
 * Keep scratch-tree mutations away from in-flight payload writes. Payload writers hold
 * shared reader leases; GC and quota eviction take the exclusive lease. Quota-ledger
 * updates use the separate scratchWorkspaceMutexName lock and stay short.
 */
function withScratchWorkspaceDataMutex<T>(
  workspaceId: string,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  const mutexName = scratchWorkspaceDataMutexName(workspaceId);
  const lockRootDir = scratchQuotaMutexLockRoot();
  return withFsMutex(mutexName, run, {
    intent: { subsystem: 'scratch-quota', operation, workspaceId },
    ...(lockRootDir ? { lockRootDir } : {}),
  });
}

function withScratchWorkspaceDataReadLease<T>(
  workspaceId: string,
  operation: string,
  run: () => Promise<T>,
  onWaiting?: (info: { owner: string; elapsedMs: number }) => void,
  onAcquired?: (info: {
    waitedMs: number;
    localWaitMs: number;
    fsMutexAdmissionMs: number;
    admissionSubphaseTimingsMs?: Record<string, number>;
  }) => void,
  requestTraceId?: string,
  mutexTimeoutMs?: number,
): Promise<T> {
  const mutexName = scratchWorkspaceDataMutexName(workspaceId);
  const lockRootDir = scratchQuotaMutexLockRoot();
  return withFsMutex(mutexName, run, {
    mode: 'read',
    intent: {
      subsystem: 'scratch-quota',
      operation,
      workspaceId,
      ...(requestTraceId ? { requestTraceId: requestTraceId.slice(0, 120) } : {}),
    },
    ...(lockRootDir ? { lockRootDir } : {}),
    ...(mutexTimeoutMs != null ? { timeoutMs: mutexTimeoutMs } : {}),
    waitingNoticeIntervalMs: 5_000,
    onWaiting,
    onAcquired: onAcquired
      ? (info) => onAcquired({
          waitedMs: info.waitedMs,
          localWaitMs: 0,
          fsMutexAdmissionMs: info.waitedMs,
        })
      : undefined,
  }).catch((error) => { throw normalizeScratchMutexTimeout(error, mutexTimeoutMs); });
}

type ScratchWriteObservedAwaitPhase = 'quota-state-read' | 'quota-state-publish' | 'marker-probe' | 'file-write';
type ScratchWriteAwaitObserver = <T>(
  phase: ScratchWriteObservedAwaitPhase,
  subphase: string,
  operation: () => Promise<T>,
) => Promise<T>;

async function readSharedScratchQuotaState(
  workspaceId: string,
  observeAwait?: ScratchWriteAwaitObserver,
): Promise<SharedScratchQuotaState | null> {
  const path = sharedScratchQuotaStatePath(workspaceId);
  let body: string;
  try {
    body = await (observeAwait
      ? observeAwait('quota-state-read', 'read-file', () => readFileAsync(path, 'utf8'))
      : readFileAsync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const value = JSON.parse(body) as Partial<SharedScratchQuotaState>;
    const workspaceRoot = resolve(scratchRootForWorkspace(workspaceId));
    if (
      value.version !== SHARED_SCRATCH_QUOTA_STATE_VERSION ||
      value.workspaceRoot !== workspaceRoot ||
      !Number.isSafeInteger(value.bytes) ||
      Number(value.bytes) < 0 ||
      !Number.isSafeInteger(value.measuredAt) ||
      !Number.isSafeInteger(value.updatedAt)
    ) {
      return null;
    }
    return value as SharedScratchQuotaState;
  } catch {
    return null;
  }
}

async function writeSharedScratchQuotaState(
  workspaceId: string,
  bytes: number,
  measuredAt: number,
  observeAwait?: ScratchWriteAwaitObserver,
): Promise<number> {
  const path = sharedScratchQuotaStatePath(workspaceId);
  const parent = dirname(path);
  const publishAwait = <T>(subphase: string, operation: () => Promise<T>) => observeAwait
    ? observeAwait('quota-state-publish', subphase, operation)
    : operation();
  await publishAwait('ensure-parent', () => mkdirAsync(parent, { recursive: true, mode: 0o700 }));
  const existing = await readSharedScratchQuotaState(workspaceId, observeAwait);
  const entry = usageState.byWorkspace.get(workspaceId);
  // updatedAt is also the shared-state revision fence. Advance it monotonically so two
  // writes in the same millisecond cannot make a remote mutation look like our own snapshot.
  const updatedAt = Math.max(
    Date.now(),
    (existing?.updatedAt ?? 0) + 1,
    (entry?.sharedUpdatedAt ?? 0) + 1,
  );
  const record: SharedScratchQuotaState = {
    version: SHARED_SCRATCH_QUOTA_STATE_VERSION,
    workspaceRoot: resolve(scratchRootForWorkspace(workspaceId)),
    bytes: Math.max(0, Math.trunc(bytes)),
    measuredAt,
    updatedAt,
  };
  const temporary = path + '.' + process.pid + '.' + randomUUID() + '.tmp';
  await publishAwait('write-temporary-file', () =>
    writeFileAsync(temporary, JSON.stringify(record) + '\n', { mode: 0o600 }));
  try {
    await publishAwait('rename-temporary-file', () => renameAsync(temporary, path));
  } catch (error) {
    await publishAwait('remove-temporary-file', () => rmAsync(temporary, { force: true })).catch(() => {});
    throw error;
  }
  if (entry) entry.sharedUpdatedAt = updatedAt;
  return updatedAt;
}

async function removeSharedScratchQuotaState(workspaceId: string): Promise<void> {
  await rmAsync(sharedScratchQuotaStatePath(workspaceId), { force: true });
  const entry = usageState.byWorkspace.get(workspaceId);
  if (entry) entry.sharedUpdatedAt = null;
}

function invalidateLocalScratchUsage(workspaceId: string): void {
  const entry = usageEntry(workspaceId);
  entry.measuredAt = 0;
  entry.refreshDeferred = false;
  entry.runBytesByPath.clear();
  entry.runBytesValid = false;
}

function adoptSharedScratchUsage(
  workspaceId: string,
  bytes: number,
  updatedAt: number,
  allowLocalIndexReuse: boolean,
): ScratchUsageEntry {
  const entry = usageEntry(workspaceId);
  // A complete local run index is reusable only for the exact shared revision this process
  // last wrote. A changed remote revision needs a full reconciliation; matching revisions let
  // request-time recovery re-list runs and remeasure FIFO candidates without walking the tree.
  const preserveRunIndex = allowLocalIndexReuse
    && entry.runBytesValid
    && !entry.refreshDeferred
    && entry.bytes === bytes
    && entry.sharedUpdatedAt === updatedAt;
  entry.bytes = bytes;
  entry.measuredAt = Date.now();
  entry.refreshDeferred = false;
  entry.sharedUpdatedAt = updatedAt;
  if (!preserveRunIndex) {
    entry.runBytesByPath.clear();
    entry.runBytesValid = false;
  }
  return entry;
}

/**
 * The oldest a run-dir can legitimately get. The sweep only removes dirs already past
 * RETENTION_MS at the moment it runs, so a dir that crosses RETENTION_MS just after a sweep
 * survives one more full period. Counting "run dirs older than RETENTION_MS" therefore
 * measures the sweep cadence, not a GC failure. A dir older than THIS bound means the GC is
 * not running or not deleting.
 */
export const SCRATCH_RUN_DIR_MAX_AGE_MS = RETENTION_MS + SCRATCH_GC_SWEEP_PERIOD_MS;

/* ─── Workspace-root proof (WI-10006512) ─────────────────────────────────
 *
 * The dead-workspace pass used to treat EVERY top-level entry of the scratch root that was not a
 * registered workspace id as a dead workspace and `rm -rf` it, with no age or open-file check. The
 * scratch root is also where agents are told to put their own scratch (the bash resource gate
 * names `~/.papercusp/scratch/<session-or-task>/`) and where `packs` lives, so the 03:00 sweep
 * deleted a running benchmark's PG datadir mid-run (2026-10-06). A name is not proof: an agent dir
 * matches the workspace-id grammar. So a workspace root now carries a marker naming its workspace,
 * and the sweep deletes only a tree that carries one.
 */

/** File in a workspace scratch root that proves the dir belongs to that workspace. */
export const WORKSPACE_SCRATCH_MARKER = '.papercusp-workspace-scratch-root';

const WORKSPACE_SCRATCH_MARKER_KIND = 'papercusp-workspace-scratch-root';

/**
 * A provably-dead workspace root is kept while anything in it changed this recently. Same window
 * as run-dir retention: a workspace that stopped writing a day ago is as dead as an expired run.
 */
export const DEAD_WORKSPACE_QUIET_MS = RETENTION_MS;

function workspaceScratchMarkerBody(workspaceId: string, now = Date.now()): string {
  return `${JSON.stringify({ kind: WORKSPACE_SCRATCH_MARKER_KIND, workspaceId, markedAt: new Date(now).toISOString() })}\n`;
}

/**
 * Mark a workspace scratch root that a `mkdir(..., { recursive: true })` call just created.
 * `firstCreated` is that call's return value (the first directory it created, or undefined when
 * the whole chain already existed). The marker is written only when the workspace root itself was
 * created by that call, so the steady-state write path costs nothing. A root that pre-existed is
 * marked by the sweep's backfill instead. Best-effort: a marker failure never fails the write.
 */
export function markNewWorkspaceScratchRootSync(workspaceId: string, firstCreated: string | undefined): void {
  if (!firstCreated) return;
  try {
    const wsRoot = scratchRootForWorkspace(workspaceId);
    if (wsRoot !== firstCreated && !wsRoot.startsWith(firstCreated + sep)) return;
    writeFileSync(join(wsRoot, WORKSPACE_SCRATCH_MARKER), workspaceScratchMarkerBody(workspaceId), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    /* EEXIST (already marked), an invalid workspace id, or a vanished root: nothing to mark. */
  }
}

/** Async twin of markNewWorkspaceScratchRootSync, for the non-blocking write path. */
export async function markNewWorkspaceScratchRoot(workspaceId: string, firstCreated: string | undefined): Promise<void> {
  if (!firstCreated) return;
  try {
    const wsRoot = scratchRootForWorkspace(workspaceId);
    if (wsRoot !== firstCreated && !wsRoot.startsWith(firstCreated + sep)) return;
    await writeMarkerIfAbsent(wsRoot, workspaceId);
  } catch {
    /* see markNewWorkspaceScratchRootSync */
  }
}

/** Write the marker into an EXISTING root. Returns true when it wrote one. Never creates the root. */
async function writeMarkerIfAbsent(wsRoot: string, workspaceId: string): Promise<boolean> {
  try {
    await writeFileAsync(join(wsRoot, WORKSPACE_SCRATCH_MARKER), workspaceScratchMarkerBody(workspaceId), {
      flag: 'wx',
      mode: 0o600,
    });
    return true;
  } catch {
    return false; // EEXIST = already marked; ENOENT = no root to mark
  }
}

/**
 * True only when `dir` is a real directory (not a symlink) whose marker names `name` as its
 * workspace. A copied or renamed tree carries a marker naming a different workspace, so it fails.
 */
async function isProvenWorkspaceScratchRoot(dir: string, name: string): Promise<boolean> {
  try {
    if (!(await lstatAsync(dir)).isDirectory()) return false;
    const marker = JSON.parse(await readFileAsync(join(dir, WORKSPACE_SCRATCH_MARKER), 'utf8')) as {
      kind?: unknown;
      workspaceId?: unknown;
    };
    return marker.kind === WORKSPACE_SCRATCH_MARKER_KIND && marker.workspaceId === name;
  } catch {
    return false;
  }
}

/** Why a provably-dead workspace root was kept this sweep. */
export type DeadWorkspaceDeferral = 'recent-write' | 'open-writer' | 'process-scan-incomplete' | 'retention-pin';

/** Default open-writer scan: descendants + cwd, fail-closed, deadline-bounded (as fleet-logs-gc). */
function defaultScanOpenPaths(paths: readonly string[]): Promise<OpenWriterScan> {
  return openWriterPidsMany(paths, {
    descendants: true,
    includeCwd: true,
    failClosed: true,
    deadlineMs: NATIVE_BG_SCAN_DEADLINE_MS,
  });
}

export class ScratchQuotaError extends Error {
  readonly code = 'SCRATCH_QUOTA_EXCEEDED';
  constructor(message: string) {
    super(message);
    this.name = 'ScratchQuotaError';
  }
}

/** Telemetry: total bytes evicted by FIFO sweeps since process start. */
let evictedBytesTotal = 0;

export function scratchEvictionBytes(): number {
  return evictedBytesTotal;
}

/** Reset the eviction counter — test-only. */
export function _resetScratchGcCountersForTests(): void {
  evictedBytesTotal = 0;
}

/**
 * Run one full GC sweep over the scratch tree.
 *
 *   workspaceRegistry: list of known workspace IDs. A top-level dir not
 *     in the registry is removed wholesale ONLY when it is provably a dead
 *     workspace root (marker), quiet, and held by no process (WI-10006512);
 *     every other top-level entry is left alone and counted.
 *
 * Returns a summary for logging / tests. Designed to be safe even if
 * the scratch root doesn't exist (no-op).
 *
 * ASYNC and SEQUENTIAL (WI-10005135): every readdir / stat / rm is an awaited fs/promises call,
 * one in flight at a time, so the sweep never blocks the event loop and occupies at most one
 * libuv threadpool thread. It used to be a synchronous readdirSync+statSync walk of the whole
 * tree (several passes: dead workspaces, retention, quota) on the DBOS worker's main thread,
 * measured at ~1 s per warm walk; under ext4 contention a single readdir can block for seconds
 * (the WI-10004513 D-state class), and a blocked main thread is what times out Jev memory calls.
 */
export interface ScratchGcSummary {
  retentionEvictions: number;
  retentionEvictedBytes: number;
  deadWorkspaces: number;
  deadWorkspaceBytes: number;
  quotaEvictions: number;
  quotaEvictedBytes: number;
  /** Registered workspace roots that got their WORKSPACE_SCRATCH_MARKER this sweep (backfill). */
  markersWritten: number;
  /**
   * Top-level entries that are neither registered nor provably a workspace scratch root (agent
   * scratch, `packs`, ...). Counted so growth stays visible; NEVER deleted by this sweep.
   */
  unprovenEntries: number;
  /** Provably-dead workspace roots this sweep kept, and why. */
  deadWorkspacesDeferred: Array<{ workspaceId: string; reason: DeadWorkspaceDeferral }>;
  /** The caller's wall-time budget expired before the full sweep completed. */
  truncated?: boolean;
}

interface ScratchGcBudget {
  deadlineMs: number;
  truncated: boolean;
}

function scratchGcBudgetExpired(budget?: ScratchGcBudget): boolean {
  if (!budget || Date.now() < budget.deadlineMs) return false;
  budget.truncated = true;
  return true;
}

export async function runScratchGc(opts: {
  workspaceRegistry: ReadonlyArray<string>;
  now?: number;
  /** Test seam for the /proc open-writer scan. Missing or partial evidence always keeps a tree. */
  scanOpenPaths?: (paths: readonly string[]) => Promise<OpenWriterScan>;
  /** Preview eligible evictions without writing markers, deleting paths, or enforcing quota. */
  dryRun?: boolean;
  /** Requested run-dir retention; the system's safe default remains a hard floor. */
  retentionMs?: number;
  /** Requested quiet window for dead workspace roots; the GC's safe default remains a floor. */
  quietMs?: number;
  /** Skip quota FIFO eviction when the caller only owns retention pruning. Defaults to true. */
  enforceQuota?: boolean;
  /** Optional wall-time cap for foreground callers; a capped sweep returns a partial summary. */
  maxDurationMs?: number;
}): Promise<ScratchGcSummary> {
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun ?? false;
  const retentionMs = Math.max(RETENTION_MS, opts.retentionMs ?? RETENTION_MS);
  const quietMs = Math.max(DEAD_WORKSPACE_QUIET_MS, opts.quietMs ?? DEAD_WORKSPACE_QUIET_MS);
  const root = scratchRoot();
  const summary: ScratchGcSummary = {
    retentionEvictions: 0,
    retentionEvictedBytes: 0,
    deadWorkspaces: 0,
    deadWorkspaceBytes: 0,
    quotaEvictions: 0,
    quotaEvictedBytes: 0,
    markersWritten: 0,
    unprovenEntries: 0,
    deadWorkspacesDeferred: [],
  };

  const registrySet = new Set(opts.workspaceRegistry);
  const budget = opts.maxDurationMs == null
    ? undefined
    : { deadlineMs: Date.now() + Math.max(0, opts.maxDurationMs), truncated: false };

  if (!dryRun) {
    // Backfill: every registered workspace root that exists gets its marker, so that once the
    // workspace leaves the registry its root is provably ours. Never creates a root.
    for (const workspaceId of opts.workspaceRegistry) {
      if (scratchGcBudgetExpired(budget)) break;
      let wsRoot: string;
      try {
        wsRoot = scratchRootForWorkspace(workspaceId);
      } catch {
        continue; // an id with no valid scratch shape has no scratch root
      }
      const wrote = await withScratchWorkspaceDataMutex(workspaceId, 'marker-backfill', () =>
        withScratchWorkspaceMutex(workspaceId, 'marker-backfill', async () => {
        const wroteMarker = await writeMarkerIfAbsent(wsRoot, workspaceId);
        if (wroteMarker) {
          await removeSharedScratchQuotaState(workspaceId);
          invalidateLocalScratchUsage(workspaceId);
        }
        return wroteMarker;
      }));
      if (wrote) summary.markersWritten += 1;
    }
  }

  // Step 2 (before step 1 so we don't waste work on dead workspaces): remove PROVABLY dead
  // workspace roots wholesale (WI-10006512). A missing root lists as empty.
  const candidates: Array<{ workspaceId: string; dir: string; realDir: string; bytes: number }> = [];
  for (const name of await listDir(root, undefined, budget)) {
    if (scratchGcBudgetExpired(budget)) break;
    if (registrySet.has(name)) continue;
    const dir = join(root, name);
    if (!(await isProvenWorkspaceScratchRoot(dir, name))) {
      summary.unprovenEntries += 1;
      continue;
    }
    const tree = await treeStatsAsync(dir, budget);
    if (tree.truncated || scratchGcBudgetExpired(budget)) break;
    if (now - tree.newestMtimeMs < quietMs) {
      summary.deadWorkspacesDeferred.push({ workspaceId: name, reason: 'recent-write' });
      continue;
    }
    // /proc fd and cwd links name REAL paths, so the scan must be given the real path too.
    let realDir: string;
    try {
      realDir = await realpathAsync(dir);
    } catch {
      continue; // vanished mid-sweep
    }
    candidates.push({ workspaceId: name, dir, realDir, bytes: tree.bytes });
  }
  if (candidates.length > 0 && !scratchGcBudgetExpired(budget)) {
    let scan: OpenWriterScan = { byPath: new Map(), complete: false };
    try {
      scan = await (opts.scanOpenPaths ?? defaultScanOpenPaths)(candidates.map((c) => c.realDir));
    } catch {
      /* no process evidence is not permission to delete */
    }
    for (const c of candidates) {
      if (scratchGcBudgetExpired(budget)) break;
      if (scan.byPath.get(c.realDir)?.length) {
        summary.deadWorkspacesDeferred.push({ workspaceId: c.workspaceId, reason: 'open-writer' });
        continue;
      }
      if (!scan.complete) {
        summary.deadWorkspacesDeferred.push({ workspaceId: c.workspaceId, reason: 'process-scan-incomplete' });
        continue;
      }
      if (dryRun) {
        if (!(await removeUnpinnedScratchPath(c.dir, true))) {
          summary.deadWorkspacesDeferred.push({ workspaceId: c.workspaceId, reason: 'retention-pin' });
          continue;
        }
        summary.deadWorkspaces += 1;
        summary.deadWorkspaceBytes += c.bytes;
        continue;
      }
      await withScratchWorkspaceDataMutex(c.workspaceId, 'dead-workspace-gc', () =>
        withScratchWorkspaceMutex(c.workspaceId, 'dead-workspace-gc', async () => {
        if (!(await isProvenWorkspaceScratchRoot(c.dir, c.workspaceId))) return;
        // A cooperating writer may have run after the initial bulk /proc scan. Its mutex lease
        // has drained by this point; recheck age so the fresh write survives this sweep.
        const currentTree = await treeStatsAsync(c.dir);
        if (now - currentTree.newestMtimeMs < quietMs) {
          summary.deadWorkspacesDeferred.push({ workspaceId: c.workspaceId, reason: 'recent-write' });
          return;
        }
        if (!(await removeUnpinnedScratchPath(c.dir))) {
          summary.deadWorkspacesDeferred.push({ workspaceId: c.workspaceId, reason: 'retention-pin' });
          return;
        }
        await removeSharedScratchQuotaState(c.workspaceId);
        invalidateLocalScratchUsage(c.workspaceId);
        summary.deadWorkspaces += 1;
        summary.deadWorkspaceBytes += currentTree.bytes;
      }));
    }
  }

  // Step 1: retention sweep, per-workspace.
  for (const workspaceId of opts.workspaceRegistry) {
    if (scratchGcBudgetExpired(budget)) break;
    // Walk and size candidates without the workspace mutex. A retention sweep can visit many
    // run directories, and a slow stat/readdir here must not hold up result-door reservations
    // for the whole workspace. Each deletion still takes the mutex and revalidates the run's
    // mtime immediately before removing it, so a cooperating writer that started after this
    // scan keeps its run alive. Pin state is checked inside the same deletion critical section.
    const candidates = (await runDirsOf(scratchRootForWorkspace(workspaceId), undefined, budget))
      .filter((run) => now - run.mtimeMs > retentionMs);
    let removed = false;
    for (const candidate of candidates) {
      if (scratchGcBudgetExpired(budget)) break;
      const bytes = await sizeOfDirAsync(candidate.dir, undefined, undefined, 0, undefined, undefined, budget);
      if (scratchGcBudgetExpired(budget)) break;
      if (dryRun) {
        if (!(await removeUnpinnedScratchPath(candidate.dir, true))) continue;
        summary.retentionEvictions += 1;
        summary.retentionEvictedBytes += bytes;
        continue;
      }

      const evicted = await withScratchWorkspaceDataMutex(workspaceId, 'retention-gc', () =>
        withScratchWorkspaceMutex(workspaceId, 'retention-gc', async () => {
        let current;
        try {
          current = await statAsync(candidate.dir);
        } catch {
          return false;
        }
        if (!current.isDirectory() || now - current.mtimeMs <= retentionMs) return false;
        return removeUnpinnedScratchPath(candidate.dir);
      }));
      if (!evicted) continue;
      removed = true;
      summary.retentionEvictions += 1;
      summary.retentionEvictedBytes += bytes;
    }
    if (removed) {
      await withScratchWorkspaceDataMutex(workspaceId, 'retention-gc-state', () =>
        withScratchWorkspaceMutex(workspaceId, 'retention-gc-state', async () => {
          await removeSharedScratchQuotaState(workspaceId);
          invalidateLocalScratchUsage(workspaceId);
        }));
    }
  }

  // Step 3: per-workspace quota check + FIFO eviction by mtime.
  if (opts.enforceQuota !== false && !dryRun && !scratchGcBudgetExpired(budget)) {
    for (const workspaceId of opts.workspaceRegistry) {
      const reclaimed = await evictWorkspaceQuotaWithLock(workspaceId, () => WORKSPACE_QUOTA_BYTES);
      summary.quotaEvictions += reclaimed.evictions;
      summary.quotaEvictedBytes += reclaimed.bytes;
    }
  }

  if (budget?.truncated) summary.truncated = true;

  return summary;
}

/** Entry names of `dir`, or [] when it is missing or unreadable. Never blocks the event loop. */
async function listDir(
  dir: string,
  diagnostics?: ScratchQuotaRecoveryDiagnostics,
  budget?: ScratchGcBudget,
): Promise<string[]> {
  if (scratchGcBudgetExpired(budget)) return [];
  try {
    const names = await measureScratchQuotaRecoveryOperation(
      diagnostics,
      'readdir',
      () => readdirAsync(dir),
    );
    scratchGcBudgetExpired(budget);
    return names;
  } catch {
    return [];
  }
}

/** Child DIRECTORIES of `dir` with their mtimes; files and entries that vanish mid-walk are skipped. */
async function childDirs(
  dir: string,
  diagnostics?: ScratchQuotaRecoveryDiagnostics,
  budget?: ScratchGcBudget,
): Promise<Array<{ dir: string; mtimeMs: number }>> {
  const out: Array<{ dir: string; mtimeMs: number }> = [];
  for (const name of await listDir(dir, diagnostics, budget)) {
    if (scratchGcBudgetExpired(budget)) break;
    const child = join(dir, name);
    let st;
    try {
      st = await measureScratchQuotaRecoveryOperation(diagnostics, 'stat', () => statAsync(child));
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push({ dir: child, mtimeMs: st.mtimeMs });
  }
  return out;
}

/** Every `<toolName>/<runId>/` run dir under a workspace root (empty when the root is missing). */
async function runDirsOf(
  wsRoot: string,
  diagnostics?: ScratchQuotaRecoveryDiagnostics,
  budget?: ScratchGcBudget,
): Promise<Array<{ dir: string; mtimeMs: number }>> {
  const runs: Array<{ dir: string; mtimeMs: number }> = [];
  for (const toolDir of await childDirs(wsRoot, diagnostics, budget)) {
    if (scratchGcBudgetExpired(budget)) break;
    runs.push(...(await childDirs(toolDir.dir, diagnostics, budget)));
  }
  return runs;
}

/**
 * How stale a workspace's cached usage total may get before the next reservation kicks off a
 * background re-measure. Between measurements the total tracks this process's own reservations;
 * other processes' writes and GC deletions are picked up on the next re-measure. The quota is a
 * coarse disk-safety net (5 GB vs ~0.4 GB in practice), so minutes of drift are immaterial.
 */
export const USAGE_REFRESH_MS = 5 * 60 * 1000;

interface ScratchUsageEntry {
  /** Best-known bytes used: last async measurement + reservations made since. */
  bytes: number;
  /** When the last completed measurement finished (0 = never measured). */
  measuredAt: number;
  /** In-flight background measurement, if any (at most one per workspace). */
  refreshing: Promise<void> | null;
  /** Live scan counters, exposed to writers waiting for this refresh. */
  refreshDiagnostics: ScratchQuotaRecoveryDiagnostics | null;
  /** One shared pressure recovery; subsequent writers await it before touching disk. */
  recovering: Promise<void> | null;
  writes: Map<symbol, { filePath: string; bytes: number; reserved: boolean }>;
  /** Changes on reservations and deferred write settlement so walks reject mixed snapshots. */
  writeGeneration: number;
  /** A mixed write/measurement snapshot needs one clean re-measurement after writers settle. */
  refreshDeferred: boolean;
  /** Last stable per-run sizes; request-time recovery remeasures FIFO candidates on demand. */
  runBytesByPath: Map<string, number>;
  /** False when the per-run index does not cover a stable, complete workspace measurement. */
  runBytesValid: boolean;
  /** Last observed/persisted shared-state revision; gates reuse of this process's run index. */
  sharedUpdatedAt: number | null;
}

/** Per-process cached usage per workspace (WI-10004513). Pinned so a split module record can't
 *  fork it into two caches that each under-count. */
const usageState = pinModuleState('@papercusp/operator-core.scratch-gc.usage', () => ({
  byWorkspace: new Map<string, ScratchUsageEntry>(),
  sharedStatePaths: new Set<string>(),
}));
usageState.sharedStatePaths ??= new Set<string>();

function usageEntry(workspaceId: string): ScratchUsageEntry {
  let entry = usageState.byWorkspace.get(workspaceId);
  if (!entry) {
    entry = {
      bytes: 0, measuredAt: 0, refreshing: null, refreshDiagnostics: null,
      recovering: null, writes: new Map(),
      writeGeneration: 0, refreshDeferred: false, runBytesByPath: new Map(), runBytesValid: false,
      sharedUpdatedAt: null,
    };
    usageState.byWorkspace.set(workspaceId, entry);
  } else {
    // The cache is module-pinned across HMR. Initialize fields added by newer module versions.
    entry.refreshDiagnostics ??= null;
    entry.recovering ??= null;
    entry.writes ??= new Map();
    entry.writeGeneration ??= 0;
    entry.refreshDeferred ??= false;
    entry.runBytesByPath ??= new Map();
    entry.runBytesValid ??= false;
    entry.sharedUpdatedAt ??= null;
  }
  return entry;
}

function scratchRunDirForFile(workspaceId: string, filePath: string): string | null {
  const root = scratchRootForWorkspace(workspaceId);
  const prefix = `${root}${sep}`;
  if (!filePath.startsWith(prefix)) return null;
  const parts = filePath.slice(prefix.length).split(sep);
  // Scratch writers store files below <workspace>/<tool>/<runId>/.
  if (parts.length < 3 || !parts[0] || !parts[1]) return null;
  return join(root, parts[0], parts[1]);
}

function adjustCachedRunBytes(
  entry: ScratchUsageEntry,
  workspaceId: string,
  filePath: string,
  delta: number,
): void {
  if (!entry.runBytesValid) return;
  const runDir = scratchRunDirForFile(workspaceId, filePath);
  if (!runDir) {
    entry.runBytesValid = false;
    return;
  }
  const next = (entry.runBytesByPath.get(runDir) ?? 0) + delta;
  if (next <= 0) entry.runBytesByPath.delete(runDir);
  else entry.runBytesByPath.set(runDir, next);
}

function scheduleDeferredUsageRefresh(workspaceId: string, entry: ScratchUsageEntry): void {
  if (!entry.refreshDeferred || entry.writes.size > 0 || entry.refreshing) return;
  entry.refreshDeferred = false;
  void refreshScratchUsage(workspaceId).catch(() => {});
}

/** The same FIFO phase serves the daily sweep and request-time async quota recovery. */
async function evictWorkspaceQuotaLocked(
  workspaceId: string,
  targetBytes: () => number,
  reconcileReservations = false,
  diagnostics?: ScratchQuotaRecoveryDiagnostics,
  now: () => number = Date.now,
): Promise<{
  used: number; evictions: number; bytes: number;
}> {
  const wsRoot = scratchRootForWorkspace(workspaceId);
  const entry = usageEntry(workspaceId);
  const writeGeneration = entry.writeGeneration;
  const hadActiveWrites = [...entry.writes.values()].some((write) => write.reserved);
  // Request-time recovery blocks new reservations until this walk finishes. Keep references
  // to existing writers even if they complete during the walk, and account only for bytes
  // the walk did not see. Retaining the old cache here would retain other hosts' deleted runs
  // and falsely refuse every spill while a writer is active.
  const writers = reconcileReservations ? [...entry.writes.values()].filter((write) => write.reserved) : [];
  const observedWriterBytes = new Map(writers.map((write) => [write.filePath, 0]));
  let useCachedRunSizes = reconcileReservations && entry.runBytesValid && !entry.refreshDeferred;
  let entryBytesAtStart = entry.bytes;
  let runs: Array<{ dir: string; mtimeMs: number }> | null = null;
  let cacheChanged = false;
  let newlyDiscoveredRunBytes = 0;
  // Keep a full-walk index for background refreshes and for the conservative fallback when no
  // stable per-run measurement exists. Request-time recovery uses the stable index instead.
  const runBytesByPath = new Map<string, number>();
  let used: number;
  if (useCachedRunSizes) {
    const runListingStartedAt = performance.now();
    runs = await runDirsOf(wsRoot, diagnostics);
    if (diagnostics) {
      diagnostics.runListingMs += Math.max(0, performance.now() - runListingStartedAt);
      diagnostics.runsListed += runs.length;
    }
    if (!entry.runBytesValid || entry.refreshDeferred) {
      // A synchronous reservation may have invalidated the index while the directory listing
      // yielded. Without a complete stable index, keep the conservative full measurement.
      useCachedRunSizes = false;
      runs = null;
    } else {
      const unindexedRuns = runs.filter((run) => !entry.runBytesByPath.has(run.dir));
      if (unindexedRuns.length > 0) {
        const measuredRuns = new Map<string, number>();
        let canMeasureIncrementally = true;
        for (const run of unindexedRuns) {
          let stats;
          try {
            stats = await measureScratchQuotaRecoveryOperation(
              diagnostics,
              'stat',
              () => lstatAsync(run.dir),
            );
          } catch {
            canMeasureIncrementally = false;
            break;
          }
          // The full workspace walk counts a run-directory symlink as one entry and does not
          // traverse its target. Preserve that conservative behavior for any newly discovered
          // symlink or path that changed type while the listing yielded.
          if (stats.isSymbolicLink() || !stats.isDirectory()) {
            canMeasureIncrementally = false;
            break;
          }
          measuredRuns.set(
            run.dir,
            await sizeOfDirAsync(run.dir, undefined, undefined, 0, undefined, diagnostics),
          );
        }
        if (!canMeasureIncrementally || !entry.runBytesValid || entry.refreshDeferred) {
          // If the index changed during incremental sizing, discard the partial measurements and
          // rebuild from the workspace root. This also handles unreadable or vanished new paths.
          useCachedRunSizes = false;
          runs = null;
        } else {
          for (const [runDir, bytes] of measuredRuns) {
            entry.runBytesByPath.set(runDir, bytes);
            newlyDiscoveredRunBytes += bytes;
          }
          // Cross-process growth changed the index. Re-measure it after this recovery settles.
          cacheChanged = true;
        }
      }
    }
  }
  if (useCachedRunSizes && runs) {
    const liveRuns = new Set(runs.map((run) => run.dir));
    used = entry.bytes + newlyDiscoveredRunBytes;
    entryBytesAtStart = entry.bytes;
    for (const [runDir, cachedBytes] of entry.runBytesByPath) {
      if (liveRuns.has(runDir)) continue;
      // Another process may have already reclaimed this run. Correct the stale total before
      // deciding how much FIFO eviction is still needed.
      if ([...entry.writes.values()].some((write) => write.filePath.startsWith(runDir + sep))) continue;
      used -= cachedBytes;
      entry.runBytesByPath.delete(runDir);
      cacheChanged = true;
    }
    used = Math.max(0, used);
    if (runs.some((run) => !entry.runBytesByPath.has(run.dir))) cacheChanged = true;
  } else {
    const sizeWalkStartedAt = performance.now();
    try {
      used = await sizeOfDirAsync(wsRoot, observedWriterBytes, runBytesByPath, 0, undefined, diagnostics);
    } finally {
      if (diagnostics) diagnostics.sizeWalkMs += Math.max(0, performance.now() - sizeWalkStartedAt);
    }
  }
  let evictions = 0;
  let bytes = 0;
  const evictedRuns: string[] = [];
  if (used > targetBytes()) {
    if (!runs) {
      const runListingStartedAt = performance.now();
      runs = await runDirsOf(wsRoot, diagnostics);
      if (diagnostics) {
        diagnostics.runListingMs += Math.max(0, performance.now() - runListingStartedAt);
        diagnostics.runsListed += runs.length;
      }
    }
    runs.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const run of runs) {
      if (used <= targetBytes()) break;
      if (diagnostics) diagnostics.runsConsidered += 1;
      // A current or waiting write owns its run even when its reservation has not landed yet.
      if ([...entry.writes.values()].some((write) => write.filePath.startsWith(run.dir + sep))) continue;
      // Symlinked tool/run directories are discovered by runDirsOf but are not traversed by
      // the workspace size walk; retain the old fallback for those paths.
      const runSizingStartedAt = performance.now();
      let bytesInRun: number;
      try {
        if (useCachedRunSizes) {
          const cachedBytes = entry.runBytesByPath.get(run.dir) ?? 0;
          // Recheck only the FIFO candidates we may delete. This catches cross-process changes
          // to those runs without recursively sizing every run in the workspace.
          bytesInRun = await sizeOfDirAsync(run.dir, observedWriterBytes, undefined, 0, undefined, diagnostics);
          if (bytesInRun !== cachedBytes) cacheChanged = true;
          used += bytesInRun - cachedBytes;
          entry.runBytesByPath.set(run.dir, bytesInRun);
        } else {
          const indexedBytes = runBytesByPath.get(run.dir);
          if (indexedBytes === undefined && diagnostics) diagnostics.fallbackRunSizes += 1;
          bytesInRun = indexedBytes ?? await sizeOfDirAsync(run.dir, undefined, undefined, 0, undefined, diagnostics);
          if (indexedBytes === undefined) runBytesByPath.set(run.dir, bytesInRun);
        }
      } finally {
        if (diagnostics) diagnostics.selectedRunSizingMs += Math.max(0, performance.now() - runSizingStartedAt);
      }
      // A writer can join while candidate sizing yields. Preserve its run just as we do for
      // writers already present when the candidate was selected.
      if ([...entry.writes.values()].some((write) => write.filePath.startsWith(run.dir + sep))) continue;
      // The cached total may already be under target once a candidate's stale size is corrected.
      if (used <= targetBytes()) break;
      if (diagnostics) diagnostics.deleteAttempts += 1;
      const deletionStartedAt = performance.now();
      try {
        if (!(await removeUnpinnedScratchPath(run.dir))) continue;
      } finally {
        if (diagnostics) diagnostics.deletionMs += Math.max(0, performance.now() - deletionStartedAt);
      }
      used -= bytesInRun;
      evictedRuns.push(run.dir);
      if (useCachedRunSizes) entry.runBytesByPath.delete(run.dir);
      else runBytesByPath.delete(run.dir);
      evictions += 1;
      bytes += bytesInRun;
      if (diagnostics) {
        diagnostics.runsDeleted += 1;
        diagnostics.deletedBytes += bytesInRun;
      }
      evictedBytesTotal += bytesInRun;
    }
  }
  const activeWritesAtEnd = [...entry.writes.values()].some((write) => write.reserved);
  const overlappingWrites = hadActiveWrites || activeWritesAtEnd || entry.writeGeneration !== writeGeneration;
  if (reconcileReservations) {
    if (useCachedRunSizes) {
      // The cached total already includes all local reservations. Preserve concurrent settlement
      // deltas if a writer completed while the candidate paths were being remeasured.
      entry.bytes = Math.max(0, overlappingWrites ? entry.bytes + used - entryBytesAtStart : used);
    } else {
      entry.bytes = used + writers.reduce((sum, write) => {
        // A failed writer drops its reservation; a completed writer's run may have been evicted.
        if (!write.reserved || evictedRuns.some((run) => write.filePath.startsWith(run + sep))) return sum;
        return sum + Math.max(0, write.bytes - (observedWriterBytes.get(write.filePath) ?? 0));
      }, 0);
    }
    entry.measuredAt = now();
    entry.refreshDeferred = overlappingWrites || cacheChanged;
    if (useCachedRunSizes) {
      entry.runBytesValid = !entry.refreshDeferred;
    } else if (overlappingWrites) {
      entry.runBytesValid = false;
    } else {
      entry.runBytesByPath = runBytesByPath;
      entry.runBytesValid = [...runBytesByPath.values()].every(Number.isFinite)
        && (!diagnostics || (diagnostics.directoryReadErrors === 0 && diagnostics.fileStatErrors === 0));
    }
  } else if (overlappingWrites) {
    // The size walk may have included only part of an in-flight write. Adjust the prior
    // reservation-based total by exactly the bytes evicted, then re-measure once writers settle.
    entry.bytes = Math.max(0, entry.bytes - bytes);
    entry.refreshDeferred = true;
    entry.runBytesValid = false;
  } else {
    entry.bytes = used;
    entry.measuredAt = now();
    entry.refreshDeferred = false;
    entry.runBytesByPath = runBytesByPath;
    entry.runBytesValid = [...runBytesByPath.values()].every(Number.isFinite)
      && (!diagnostics || (diagnostics.directoryReadErrors === 0 && diagnostics.fileStatErrors === 0));
  }
  scheduleDeferredUsageRefresh(workspaceId, entry);
  return { used, evictions, bytes };
}

async function evictWorkspaceQuotaWithLock(
  workspaceId: string,
  targetBytes: () => number,
  diagnostics?: ScratchQuotaRecoveryDiagnostics,
  now: () => number = Date.now,
): Promise<{ used: number; evictions: number; bytes: number }> {
  return withScratchWorkspaceDataMutex(workspaceId, 'quota-eviction', () =>
    withScratchWorkspaceMutex(workspaceId, 'quota-eviction', async () => {
      const entry = usageEntry(workspaceId);
      entry.runBytesByPath.clear();
      entry.runBytesValid = false;
      entry.refreshDeferred = false;
      const reclaimed = await evictWorkspaceQuotaLocked(workspaceId, targetBytes, false, diagnostics, now);
      await writeSharedScratchQuotaState(workspaceId, entry.bytes, entry.measuredAt || Date.now());
      return reclaimed;
    }));
}

const SCRATCH_SIZE_SCAN_MAX_IN_FLIGHT = 2;
let scratchSizeScanInFlight = 0;
const scratchSizeScanWaiters: Array<() => void> = [];

async function withScratchSizeScanSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (scratchSizeScanInFlight < SCRATCH_SIZE_SCAN_MAX_IN_FLIGHT) {
    scratchSizeScanInFlight += 1;
  } else {
    await new Promise<void>((resolve) => scratchSizeScanWaiters.push(resolve));
  }
  try {
    return await operation();
  } finally {
    const next = scratchSizeScanWaiters.shift();
    if (next) next(); // transfer the held slot directly to the next queued filesystem operation
    else scratchSizeScanInFlight -= 1;
  }
}

/**
 * Measure a directory tree asynchronously with a process-wide I/O bound. A single walk visits
 * entries sequentially so operation timing identifies the active filesystem operation; concurrent
 * workspace walks still share the bound, and the walk never blocks the event loop.
 */
async function sizeOfDirAsync(
  dir: string,
  observedFileBytes?: Map<string, number>,
  runBytesByPath?: Map<string, number>,
  depth = 0,
  runDir?: string,
  diagnostics?: ScratchQuotaRecoveryDiagnostics,
  budget?: ScratchGcBudget,
): Promise<number> {
  if (scratchGcBudgetExpired(budget)) return 0;
  if (diagnostics) diagnostics.sizeWalkDirectories += 1;
  let entries;
  try {
    entries = await withScratchSizeScanSlot(() =>
      measureScratchQuotaRecoveryOperation(diagnostics, 'readdir', () =>
        readdirAsync(dir, { withFileTypes: true }),
      ),
    );
    scratchGcBudgetExpired(budget);
  } catch (error) {
    if (scratchFsErrorCode(error) === 'ENOENT') return 0; // an absent or concurrently removed directory is empty
    if (diagnostics) {
      diagnostics.directoryReadErrors += 1;
      rememberScratchSizeWalkErrorCode(diagnostics, error);
    }
    return 0; // unreadable — the caller sees the diagnostic and rejects an incomplete measurement
  }
  if (diagnostics) diagnostics.sizeWalkEntries += entries.length;
  let total = 0;
  for (const entry of entries) {
    if (scratchGcBudgetExpired(budget)) break;
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Scratch run directories are exactly the directory level below each tool directory.
      // Record their totals as this normal size walk visits files, so FIFO recovery can reuse
      // them without a second recursive stat pass.
      const childRunDir = runBytesByPath && depth === 1 ? child : runDir;
      if (runBytesByPath && depth === 1) runBytesByPath.set(child, 0);
      const childBytes = await sizeOfDirAsync(child, observedFileBytes, runBytesByPath, depth + 1, childRunDir, diagnostics, budget);
      total += childBytes;
    } else {
      if (runBytesByPath && depth <= 1 && entry.isSymbolicLink()) {
        // The workspace walk counts symlinks as entries rather than traversing them. A
        // per-run index cannot safely represent a symlinked tool/run directory.
        runBytesByPath.set(child, Number.NaN);
      }
      if (diagnostics) diagnostics.sizeWalkFiles += 1;
      try {
        const bytes = (await withScratchSizeScanSlot(() =>
          measureScratchQuotaRecoveryOperation(diagnostics, 'stat', () => statAsync(child)),
        )).size;
        total += bytes;
        if (observedFileBytes?.has(child)) observedFileBytes.set(child, bytes);
        if (runDir && runBytesByPath) {
          runBytesByPath.set(runDir, (runBytesByPath.get(runDir) ?? 0) + bytes);
        }
      } catch (error) {
        if (scratchFsErrorCode(error) === 'ENOENT') continue; // removed after readdir; it no longer consumes quota
        if (diagnostics) {
          diagnostics.fileStatErrors += 1;
          rememberScratchSizeWalkErrorCode(diagnostics, error);
        }
        /* Other stat failures make the measurement incomplete. */
      }
    }
  }
  return total;
}

/**
 * Bytes AND the newest mtime anywhere in a tree, the root included, in one sequential async walk.
 * lstat throughout: a symlink is judged by itself, never by what it points at. A missing or
 * unreadable tree reports { bytes: 0, newestMtimeMs: 0 } (nothing recent in it).
 */
async function treeStatsAsync(
  dir: string,
  budget?: ScratchGcBudget,
): Promise<{ bytes: number; newestMtimeMs: number; truncated: boolean }> {
  if (scratchGcBudgetExpired(budget)) return { bytes: 0, newestMtimeMs: 0, truncated: true };
  let newestMtimeMs = 0;
  let bytes = 0;
  try {
    newestMtimeMs = (await lstatAsync(dir)).mtimeMs;
  } catch {
    return { bytes: 0, newestMtimeMs: 0, truncated: false };
  }
  for (const name of await listDir(dir, undefined, budget)) {
    if (scratchGcBudgetExpired(budget)) return { bytes, newestMtimeMs, truncated: true };
    const child = join(dir, name);
    let st;
    try {
      st = await lstatAsync(child);
    } catch {
      continue; // vanished mid-walk
    }
    if (st.isDirectory()) {
      const sub = await treeStatsAsync(child, budget);
      bytes += sub.bytes;
      if (sub.newestMtimeMs > newestMtimeMs) newestMtimeMs = sub.newestMtimeMs;
      if (sub.truncated) return { bytes, newestMtimeMs, truncated: true };
    } else {
      bytes += st.size;
      if (st.mtimeMs > newestMtimeMs) newestMtimeMs = st.mtimeMs;
    }
  }
  return { bytes, newestMtimeMs, truncated: false };
}

/**
 * Re-measure a workspace's scratch usage in the background and replace the cached total.
 * When the tree approaches the hard quota, this same walk also evicts oldest runs to restore
 * headroom. Concurrent callers share the one in-flight measurement. Exported for tests and for
 * any host that wants to warm the cache.
 */
export function refreshScratchUsage(workspaceId: string, now: () => number = Date.now): Promise<void> {
  const entry = usageEntry(workspaceId);
  if (entry.refreshing) return entry.refreshing;
  const diagnostics = newScratchQuotaRecoveryDiagnostics();
  entry.refreshDiagnostics = diagnostics;
  const targetBytes = WORKSPACE_QUOTA_BYTES - SCRATCH_QUOTA_RECOVERY_HEADROOM_BYTES;
  const run = (async () => {
    try {
      const sharedAtStart = await readSharedScratchQuotaState(workspaceId);
      // A known over-target cache needs immediate quota recovery. Keep that destructive walk
      // inside the workspace mutex so no writer can reserve a path while FIFO candidates are
      // being measured or deleted.
      if (entry.bytes > targetBytes || (sharedAtStart && sharedAtStart.bytes > targetBytes)) {
        await evictWorkspaceQuotaWithLock(workspaceId, () => targetBytes, diagnostics, now);
        return;
      }

      // A below-target refresh is read-only until its result is reconciled. Let it overlap a
      // writer so an ordinary size walk does not hold the quota mutex for the whole tree. The
      // shared ledger timestamp and local generation reject a mixed snapshot before it can
      // replace a concurrent reservation.
      const writeGeneration = entry.writeGeneration;
      const hasReservedWrites = () => [...entry.writes.values()].some((write) => write.reserved);
      const runBytesByPath = new Map<string, number>();
      const sizeWalkStartedAt = performance.now();
      let measuredBytes: number;
      try {
        measuredBytes = await sizeOfDirAsync(
          scratchRootForWorkspace(workspaceId),
          undefined,
          runBytesByPath,
          0,
          undefined,
          diagnostics,
        );
      } finally {
        diagnostics.sizeWalkMs += Math.max(0, performance.now() - sizeWalkStartedAt);
      }
      if (diagnostics.directoryReadErrors > 0 || diagnostics.fileStatErrors > 0) {
        throw incompleteScratchQuotaMeasurementError(workspaceId, diagnostics);
      }
      // An unreserved writer is only queued for the mutex and has not changed the tree. It is
      // safe to publish this measurement while it waits; a reservation or settled write changes
      // writeGeneration, and a currently reserved write may still be changing its file.
      if (hasReservedWrites() || entry.writeGeneration !== writeGeneration) {
        entry.refreshDeferred = true;
        entry.runBytesValid = false;
        return;
      }

      await withScratchWorkspaceDataMutex(workspaceId, 'usage-refresh-adopt', () =>
        withScratchWorkspaceMutex(workspaceId, 'usage-refresh-adopt', async () => {
          const sharedNow = await readSharedScratchQuotaState(workspaceId);
          const sharedChanged = (sharedNow?.updatedAt ?? null) !== (sharedAtStart?.updatedAt ?? null);
          if (hasReservedWrites() || entry.writeGeneration !== writeGeneration || sharedChanged) {
            entry.runBytesValid = false;
            if (hasReservedWrites() || entry.writeGeneration !== writeGeneration || !sharedNow) {
              entry.refreshDeferred = true;
            }
            if (sharedNow) {
              entry.bytes = sharedNow.bytes;
              entry.measuredAt = sharedNow.measuredAt;
              if (sharedNow.bytes > targetBytes) entry.refreshDeferred = true;
            }
            return;
          }

          entry.bytes = measuredBytes;
          entry.measuredAt = now();
          entry.refreshDeferred = false;
          entry.runBytesByPath = runBytesByPath;
          entry.runBytesValid = [...runBytesByPath.values()].every(Number.isFinite);
          if (measuredBytes > targetBytes) {
            await evictWorkspaceQuotaLocked(workspaceId, () => targetBytes, true, diagnostics, now);
          }
          await writeSharedScratchQuotaState(workspaceId, entry.bytes, entry.measuredAt);
        }));
    } finally {
      entry.refreshDiagnostics = null;
      entry.refreshing = null;
      scheduleDeferredUsageRefresh(workspaceId, entry);
    }
  })();
  entry.refreshing = run;
  return run;
}

/** This process's current best-known usage total for a workspace (0 before any measurement). */
export function scratchUsageBytes(workspaceId: string): number {
  return usageState.byWorkspace.get(workspaceId)?.bytes ?? 0;
}

/** Test-only: seed a workspace's cached usage total (skips the measurement). */
export function _setScratchUsageForTests(
  workspaceId: string,
  bytes: number,
  measuredAt = Date.now(),
  preserveRunBytes = false,
): void {
  const entry = usageEntry(workspaceId);
  entry.bytes = bytes;
  entry.measuredAt = measuredAt;
  const path = sharedScratchQuotaStatePath(workspaceId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const updatedAt = Math.max(Date.now(), (entry.sharedUpdatedAt ?? 0) + 1);
  writeFileSync(path, JSON.stringify({
    version: SHARED_SCRATCH_QUOTA_STATE_VERSION,
    workspaceRoot: resolve(scratchRootForWorkspace(workspaceId)),
    bytes: Math.max(0, Math.trunc(bytes)),
    measuredAt,
    updatedAt,
  }) + '\n', { mode: 0o600 });
  entry.sharedUpdatedAt = updatedAt;
  if (!preserveRunBytes) {
    entry.runBytesByPath.clear();
    entry.runBytesValid = false;
  }
}

/** Test-only: forget every cached usage total. */
export function _resetScratchUsageForTests(): void {
  usageState.byWorkspace.clear();
  for (const path of usageState.sharedStatePaths) {
    try { rmSync(path, { force: true }); } catch { /* test cleanup only */ }
  }
  usageState.sharedStatePaths.clear();
}

/**
 * Single-write reservation. Throws ScratchQuotaError if writing
 * `bytes` would push the workspace past WORKSPACE_QUOTA_BYTES.
 * Caller is responsible for actually performing the write.
 * Doesn't reserve atomically — concurrent writes could race past
 * the quota by a small margin; acceptable for the chat-tool use
 * case (we're not transactional).
 *
 * O(1) and touches NO filesystem (WI-10004513, owner Avi 2026-10-01). It used to recompute usage
 * with a synchronous recursive readdir+stat of the whole workspace tree on EVERY spill write — ~70k
 * blocking syscalls at 17k run dirs, on the request worker's main thread. Under ext4 contention one
 * of those readdirs blocked >20s in D-state and the event-loop sentinel SIGKILLed the :3070 worker
 * with every in-flight MCP call (61 kills in 6h). It now checks a cached per-workspace total that a
 * background, non-blocking re-measure refreshes every USAGE_REFRESH_MS. Until the first measure
 * lands (just after boot) the total starts at 0, so only the single-write cap applies — the daily
 * runScratchGc quota eviction still bounds the tree.
 */
export function reserveScratchSpace(opts: {
  workspaceId: string;
  bytes: number;
  /** Pass the target so a stable per-run usage index can track this reservation. */
  filePath?: string;
}): void {
  if (opts.bytes < 0) {
    throw new ScratchQuotaError(`scratch reservation: bytes must be non-negative (got ${opts.bytes})`);
  }
  if (opts.bytes > WORKSPACE_QUOTA_BYTES) {
    throw new ScratchQuotaError(
      `scratch reservation: single write of ${opts.bytes} bytes exceeds workspace quota ${WORKSPACE_QUOTA_BYTES}`,
    );
  }
  const entry = usageEntry(opts.workspaceId);
  const trackedWrite = opts.filePath !== undefined
    && [...entry.writes.values()].some((write) => write.filePath === opts.filePath);
  const refreshDue = !entry.refreshing && !entry.refreshDeferred && Date.now() - entry.measuredAt >= USAGE_REFRESH_MS;
  const used = entry.bytes;
  if (used + opts.bytes > WORKSPACE_QUOTA_BYTES) {
    if (refreshDue) void refreshScratchUsage(opts.workspaceId).catch(() => {});
    throw new ScratchQuotaError(
      `scratch reservation: workspace ${opts.workspaceId} used ${used} + ${opts.bytes} > quota ${WORKSPACE_QUOTA_BYTES}`,
    );
  }
  entry.bytes = used + opts.bytes;
  entry.writeGeneration += 1;
  if (opts.filePath) adjustCachedRunBytes(entry, opts.workspaceId, opts.filePath, opts.bytes);
  else entry.runBytesValid = false;
  // Start after this reservation: only later reservations can invalidate the new walk.
  // Fire-and-forget keeps both accepted and rejected reservations free of filesystem waits.
  // An untracked synchronous writer will call noteScratchWriteSettled after touching disk; defer
  // its refresh until then so the measurement cannot snapshot a half-finished write.
  if (refreshDue && (!opts.filePath || trackedWrite)) void refreshScratchUsage(opts.workspaceId).catch(() => {});
}

/** Notify the usage cache after a synchronous scratch write has settled. */
export function noteScratchWriteSettled(workspaceId: string, needsRefresh = false): void {
  const entry = usageEntry(workspaceId);
  entry.writeGeneration += 1;
  if (needsRefresh || entry.refreshing) {
    entry.runBytesValid = false;
    entry.refreshDeferred = true;
  }
  if (entry.refreshDeferred) {
    scheduleDeferredUsageRefresh(workspaceId, entry);
    return;
  }
  if (!entry.runBytesValid || Date.now() - entry.measuredAt >= USAGE_REFRESH_MS) {
    void refreshScratchUsage(workspaceId).catch(() => {});
  }
}

/**
 * Deferred reference writes recover quota pressure via the existing asynchronous FIFO phase.
 * No synchronous tree scan, no quota increase, and no eviction for an impossible single write.
 * Active/waiting reference paths are protected; concurrent callers share one recovery.
 */
/** Per-write, disjoint elapsed phases. Recovery work belongs to its initiating writer;
 * other writers record the time awaiting that shared recovery as quotaWaitMs. */
export interface ScratchWriteTimings {
  quotaWaitMs: number;
  refreshWaitMs: number;
  quotaRecoveryMs: number;
  /** Awaited shared quota-state file reads, including the revision read before publication. */
  quotaStateReadMs?: number;
  /** Awaited publication I/O (parent mkdir, temp write, rename, and failed-temp cleanup). */
  quotaStatePublishMs?: number;
  /** Awaited workspace marker lstat probes used by the write path. */
  markerProbeMs?: number;
  /** Time queued behind this process's scratch mutex before filesystem mutex admission. */
  localMutexWaitMs?: number;
  /** fs-mutex setup, queueing, and reader-drain time through successful or timed-out admission. */
  fsMutexAdmissionMs?: number;
  /** Per-await details; these overlap their enclosing phase totals. Keys use bounded phase.subphase names. */
  awaitSubphaseTimingsMs?: Record<string, number>;
  writeMs: number;
  totalMs: number;
  /** Present when this write initiated an actual request-time quota-recovery scan. */
  quotaRecoveryDiagnostics?: ScratchQuotaRecoveryDiagnostics;
  /** Present only for the one-shot progress notification while a phase is still pending. */
  progress?: ScratchWriteProgress;
}

type ScratchQuotaRecoveryOperationKind = 'readdir' | 'stat';

export interface ScratchQuotaRecoveryDiagnostics {
  sizeWalkMs: number;
  sizeWalkDirectories: number;
  sizeWalkEntries: number;
  sizeWalkFiles: number;
  readdirOperations: number;
  statOperations: number;
  /** Sum of readdir/stat durations for this sequential size walk. */
  operationTotalMs: number;
  maxOperationMs: number;
  maxOperationKind: ScratchQuotaRecoveryOperationKind | null;
  currentOperationKind: ScratchQuotaRecoveryOperationKind | null;
  currentOperationElapsedMs: number;
  directoryReadErrors: number;
  fileStatErrors: number;
  runListingMs: number;
  runsListed: number;
  selectedRunSizingMs: number;
  runsConsidered: number;
  fallbackRunSizes: number;
  deletionMs: number;
  deleteAttempts: number;
  runsDeleted: number;
  deletedBytes: number;
}

function newScratchQuotaRecoveryDiagnostics(): ScratchQuotaRecoveryDiagnostics {
  return {
    sizeWalkMs: 0,
    sizeWalkDirectories: 0,
    sizeWalkEntries: 0,
    sizeWalkFiles: 0,
    readdirOperations: 0,
    statOperations: 0,
    operationTotalMs: 0,
    maxOperationMs: 0,
    maxOperationKind: null,
    currentOperationKind: null,
    currentOperationElapsedMs: 0,
    directoryReadErrors: 0,
    fileStatErrors: 0,
    runListingMs: 0,
    runsListed: 0,
    selectedRunSizingMs: 0,
    runsConsidered: 0,
    fallbackRunSizes: 0,
    deletionMs: 0,
    deleteAttempts: 0,
    runsDeleted: 0,
    deletedBytes: 0,
  };
}

const scratchSizeWalkErrorCodes = new WeakMap<ScratchQuotaRecoveryDiagnostics, string>();

function scratchFsErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function rememberScratchSizeWalkErrorCode(
  diagnostics: ScratchQuotaRecoveryDiagnostics,
  error: unknown,
): void {
  const code = scratchFsErrorCode(error);
  if (code && !scratchSizeWalkErrorCodes.has(diagnostics)) {
    scratchSizeWalkErrorCodes.set(diagnostics, code);
  }
}

function incompleteScratchQuotaMeasurementError(
  workspaceId: string,
  diagnostics: ScratchQuotaRecoveryDiagnostics,
): Error {
  const error = new Error('Unable to establish a complete shared scratch quota measurement for workspace ' + workspaceId);
  const code = scratchSizeWalkErrorCodes.get(diagnostics);
  if (code) Object.assign(error, { code });
  return error;
}

interface ActiveScratchQuotaRecoveryOperation {
  kind: ScratchQuotaRecoveryOperationKind;
  startedAt: number;
}

const activeScratchQuotaRecoveryOperations =
  new WeakMap<ScratchQuotaRecoveryDiagnostics, Map<number, ActiveScratchQuotaRecoveryOperation>>();
let nextScratchQuotaRecoveryOperationId = 0;

async function measureScratchQuotaRecoveryOperation<T>(
  diagnostics: ScratchQuotaRecoveryDiagnostics | undefined,
  kind: ScratchQuotaRecoveryOperationKind,
  operation: () => Promise<T>,
): Promise<T> {
  if (!diagnostics) return operation();

  if (kind === 'readdir') diagnostics.readdirOperations += 1;
  else diagnostics.statOperations += 1;

  const startedAt = performance.now();
  let active = activeScratchQuotaRecoveryOperations.get(diagnostics);
  if (!active) {
    active = new Map();
    activeScratchQuotaRecoveryOperations.set(diagnostics, active);
  }
  const operationId = ++nextScratchQuotaRecoveryOperationId;
  active.set(operationId, { kind, startedAt });

  try {
    return await operation();
  } finally {
    const elapsedMs = Math.max(0, performance.now() - startedAt);
    diagnostics.operationTotalMs += elapsedMs;
    if (elapsedMs > diagnostics.maxOperationMs) {
      diagnostics.maxOperationMs = elapsedMs;
      diagnostics.maxOperationKind = kind;
    }
    active.delete(operationId);
  }
}

function snapshotScratchQuotaRecoveryDiagnostics(
  diagnostics: ScratchQuotaRecoveryDiagnostics,
): ScratchQuotaRecoveryDiagnostics {
  const active = activeScratchQuotaRecoveryOperations.get(diagnostics);
  let current: ActiveScratchQuotaRecoveryOperation | undefined;
  for (const operation of active?.values() ?? []) {
    // Report the oldest active I/O operation so a long-running syscall stays visible
    // while later bounded work enters the same walk.
    if (!current || operation.startedAt < current.startedAt) current = operation;
  }
  return {
    ...diagnostics,
    currentOperationKind: current?.kind ?? null,
    currentOperationElapsedMs: current
      ? Math.max(0, performance.now() - current.startedAt)
      : 0,
  };
}

export interface ScratchWriteProgress {
  phase:
    | 'quota-wait'
    | 'usage-refresh-wait'
    | 'quota-recovery'
    | 'file-write'
    | ScratchWriteObservedAwaitPhase;
  subphase?: string;
  phaseElapsedMs: number;
  totalElapsedMs: number;
  bytes: number;
  pendingWrites: number;
  recoveryActive: boolean;
  refreshActive: boolean;
  mutexWaitOwner?: ScratchWriteMutexWaitOwner;
  quotaRecoveryDiagnostics?: ScratchQuotaRecoveryDiagnostics;
  usageRefreshDiagnostics?: ScratchQuotaRecoveryDiagnostics;
}

export interface ScratchWriteMutexWaitOwner {
  layer: 'process-local' | 'filesystem' | 'unknown';
  operation?: string;
  subsystem?: string;
  requestTraceId?: string;
  pid?: number;
  host?: string;
  startedAt?: string;
}

function scratchWriteMutexWaitOwner(owner: string): ScratchWriteMutexWaitOwner {
  try {
    const parsed = JSON.parse(owner) as Record<string, unknown>;
    const layer = parsed.layer === 'process-local' ? 'process-local' : 'filesystem';
    const intent = parsed.intent && typeof parsed.intent === 'object'
      ? parsed.intent as Record<string, unknown>
      : undefined;
    const operation = layer === 'process-local' ? parsed.operation : intent?.operation;
    const subsystem = intent?.subsystem;
    const requestTraceId = typeof parsed.requestTraceId === 'string'
      ? parsed.requestTraceId
      : intent?.requestTraceId;
    return {
      layer,
      ...(typeof operation === 'string' ? { operation: operation.slice(0, 100) } : {}),
      ...(typeof subsystem === 'string' ? { subsystem: subsystem.slice(0, 100) } : {}),
      ...(typeof requestTraceId === 'string'
        ? { requestTraceId: requestTraceId.slice(0, 120) }
        : {}),
      ...(Number.isSafeInteger(parsed.pid) ? { pid: parsed.pid as number } : {}),
      ...(typeof parsed.host === 'string' ? { host: parsed.host.slice(0, 120) } : {}),
      ...(typeof parsed.startedAt === 'string' ? { startedAt: parsed.startedAt.slice(0, 40) } : {}),
    };
  } catch {
    return { layer: 'unknown' };
  }
}

const SCRATCH_WRITE_PROGRESS_AFTER_MS = 5_000;
const SCRATCH_USAGE_REFRESH_REQUIRED = Symbol('scratch-usage-refresh-required');

export async function writeWithScratchQuota(
  opts: { workspaceId: string; filePath: string; bytes: number;
    requestTraceId?: string;
    /** Optional caller budget for quota-mutex admission. */
    mutexTimeoutMs?: number;
    captureSubphaseTimings?: boolean;
    onTiming?: (timings: ScratchWriteTimings) => void },
  write: (observeAwait: ScratchWriteAwaitObserver) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(opts.bytes) || opts.bytes < 0 || opts.bytes > WORKSPACE_QUOTA_BYTES) {
    throw new ScratchQuotaError('scratch reservation: invalid single write of ' + opts.bytes + ' bytes');
  }
  const entry = usageEntry(opts.workspaceId);
  const token = Symbol();
  const pending = { filePath: opts.filePath, bytes: opts.bytes, reserved: false };
  entry.writes.set(token, pending);
  const startedAt = performance.now();
  const timings: ScratchWriteTimings = {
    quotaWaitMs: 0,
    refreshWaitMs: 0,
    quotaRecoveryMs: 0,
    quotaStateReadMs: 0,
    quotaStatePublishMs: 0,
    markerProbeMs: 0,
    writeMs: 0,
    totalMs: 0,
    ...(opts.captureSubphaseTimings ? { awaitSubphaseTimingsMs: {} } : {}),
  };
  let activeRecoveryDiagnostics: ScratchQuotaRecoveryDiagnostics | undefined;
  let sharedMeasuredAt = Date.now();
  const timed = async (
    phase: 'quotaWaitMs' | 'refreshWaitMs' | 'quotaRecoveryMs' | 'writeMs',
    run: () => Promise<void>,
  ) => {
    const start = performance.now();
    const progressPhase = {
      quotaWaitMs: 'quota-wait',
      refreshWaitMs: 'usage-refresh-wait',
      quotaRecoveryMs: 'quota-recovery',
      writeMs: 'file-write',
    }[phase] as ScratchWriteProgress['phase'];
    const emitProgress = () => {
          const phaseElapsedMs = Math.max(0, performance.now() - start);
          try {
            opts.onTiming?.({
              ...timings,
              progress: {
                phase: progressPhase,
                phaseElapsedMs,
                totalElapsedMs: Math.max(0, performance.now() - startedAt),
                bytes: opts.bytes,
                pendingWrites: entry.writes.size,
                recoveryActive: Boolean(entry.recovering),
                refreshActive: Boolean(entry.refreshing),
                ...(phase === 'quotaRecoveryMs' && activeRecoveryDiagnostics
                  ? { quotaRecoveryDiagnostics: snapshotScratchQuotaRecoveryDiagnostics(activeRecoveryDiagnostics) }
                  : {}),
                ...(entry.refreshing && entry.refreshDiagnostics
                  ? { usageRefreshDiagnostics: snapshotScratchQuotaRecoveryDiagnostics(entry.refreshDiagnostics) }
                  : {}),
              },
            });
          } catch {
            // Diagnostics must never replace a write failure or invalidate a cursor.
          }
    };
    const progressTimeout = opts.onTiming && phase !== 'quotaRecoveryMs'
      ? setTimeout(emitProgress, SCRATCH_WRITE_PROGRESS_AFTER_MS)
      : undefined;
    const progressInterval = opts.onTiming && phase === 'quotaRecoveryMs'
      ? managedSetInterval('scratch-write-quota-recovery-progress', SCRATCH_WRITE_PROGRESS_AFTER_MS, emitProgress, {
          category: 'lifecycle', instanced: true, classification: 'timeout-reaper',
        })
      : undefined;
    (progressTimeout as { unref?: () => void } | undefined)?.unref?.();
    try {
      await run();
    } finally {
      if (progressTimeout) clearTimeout(progressTimeout);
      progressInterval?.stop();
      timings[phase] += Math.max(0, performance.now() - start);
    }
  };
  let succeeded = false;
  let reservedStatePersisted = false;
  const refreshWaitOwner = Boolean(entry.refreshing) &&
    [...entry.writes.keys()][0] === token;
  const lockWaitStartedAt = performance.now();
  let mutexWaitOwner: ScratchWriteMutexWaitOwner | undefined;
  const emitLockWaitProgress = () => {
    const refreshActive = Boolean(entry.refreshing);
    try {
      opts.onTiming?.({
        ...timings,
        progress: {
          phase: refreshActive && refreshWaitOwner ? 'usage-refresh-wait' : 'quota-wait',
          phaseElapsedMs: Math.max(0, performance.now() - lockWaitStartedAt),
          totalElapsedMs: Math.max(0, performance.now() - startedAt),
          bytes: opts.bytes,
          pendingWrites: entry.writes.size,
          recoveryActive: Boolean(entry.recovering) || refreshActive,
          refreshActive,
          ...(mutexWaitOwner ? { mutexWaitOwner } : {}),
          ...(refreshActive && entry.refreshDiagnostics
            ? { usageRefreshDiagnostics: snapshotScratchQuotaRecoveryDiagnostics(entry.refreshDiagnostics) }
            : {}),
        },
      });
    } catch {
      // Diagnostic callbacks must never alter the writer's quota outcome.
    }
  };
  const onMutexWaiting = opts.onTiming ? (info: { owner: string; elapsedMs: number }) => {
    mutexWaitOwner = scratchWriteMutexWaitOwner(info.owner);
    emitLockWaitProgress();
  } : undefined;
  const recordMutexWait = (info: {
    waitedMs: number;
    localWaitMs: number;
    fsMutexAdmissionMs: number;
    admissionSubphaseTimingsMs?: Record<string, number>;
  }) => {
    if (opts.captureSubphaseTimings) {
      timings.localMutexWaitMs = info.localWaitMs;
      timings.fsMutexAdmissionMs = info.fsMutexAdmissionMs;
      const subphases = timings.awaitSubphaseTimingsMs ??= {};
      for (const [name, elapsedMs] of Object.entries(info.admissionSubphaseTimingsMs ?? {})) {
        const key = `fs-mutex-admission.${name}`;
        subphases[key] = (subphases[key] ?? 0) + elapsedMs;
      }
    }
    if (refreshWaitOwner) timings.refreshWaitMs += info.waitedMs;
    else timings.quotaWaitMs += info.waitedMs;
  };
  const observeAwait: ScratchWriteAwaitObserver = async (phase, subphase, operation) => {
    const start = performance.now();
    const timingField: 'quotaStateReadMs' | 'quotaStatePublishMs' | 'markerProbeMs' | undefined = phase === 'quota-state-read'
      ? 'quotaStateReadMs'
      : phase === 'quota-state-publish'
        ? 'quotaStatePublishMs'
        : phase === 'marker-probe'
          ? 'markerProbeMs'
          : undefined;
    const emitProgress = () => {
      try {
        opts.onTiming?.({
          ...timings,
          progress: {
            phase,
            subphase,
            phaseElapsedMs: Math.max(0, performance.now() - start),
            totalElapsedMs: Math.max(0, performance.now() - startedAt),
            bytes: opts.bytes,
            pendingWrites: entry.writes.size,
            recoveryActive: Boolean(entry.recovering),
            refreshActive: Boolean(entry.refreshing),
            ...(mutexWaitOwner ? { mutexWaitOwner } : {}),
          },
        });
      } catch {
        // Diagnostic callbacks must never replace a write failure or invalidate a cursor.
      }
    };
    const progressTimeout = opts.onTiming
      ? setTimeout(emitProgress, SCRATCH_WRITE_PROGRESS_AFTER_MS)
      : undefined;
    (progressTimeout as { unref?: () => void } | undefined)?.unref?.();
    try {
      return await operation();
    } finally {
      if (progressTimeout) clearTimeout(progressTimeout);
      const elapsedMs = Math.max(0, performance.now() - start);
      if (timingField) timings[timingField] = (timings[timingField] ?? 0) + elapsedMs;
      if (opts.captureSubphaseTimings) {
        const subphases = timings.awaitSubphaseTimingsMs ??= {};
        const key = `${phase}.${subphase}`;
        subphases[key] = (subphases[key] ?? 0) + elapsedMs;
      }
    }
  };
  try {
    for (;;) {
      const outcome = await withScratchWorkspaceMutex(opts.workspaceId, 'write', async () => {
        const cachedState = await readSharedScratchQuotaState(opts.workspaceId, observeAwait);
        if (!cachedState) {
          // A whole-tree measurement can take seconds. Drop the mutex before starting the
          // existing shared refresh; it measures outside the lock and revalidates before publish.
          // With no ledger there is no safe cached total to reserve against, so the first writer
          // still waits for that measurement to establish the cross-process accounting base.
          return SCRATCH_USAGE_REFRESH_REQUIRED;
        }
        // A valid ledger is the cross-process reservation fence even when its measurement is old.
        // Waiting for a full-tree refresh here made every result-door spill inherit the scan's
        // unbounded filesystem latency (21–246s in production telemetry). The refresh runs after
        // this reservation and revalidates its shared revision before adopting any walk, so a
        // concurrent writer cannot be erased by the eventual reconciliation.
        const sharedStateStale = Date.now() - cachedState.updatedAt > USAGE_REFRESH_MS;
        const shared = {
          bytes: cachedState.bytes,
          measuredAt: cachedState.measuredAt,
          measured: false,
          updatedAt: cachedState.updatedAt,
        };
        sharedMeasuredAt = shared.measuredAt;
        adoptSharedScratchUsage(opts.workspaceId, shared.bytes, shared.updatedAt, !shared.measured);

        // A first reference write can create the workspace marker in addition to its payload. Count
        // that known file size in the reservation when this is a workspace/tool/run path.
        let markerBytes = 0;
        const markerPath = join(scratchRootForWorkspace(opts.workspaceId), WORKSPACE_SCRATCH_MARKER);
        if (scratchRunDirForFile(opts.workspaceId, opts.filePath)) {
          try {
            await observeAwait('marker-probe', 'before-reservation', () => lstatAsync(markerPath));
          } catch {
            markerBytes = Buffer.byteLength(workspaceScratchMarkerBody(opts.workspaceId));
          }
        }
        const reservationBytes = opts.bytes + markerBytes;
        pending.bytes = reservationBytes;

        if (entry.recovering) await timed('quotaWaitMs', () => entry.recovering!);
        try {
          reserveScratchSpace({
            workspaceId: opts.workspaceId,
            bytes: reservationBytes,
            filePath: opts.filePath,
          });
        } catch (err) {
          if (!(err instanceof ScratchQuotaError)) throw err;
          const startsRecovery = !entry.recovering;
          if (!entry.recovering) {
            entry.recovering = (async () => {
              // The shared total was just read under this workspace lock. A queued background
              // refresher runs after us, so waiting for it here would deadlock on our own lock.
              const waitingBytes = [...entry.writes.values()].reduce((sum, request) =>
                sum + (request.reserved ? 0 : request.bytes), 0);
              if (entry.bytes + waitingBytes <= WORKSPACE_QUOTA_BYTES) return;
              await timed('quotaRecoveryMs', async () => {
                const diagnostics = newScratchQuotaRecoveryDiagnostics();
                activeRecoveryDiagnostics = diagnostics;
                try {
                  await evictWorkspaceQuotaLocked(opts.workspaceId, () => Math.max(0,
                    WORKSPACE_QUOTA_BYTES - SCRATCH_QUOTA_RECOVERY_HEADROOM_BYTES -
                    [...entry.writes.values()].reduce((sum, request) => sum + request.bytes, 0)),
                  true, diagnostics);
                  await writeSharedScratchQuotaState(
                    opts.workspaceId, entry.bytes, entry.measuredAt, observeAwait,
                  );
                  sharedMeasuredAt = entry.measuredAt;
                } finally {
                  timings.quotaRecoveryDiagnostics = snapshotScratchQuotaRecoveryDiagnostics(diagnostics);
                  activeRecoveryDiagnostics = undefined;
                }
              });
            })().finally(() => { entry.recovering = null; });
          }
          if (startsRecovery) await entry.recovering;
          else await timed('quotaWaitMs', () => entry.recovering!);
          reserveScratchSpace({
            workspaceId: opts.workspaceId,
            bytes: reservationBytes,
            filePath: opts.filePath,
          }); // still full/protected/unreclaimable ⇒ explicit, bounded refusal
        }

        pending.reserved = true;
        try {
          // Publish the reservation before touching the payload. A process crash can leave a
          // conservative over-count, but never an under-count that admits another process past quota.
          await writeSharedScratchQuotaState(opts.workspaceId, entry.bytes, sharedMeasuredAt, observeAwait);
          reservedStatePersisted = true;
          await timed('writeMs', () => write(observeAwait));
          succeeded = true;

          if (markerBytes > 0) {
            try {
              await observeAwait('marker-probe', 'after-write', () => lstatAsync(markerPath));
            } catch {
              entry.bytes = Math.max(0, entry.bytes - markerBytes);
              pending.bytes -= markerBytes;
              adjustCachedRunBytes(entry, opts.workspaceId, opts.filePath, -markerBytes);
              await writeSharedScratchQuotaState(
                opts.workspaceId, entry.bytes, sharedMeasuredAt, observeAwait,
              ).catch(() => {});
            }
          }
        } catch (error) {
          if (pending.reserved && !succeeded) {
            entry.writeGeneration += 1;
            entry.bytes = Math.max(0, entry.bytes - pending.bytes);
            pending.reserved = false;
            adjustCachedRunBytes(entry, opts.workspaceId, opts.filePath, -pending.bytes);
            if (reservedStatePersisted) {
              // A failed write may have left a partial file. Remove the ledger so the next writer
              // measures the actual tree before making a quota decision.
              await removeSharedScratchQuotaState(opts.workspaceId).catch(() => {});
            }
          }
          throw error;
        }
        return sharedStateStale;
      }, onMutexWaiting, recordMutexWait, opts.requestTraceId, opts.mutexTimeoutMs, recordMutexWait);
      if (outcome === SCRATCH_USAGE_REFRESH_REQUIRED) {
        await timed('refreshWaitMs', () => refreshScratchUsage(opts.workspaceId));
        continue;
      }
      if (outcome === true) {
        // Keep stale-ledger reconciliation off the publication critical path. The current write
        // is still reserved in `entry.writes`, so scheduleDeferredUsageRefresh starts the walk
        // only after the payload settles and can no longer be mistaken for a complete snapshot.
        entry.refreshDeferred = true;
        entry.runBytesValid = false;
      }
      break;
    }
  } finally {
    entry.writes.delete(token);
    if (pending.reserved) entry.writeGeneration += 1;
    scheduleDeferredUsageRefresh(opts.workspaceId, entry);
    timings.totalMs = Math.max(0, performance.now() - startedAt);
    // Diagnostic observers must never replace a write failure or invalidate a readable cursor.
    try { opts.onTiming?.(timings); } catch { /* diagnostics only */ }
  }
}

/** Ensure the scratch directory chain exists for a (workspace, tool, run). */
export function ensureScratchRunDir(opts: {
  workspaceId: string;
  toolName: string;
  runId: string;
}): string {
  const dir = join(scratchRootForWorkspace(opts.workspaceId), opts.toolName, opts.runId);
  markNewWorkspaceScratchRootSync(opts.workspaceId, mkdirSync(dir, { recursive: true, mode: 0o700 }));
  return dir;
}

/* ─── GC scheduler ───────────────────────────────────────────────────── */

/**
 * Start the periodic GC sweep. Idempotent — calling twice is a no-op.
 * Hosts call this from instrumentation-node so it survives Next dev
 * HMR / module reloads.
 *
 * The workspace registry getter is passed in (not imported directly)
 * so this module stays free of any operator-side dependencies.
 */
// Legacy startScratchGcScheduler removed (dbos-scheduler-consolidation P-005): DBOS
// owns the schedule (periodic-workflows.ts `scratchGc`). `runScratchGc` above is the
// single-run tick that workflow calls.
