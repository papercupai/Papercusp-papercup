/**
 * Lightweight home for green-checkpoint run-lock policy and probing.
 *
 * It uses Node built-ins only. Coordination and worker modules can read the lock
 * without importing release-checkpoint-launch.ts, whose larger static graph
 * reaches release-checkpoint-config.ts and its module-scope override SELECT.
 * Through coord/condition-object.ts that once put database I/O into every pot
 * tool module (WI-10005170; mug-kettle-tool-gate.test.ts, "P-010 import hygiene").
 *
 * Keep this in sync with green-checkpoint.ts's CHECKPOINT_LOCK_STALE_MS. The writer
 * reclaims a lock at this age even when its recorded PID still appears alive; the reader
 * must not continue presenting that same over-age lock as a measured in-flight run when no
 * contender has arrived to trigger the writer-side cleanup.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

export const CHECKPOINT_RUN_LOCK_STALE_MS = 190 * 60_000;

/** Keep the lock reader dependency-free so worker and coordination modules can use it
 * without importing the checkpoint launcher (which includes the full release graph). */
function checkpointRunLockDirMirror(logDir: string, root: string): string {
  let h = 0;
  for (let i = 0; i < root.length; i++) h = (h * 31 + root.charCodeAt(i)) >>> 0;
  return path.join(logDir, `.green-checkpoint-run-${h.toString(36)}.lock`);
}

function checkpointLogDirFromEnv(): string {
  return process.env.PAPERCUSP_CHECKPOINT_LOG_DIR ?? path.join(homedir(), '.papercusp', 'checkpoint-logs');
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function defaultReadLockOwner(lockDir: string): { pid?: number; startedAt?: string } | null {
  try {
    return JSON.parse(readFileSync(path.join(lockDir, 'owner.json'), 'utf8')) as { pid?: number; startedAt?: string };
  } catch {
    return null;
  }
}

function defaultReadProcessStartMs(pid: number): number | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commEnd = stat.lastIndexOf(')');
    if (commEnd < 0) return null;
    const fields = stat.slice(commEnd + 1).trim().split(/\s+/);
    const startTicks = Number(fields[19]);
    const uptimeSec = Number(readFileSync('/proc/uptime', 'utf8').trim().split(/\s+/)[0]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(uptimeSec)) return null;
    return Date.now() - uptimeSec * 1000 + (startTicks / 100) * 1000;
  } catch {
    return null;
  }
}

const PROCESS_START_AFTER_LOCK_TOLERANCE_MS = 5_000;

function checkRunLockHeld(
  root: string,
  pidAlive: (pid: number) => boolean = defaultPidAlive,
  readLockOwner: (lockDir: string) => { pid?: number; startedAt?: string } | null = defaultReadLockOwner,
  readProcessStartMs: (pid: number) => number | null = defaultReadProcessStartMs,
  checkpointLogDir: string = checkpointLogDirFromEnv(),
): { held: boolean; pid?: number | null; started_at?: string | null; elapsed_sec?: number | null } {
  const lockDir = checkpointRunLockDirMirror(checkpointLogDir, root);
  const owner = readLockOwner(lockDir);
  if (!owner || typeof owner.pid !== 'number' || !pidAlive(owner.pid)) return { held: false };
  const startedMs = owner.startedAt ? Date.parse(owner.startedAt) : NaN;
  if (Number.isFinite(startedMs)) {
    const ageMs = Date.now() - startedMs;
    if (ageMs > CHECKPOINT_RUN_LOCK_STALE_MS) return { held: false };
    const processStartedMs = readProcessStartMs(owner.pid);
    if (Number.isFinite(processStartedMs) && processStartedMs! > startedMs + PROCESS_START_AFTER_LOCK_TOLERANCE_MS) return { held: false };
  }
  const elapsedSec = Number.isFinite(startedMs) ? Math.max(0, Math.floor((Date.now() - startedMs) / 1000)) : null;
  return { held: true, pid: owner.pid, started_at: owner.startedAt ?? null, elapsed_sec: elapsedSec };
}

export function isCheckpointRunLockHeldCheap(
  root: string,
  pidAlive: (pid: number) => boolean = defaultPidAlive,
  readLockOwner: (lockDir: string) => { pid?: number; startedAt?: string } | null = defaultReadLockOwner,
  readProcessStartMs: (pid: number) => number | null = defaultReadProcessStartMs,
  checkpointLogDir: string = checkpointLogDirFromEnv(),
): { held: boolean; pid?: number; elapsedSec: number | null } {
  const r = checkRunLockHeld(root, pidAlive, readLockOwner, readProcessStartMs, checkpointLogDir);
  return r.held
    ? { held: true, pid: r.pid ?? undefined, elapsedSec: r.elapsed_sec ?? null }
    : { held: false, elapsedSec: null };
}
