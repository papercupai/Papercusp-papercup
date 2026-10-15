/**
 * WI-6554700010011963 — the IO half of the reaper's orphaned-sidecar class.
 *
 * A sidecar launched through resolveSidecarSpawnPlan carries
 * PAPERCUSP_DESKTOP_PARENT_PID in its environment. This module reads that
 * declaration from /proc, measures whether the declared parent is still the
 * process that launched the sidecar, and remembers when an orphan was first seen
 * so the pure decision (reaper.ts `decideSidecarOrphan`) can give the sidecar's
 * own in-process watch a grace window first.
 *
 * Every read is best-effort. A sidecar whose environment cannot be read returns
 * 'unreadable' (spared); one with no declared parent returns null (no contract,
 * never judged).
 */
import { readFileSync } from 'node:fs';
import { pinModuleState } from '@papercusp/module-singleton';
import { sidecarOrphanReason, type SidecarParentProbe } from './reaper';
import type { TaskRow } from './types';

export interface ProcReader {
  environ(pid: number): string | null;
  stat(pid: number): string | null;
  alive(pid: number): boolean;
}

export const nodeProcReader: ProcReader = {
  environ: (pid) => {
    try {
      return readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {
      return null;
    }
  },
  stat: (pid) => {
    try {
      return readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return null;
    }
  },
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
};

/** Field 22 (starttime) of /proc/<pid>/stat; comm may contain spaces and parens. */
export function startTicksFromStat(stat: string | null): number | null {
  if (!stat) return null;
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const n = Number(rest[19]);
  return Number.isFinite(n) ? n : null;
}

/** The declared parent pid from a NUL-separated environ blob, or null. */
export function declaredParentFromEnviron(environ: string): number | null {
  for (const entry of environ.split('\0')) {
    if (!entry.startsWith('PAPERCUSP_DESKTOP_PARENT_PID=')) continue;
    const n = Number(entry.slice('PAPERCUSP_DESKTOP_PARENT_PID='.length));
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/** Measure one sidecar's declared parent. */
export function probeSidecarParent(
  sidecarPid: number,
  proc: ProcReader = nodeProcReader,
): SidecarParentProbe | null | 'unreadable' {
  const environ = proc.environ(sidecarPid);
  if (environ === null) return proc.alive(sidecarPid) ? 'unreadable' : null;
  const declaredPid = declaredParentFromEnviron(environ);
  if (declaredPid === null) return null;
  const parentAlive = proc.alive(declaredPid);
  return {
    declaredPid,
    parentAlive,
    parentStartTicks: parentAlive ? startTicksFromStat(proc.stat(declaredPid)) : null,
    sidecarStartTicks: startTicksFromStat(proc.stat(sidecarPid)),
  };
}

const state = pinModuleState('@papercusp/operator-core.sidecar-orphan-first-seen', () => ({
  firstSeen: new Map<string, number>(),
}));

/**
 * Build the reaper's `sidecarOrphanFor` input for one pass. Rows that are no
 * longer orphaned (or no longer live) drop out of the first-seen map, so a
 * transient misread never accumulates toward a reap.
 */
export function sidecarOrphanForPass(
  liveSidecarRows: readonly TaskRow[],
  now: number,
  proc: ProcReader = nodeProcReader,
  firstSeen: Map<string, number> = state.firstSeen,
): (row: TaskRow) => { reason: string; firstObservedMs: number } | null | 'unreadable' {
  const verdicts = new Map<string, { reason: string; firstObservedMs: number } | null | 'unreadable'>();
  for (const row of liveSidecarRows) {
    const pid = row.pid ?? null;
    if (!pid || pid <= 0) {
      verdicts.set(row.taskId, null);
      continue;
    }
    const probe = probeSidecarParent(pid, proc);
    if (probe === null || probe === 'unreadable') {
      verdicts.set(row.taskId, probe);
      continue;
    }
    const reason = sidecarOrphanReason(probe);
    if (!reason) {
      verdicts.set(row.taskId, null);
      continue;
    }
    const first = firstSeen.get(row.taskId) ?? now;
    firstSeen.set(row.taskId, first);
    verdicts.set(row.taskId, { reason, firstObservedMs: first });
  }
  for (const taskId of [...firstSeen.keys()]) {
    const v = verdicts.get(taskId);
    if (!v || v === 'unreadable') firstSeen.delete(taskId);
  }
  return (row) => verdicts.get(row.taskId) ?? null;
}
