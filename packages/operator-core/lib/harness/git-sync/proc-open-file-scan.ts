/**
 * proc-open-file-scan.ts — "does any live process hold this file open?" over
 * Linux `/proc/<pid>/fd/*`, bounded in time and run in parallel (WI-10006519).
 *
 * git-sync asks this before it unlinks an aged `index.lock` / `config.lock`, and
 * before it trusts an index proof. Both callers used to walk /proc SERIALLY: one
 * awaited readdir/readlink per pid and per descriptor, about 7,000 pids and
 * several hundred thousand descriptors on the dev box. Every await needs its own
 * event-loop turn, so the walk's wall time is (operations x loop latency):
 *
 *   - 2.5-3.8 s in an idle probe process (measured 2026-10-06 16:27Z);
 *   - 34 s for two index proofs inside a loaded test process (fuserSeesOpenFile note);
 *   - about 10 minutes between the age check and the unlink inside the busy bg-host,
 *     07:37:30Z -> 07:47:46Z (WI-10006519 post 0). That gap held every papercusp
 *     commit behind an orphaned lock, and the check-then-act window it opened could
 *     unlink a DIFFERENT writer's lock created after the check.
 *
 * Here `concurrency` workers pull pids from one shared cursor, so the loop turns
 * the scan needs shrink by about that factor. A `deadlineMs` bounds the wall time,
 * and past it the scan answers `null` ("cannot tell"). Callers already treat
 * `null` as "fall back to another instrument, then assume held", so a slow host
 * keeps the lock rather than guessing. The first match stops every worker.
 */
import { readdir, readlink } from 'node:fs/promises';

/** Parallel workers. Each one keeps a readdir or readlink in flight, so 64
 *  workers need about 1/64 of the serial walk's event-loop turns. */
export const PROC_OPEN_FILE_SCAN_CONCURRENCY = 64;

/** Wall-time bound. Past it the scan answers null (unknown), never false. */
export const PROC_OPEN_FILE_SCAN_DEADLINE_MS = 30_000;

export interface ProcOpenFileScanOptions {
  /** Defaults to `/proc`. Tests point this at a fake tree. */
  procRoot?: string;
  concurrency?: number;
  deadlineMs?: number;
  now?: () => number;
}

export interface ProcOpenFileScanResult {
  /** true = some descriptor matched; false = PROVEN no match in a complete scan;
   *  null = no usable /proc, or the deadline passed before the scan finished. */
  held: boolean | null;
  pidsScanned: number;
  pidsTotal: number;
  elapsedMs: number;
  timedOut: boolean;
}

/**
 * Scan every `<procRoot>/<pid>/fd/*` symlink for a target that satisfies
 * `matches`. Pids or descriptors that disappear mid-scan, and pids this user
 * cannot inspect, are skipped: a process we cannot see cannot be holding the
 * lock on git-sync's behalf, which is the same contract the serial walk had.
 */
export async function scanProcForOpenFile(
  matches: (fdTarget: string) => boolean,
  opts: ProcOpenFileScanOptions = {},
): Promise<ProcOpenFileScanResult> {
  const procRoot = opts.procRoot ?? '/proc';
  const now = opts.now ?? Date.now;
  const started = now();
  const deadlineMs = opts.deadlineMs ?? PROC_OPEN_FILE_SCAN_DEADLINE_MS;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? PROC_OPEN_FILE_SCAN_CONCURRENCY));

  let pids: string[];
  try {
    pids = (await readdir(procRoot)).filter((n) => /^[0-9]+$/.test(n));
  } catch {
    return { held: null, pidsScanned: 0, pidsTotal: 0, elapsedMs: now() - started, timedOut: false };
  }
  if (pids.length === 0) {
    return { held: null, pidsScanned: 0, pidsTotal: 0, elapsedMs: now() - started, timedOut: false };
  }

  let cursor = 0;
  let scanned = 0;
  let found = false;
  let timedOut = false;

  const worker = async (): Promise<void> => {
    while (!found && !timedOut) {
      if (now() - started > deadlineMs) {
        timedOut = true;
        return;
      }
      const i = cursor++;
      if (i >= pids.length) return;
      const fdDir = `${procRoot}/${pids[i]}/fd`;
      let fds: string[];
      try {
        fds = await readdir(fdDir);
      } catch {
        scanned++;
        continue; // exited, or not ours to inspect
      }
      for (const fd of fds) {
        if (found || timedOut) return;
        try {
          if (matches(await readlink(`${fdDir}/${fd}`))) {
            found = true;
            return;
          }
        } catch {
          // descriptor closed between readdir and readlink
        }
      }
      scanned++;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, pids.length) }, worker));
  const elapsedMs = now() - started;
  if (found) return { held: true, pidsScanned: scanned, pidsTotal: pids.length, elapsedMs, timedOut };
  if (timedOut) return { held: null, pidsScanned: scanned, pidsTotal: pids.length, elapsedMs, timedOut };
  return { held: false, pidsScanned: scanned, pidsTotal: pids.length, elapsedMs, timedOut };
}
