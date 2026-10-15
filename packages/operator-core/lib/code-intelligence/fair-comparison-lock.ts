/**
 * One live `run` per arm per output directory.
 *
 * Two runs of the same arm share the arm's tree and its HOME (where engines
 * such as CodeGraphContext keep their graph database), so an overlap corrupts
 * both results. That happened on 2026-10-06: a detached runner was believed
 * dead after its ledger task ended, its HOME was moved aside, and a second
 * run was started; the first kept writing its write-ahead log into the new
 * HOME by path. Neither run could be scored.
 *
 * The lock is a file created with O_EXCL that records the holder's pid and its
 * kernel start time. A later run refuses while that exact process is alive.
 * A recorded pid that is gone, or that now belongs to a different process
 * (pid reuse), is stale and is replaced.
 */
import { readFileSync } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface ArmRunLockHolder {
  readonly pid: number;
  /** Field 22 of /proc/<pid>/stat (clock ticks since boot); null where unreadable. */
  readonly startTicks: string | null;
  readonly arm: string;
  readonly startedAt: string;
}

export interface ArmRunLockDeps {
  readonly pid: number;
  /** Start time of a live pid, or null when no such process exists. */
  readonly startTicksOf: (pid: number) => string | null;
  readonly now: () => Date;
}

export interface ArmRunLock {
  readonly path: string;
  release(): Promise<void>;
}

/** Field 22 (starttime) of /proc/<pid>/stat; the comm field may contain spaces, so parse after its closing paren. */
export function procStartTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // fields[0] is field 3 (state), so field 22 is fields[19].
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

export const defaultArmRunLockDeps: ArmRunLockDeps = {
  pid: process.pid,
  startTicksOf: procStartTicks,
  now: () => new Date(),
};

export function armRunLockPath(outDir: string, arm: string): string {
  return join(outDir, `${arm}.run.lock`);
}

function holderIsAlive(holder: ArmRunLockHolder, deps: ArmRunLockDeps): boolean {
  const ticks = deps.startTicksOf(holder.pid);
  if (ticks === null) return false;
  // A holder written without a start time cannot be told apart from pid reuse; treat a live pid as the holder.
  return holder.startTicks === null || holder.startTicks === ticks;
}

/**
 * Take the per-arm run lock or throw naming the live holder. A stale lock
 * (holder gone, or its pid reused by another process) is replaced.
 */
export async function acquireArmRunLock(outDir: string, arm: string, deps: ArmRunLockDeps = defaultArmRunLockDeps): Promise<ArmRunLock> {
  const path = armRunLockPath(outDir, arm);
  const mine: ArmRunLockHolder = { pid: deps.pid, startTicks: deps.startTicksOf(deps.pid), arm, startedAt: deps.now().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(path, 'wx');
      try {
        await fh.writeFile(JSON.stringify(mine));
      } finally {
        await fh.close();
      }
      return {
        path,
        async release() {
          // Remove only our own lock: a stale-lock takeover may have replaced it.
          const current = await readHolder(path);
          if (current && current.pid === mine.pid && current.startTicks === mine.startTicks) await rm(path, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = await readHolder(path);
      if (holder && holderIsAlive(holder, deps)) {
        throw new Error(
          `run refused: arm ${arm} is already running in ${outDir} (pid ${holder.pid}, started ${holder.startedAt}). ` +
            `Stop that process first; two runs of one arm share its tree and HOME and corrupt each other.`,
        );
      }
      await rm(path, { force: true });
    }
  }
  throw new Error(`run refused: could not take ${path} after replacing a stale lock (another run raced for it)`);
}

async function readHolder(path: string): Promise<ArmRunLockHolder | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ArmRunLockHolder>;
    if (typeof parsed.pid !== 'number') return null;
    return {
      pid: parsed.pid,
      startTicks: typeof parsed.startTicks === 'string' ? parsed.startTicks : null,
      arm: String(parsed.arm ?? ''),
      startedAt: String(parsed.startedAt ?? ''),
    };
  } catch {
    return null;
  }
}
