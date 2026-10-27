// Bootstrap-safe cgroup readers. Native dependency snapshots call this before
// node_modules exists; keep this module limited to Node builtins.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Stable identity for the current unified cgroup; unreadable stays unknown. */
export function readTaskCgroupMemoryScope({ readFile = readFileSync,
  procCgroupPath = '/proc/self/cgroup' } = {}) {
  try {
    const path = String(readFile(procCgroupPath, 'utf8')).split(/\r?\n/)
      .find(line => line.startsWith('0::'))?.slice(3).trim();
    if (!path?.startsWith('/') || path.split('/').includes('..')) return null;
    return `cgroup:${path}`;
  } catch { return null; }
}

export function readTaskCgroupLimit(fileName, {
  readFile = readFileSync,
  procCgroupPath = '/proc/self/cgroup',
  cgroupRoot = '/sys/fs/cgroup',
} = {}) {
  try {
    const unified = String(readFile(procCgroupPath, 'utf8'))
      .split(/\r?\n/).find(line => line.startsWith('0::'));
    if (!unified) return null;
    const relative = unified.slice(3).trim().replace(/^\/+/, '');
    const raw = String(readFile(join(cgroupRoot, relative, fileName), 'utf8')).trim();
    if (!raw || raw === 'max') return null;
    return raw;
  } catch {
    return null;
  }
}

/** Read THIS task's memory.max. `max`/unreadable means unbounded. */
export function readTaskCgroupMemoryMaxMb(options = {}) {
  try {
    const raw = readTaskCgroupLimit('memory.max', options);
    if (raw == null) return null;
    const bytes = BigInt(raw);
    if (bytes < 0n) return null;
    return Number(bytes / (1024n * 1024n));
  } catch {
    return null;
  }
}
