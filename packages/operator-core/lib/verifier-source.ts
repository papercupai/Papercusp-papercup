/** Compatibility seam for the shared built-ins-only archive verifier. */
export * from '@papercusp/test-config/verifier-source';

import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { readProcessIdentity } from '@papercusp/operator-core/lib/process-identity';
import { readProcessCgroupPath } from '@papercusp/operator-core/lib/task-manager/cgroup-read';
import { taskIdFromScopeUnit } from '@papercusp/operator-core/lib/task-manager/types';
import type { TaskRow } from './task-manager/types';

const TASK_RECEIPT = '.verifier-task.json';

/** Persist ownership before checkout/dependency preparation can block or be killed. */
export function writeVerifierTaskReceipt(owned: string, repoRoot: string, env: NodeJS.ProcessEnv): void {
  const taskId = env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID;
  if (!taskId) return; // A CLI outside the durable task plane retains normal finally cleanup.
  const processIdentity = readProcessIdentity(process.pid);
  if (!/^[A-Za-z0-9-]{1,100}$/.test(taskId) || !processIdentity)
    throw new Error('verifier task ownership cannot be established');
  // This is the payload's kernel membership, captured BEFORE the launcher's
  // asynchronous markSpawned write. Descendants retain the owning task scope.
  const kernelPath = readProcessCgroupPath(process.pid);
  const parts = kernelPath?.split('/') ?? [];
  const scopeIndex = parts.findIndex(part => taskIdFromScopeUnit(part) === taskId);
  const cgroupPath = scopeIndex > 0 ? parts.slice(0, scopeIndex + 1).join('/') : null;
  writeFileSync(join(owned, TASK_RECEIPT), JSON.stringify({
    schemaVersion: 'verifier-task-v1', taskId, repoRoot: realpathSync(repoRoot),
    pid: process.pid, processIdentity, cgroupPath,
  }) + '\n', { flag: 'wx', mode: 0o600 });
}

function processGone(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || readProcessIdentity(pid) !== null) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/** The existing terminal close retries IO failures before losing the live ledger row.
 * Only an empty/released confined task can own this destructive cleanup. */
export async function cleanupEndedVerifierDirectories(row: TaskRow): Promise<void> {
  if (row.class !== 'bash-job' || !row.cwd || !isAbsolute(row.cwd) || !row.scopeUnit) return;
  // All descendants are checked: the launcher may have exited before its payload.
  async function scopeEmpty(path: string): Promise<boolean> {
    try {
      if ((await readFile(join(path, 'cgroup.procs'), 'utf8')).trim()) return false;
      for (const entry of await readdir(path, { withFileTypes: true }))
        if (entry.isDirectory() && !(await scopeEmpty(join(path, entry.name)))) return false;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  }
  let repoRoot = resolve(row.cwd);
  while (!existsSync(join(repoRoot, '.git'))) {
    const parent = dirname(repoRoot);
    if (parent === repoRoot) return;
    repoRoot = parent;
  }
  repoRoot = await realpath(repoRoot);
  const scratch = join(repoRoot, '.papercusp', 'scratch');
  try {
    // Reject redirected scratch roots, receipts and owned directories.
    if ((await realpath(scratch)) !== scratch) return;
    for (const entry of await readdir(scratch, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^verifier-command-[A-Za-z0-9]+$/.test(entry.name)) continue;
      const owned = join(scratch, entry.name), receiptPath = join(owned, TASK_RECEIPT);
      let receipt;
      try {
        const info = await lstat(owned);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        if (!lstatSync(receiptPath).isFile() || lstatSync(receiptPath).isSymbolicLink()) continue;
        receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      } catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (receipt?.schemaVersion !== 'verifier-task-v1' || receipt.taskId !== row.taskId ||
          receipt.repoRoot !== repoRoot || typeof receipt.processIdentity !== 'string' ||
          !receipt.processIdentity || !processGone(receipt.pid)) continue;
      // A reserved unit alone is not proof of confinement. Only a pending row
      // may recover missing enrollment facts from this payload's kernel receipt.
      const scopePath = row.confined && row.cgroupPath ? row.cgroupPath
        : row.state === 'pending' && !row.cgroupPath && taskIdFromScopeUnit(row.scopeUnit) === row.taskId
          ? receipt.cgroupPath : null;
      if (typeof scopePath !== 'string' || !scopePath.startsWith('/') ||
          resolve(scopePath) !== scopePath || basename(scopePath) !== row.scopeUnit ||
          (scopePath === receipt.cgroupPath && !row.confined && !scopePath.includes('/papercusp.slice/'))) continue;
      const cgroup = resolve('/sys/fs/cgroup', '.' + scopePath);
      if (!cgroup.startsWith('/sys/fs/cgroup/')) continue;
      // Re-check the scope and path at the deletion boundary; never follow peer links.
      if (!(await scopeEmpty(cgroup)) || (await realpath(owned)) !== owned || !processGone(receipt.pid)) continue;
      await rm(owned, { recursive: true, force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
