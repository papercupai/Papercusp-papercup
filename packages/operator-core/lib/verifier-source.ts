/** Compatibility seam for the shared built-ins-only archive verifier. */
export * from '@papercusp/test-config/verifier-source';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { lstat, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { linuxPgrpFromProcStat, linuxPpidFromProcStat, linuxProcessIdentityFromStat,
  linuxProcStateFromStat, readProcessIdentity } from '@papercusp/operator-core/lib/process-identity';
import { readProcessCgroupPath } from '@papercusp/operator-core/lib/task-manager/cgroup-read';
import { taskIdFromScopeUnit } from '@papercusp/operator-core/lib/task-manager/types';
import type { TaskRow } from './task-manager/types';

const TASK_RECEIPT = '.verifier-task.json';

type VerifierResource =
  | { id: string; kind: 'root' | 'binding'; path: string; retain?: string }
  | { id: string; kind: 'process'; pid: number; processIdentity: string; processGroup?: number };
type ResourceIdentity = { dev: number; ino: number; mode: number; target?: string; sha256?: string };
type InventoryResource = VerifierResource & { originalIdentity?: ResourceIdentity | null };
export type VerifierTeardownOutcome = 'success' | 'failure' | 'cancellation' | 'timeout' | 'interruption-recovery';
type InventoryHeader = { schemaVersion: 'verifier-resources-v1'; owner: string; deadlineEpochMs: number;
  custody: Record<string, unknown> };
type InventoryEvent = { sequence: number; previous: string; atMs: number; event: string;
  detail: unknown; sha256: string };
type InventoryObservation = { id: string; state: string; pid?: number; processIdentity?: string;
  identity?: ResourceIdentity | null; reason?: string };
type InventoryTerminal = { outcome: VerifierTeardownOutcome; deadlineEpochMs: number; deadlineExceeded: boolean;
  observations: InventoryObservation[]; survivors: string[]; sealed: boolean; status: string };
type InventoryHistoryAnchor = { byteLength: number; sha256: string; dev: number; ino: number };

function resourceIdentity(resource: VerifierResource): ResourceIdentity | null {
  if (resource.kind === 'process') throw new Error('process resources use kernel start identity');
  try {
    const info = lstatSync(resource.path);
    const identity = { dev: info.dev, ino: info.ino, mode: info.mode,
      ...(info.isSymbolicLink() ? { target: readlinkSync(resource.path) } : {}),
      ...(info.isFile() ? { sha256: createHash('sha256').update(readFileSync(resource.path)).digest('hex') } : {}) };
    const after = lstatSync(resource.path);
    for (const key of ['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs'] as const)
      assert.equal(after[key], info[key], 'inventory resource changed during observation');
    return identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Extend the external verifier receipt with a durable append-only inventory.
 * This is an observation/settlement guard, never authority to delete a resource
 * or to reconstruct an unknown parent. Recovery needs the ORIGINAL header. */
export function verifierResourceInventory(options: {
  path: string; owner: string; deadlineEpochMs: number; custody: Record<string, unknown>;
  now?: () => number; resume?: boolean; expectedHistory?: InventoryHistoryAnchor;
}) {
  const now = options.now ?? Date.now;
  assert.ok(options.owner && isAbsolute(options.path), 'inventory needs an owner and external absolute path');
  assert.ok(Number.isSafeInteger(options.deadlineEpochMs) && options.deadlineEpochMs > 0,
    'inventory needs the finite original teardown deadline');
  // JSON copies prevent a caller mutation from rewriting the original contract.
  const header: InventoryHeader = JSON.parse(JSON.stringify({ schemaVersion: 'verifier-resources-v1',
    owner: options.owner, deadlineEpochMs: options.deadlineEpochMs, custody: options.custody }));
  let bytes = '';
  const events: InventoryEvent[] = [];
  const resources = new Map<string, InventoryResource>();
  let sealed = false;
  let deadlineExceeded = false;
  let originalOutcome: VerifierTeardownOutcome | undefined;
  let lastAtMs = 0;
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const apply = (entry: InventoryEvent) => {
    if (entry.event === 'resource') {
      const resource = entry.detail as InventoryResource;
      assert.ok(!resources.has(resource.id), 'duplicate inventory resource');
      resources.set(resource.id, resource);
    }
    if (entry.event === 'reconciled') {
      const detail = entry.detail as { outcome: VerifierTeardownOutcome; deadlineExceeded: boolean; sealed: boolean };
      originalOutcome ??= detail.outcome;
      deadlineExceeded ||= detail.deadlineExceeded;
      sealed = detail.sealed;
    }
    lastAtMs = entry.atMs;
    events.push(entry);
  };
  if (options.resume) {
    const info = lstatSync(options.path);
    assert.ok(info.isFile() && !info.isSymbolicLink(), 'inventory is not a regular receipt');
    bytes = readFileSync(options.path, 'utf8');
    assert.ok(bytes.endsWith('\n'), 'inventory has an incomplete append; retain for recovery');
    const anchor = options.expectedHistory;
    assert.ok(anchor && Number.isSafeInteger(anchor.byteLength) && anchor.byteLength > 0,
      'inventory recovery needs independently retained history anchor');
    assert.ok(info.dev === anchor.dev && info.ino === anchor.ino && Buffer.byteLength(bytes) >= anchor.byteLength,
      'inventory recovery history anchor changed');
    assert.equal(createHash('sha256').update(Buffer.from(bytes).subarray(0, anchor.byteLength)).digest('hex'),
      anchor.sha256, 'inventory recovery history anchor changed');
    for (const line of bytes.trimEnd().split('\n')) {
      const entry: InventoryEvent = JSON.parse(line);
      const { sha256, ...unsigned } = entry;
      assert.ok(!sealed && entry.sequence === events.length && entry.previous === (events.at(-1)?.sha256 ?? ''),
        'inventory history is not append-only');
      assert.equal(sha256, digest(unsigned), 'inventory history digest changed');
      assert.ok(Number.isSafeInteger(entry.atMs) && entry.atMs >= lastAtMs, 'inventory clock regressed');
      if (events.length === 0) {
        assert.equal(entry.event, 'opened', 'inventory missing original header');
        assert.deepEqual(entry.detail, header, 'inventory original owner, custody or deadline changed');
      }
      apply(entry);
    }
  } else {
    assert.ok(now() < header.deadlineEpochMs, 'inventory opened after teardown deadline');
    writeFileSync(options.path, '', { flag: 'wx', mode: 0o600 });
  }
  const receiptIdentity = lstatSync(options.path);
  const append = (event: string, detail: unknown) => {
    assert.ok(!sealed, 'inventory already sealed');
    const actual = lstatSync(options.path);
    assert.ok(actual.isFile() && !actual.isSymbolicLink() && actual.dev === receiptIdentity.dev &&
      actual.ino === receiptIdentity.ino, 'inventory receipt replaced');
    assert.equal(readFileSync(options.path, 'utf8'), bytes, 'inventory history changed before append');
    const atMs = now();
    assert.ok(Number.isSafeInteger(atMs) && atMs >= lastAtMs, 'inventory clock regressed');
    const unsigned = { sequence: events.length, previous: events.at(-1)?.sha256 ?? '', atMs, event, detail };
    const entry = { ...unsigned, sha256: digest(unsigned) };
    const next = JSON.stringify(entry) + '\n';
    appendFileSync(options.path, next, { flag: 'a' });
    bytes += next;
    apply(entry);
  };
  if (!options.resume) append('opened', header);
  const record = (resource: VerifierResource) => {
    assert.ok(!sealed, 'inventory already sealed');
    assert.ok(['root', 'binding', 'process'].includes(resource.kind), 'invalid inventory resource kind');
    assert.ok(resource.id && !resources.has(resource.id), 'inventory resource needs a unique stable id');
    if (resource.kind === 'process') {
      assert.ok(Number.isSafeInteger(resource.pid) && resource.pid > 0 && resource.processIdentity &&
        (resource.processGroup === undefined || resource.processGroup === resource.pid),
      'inventory process needs original PID/start identity and its own group');
    } else {
      assert.ok(isAbsolute(resource.path) && resolve(resource.path) === resource.path,
        'inventory resource path must be absolute and normalized');
      // Receipts and retained resources must survive removal of an owned root.
      for (const existing of resources.values()) {
        if (existing.kind === 'process') continue;
        const contains = (a: string, b: string) => b === a || b.startsWith(a + '/');
        if (Boolean(existing.retain) !== Boolean(resource.retain))
          assert.ok(!contains(existing.path, resource.path) && !contains(resource.path, existing.path),
            'owned and retained inventory resources overlap');
      }
      if (!resource.retain)
        assert.ok(options.path !== resource.path && !options.path.startsWith(resource.path + '/'),
          'inventory receipt must survive owned-root removal');
    }
    const entry = JSON.parse(JSON.stringify(resource)) as InventoryResource;
    if (entry.kind !== 'process') entry.originalIdentity = resourceIdentity(entry);
    if (entry.kind !== 'process' && entry.retain)
      assert.ok(entry.originalIdentity, 'retained inventory resource is missing');
    append('resource', entry);
  };
  const discoverProcesses = async () => {
      const processes = [...resources.values()].filter(r => r.kind === 'process');
      if (processes.length) {
        assert.equal(process.platform, 'linux', 'recursive inventory census unavailable on this platform');
        const boot = await readFile('/proc/sys/kernel/random/boot_id', 'utf8');
        const census: { pid: number; parentPid: number | null; group: number | null; identity: string | null }[] = [];
        for (const name of await readdir('/proc')) {
          if (!/^\d+$/.test(name)) continue;
          try {
            const text = await readFile(`/proc/${name}/stat`, 'utf8');
            census.push({ pid: Number(name), parentPid: linuxPpidFromProcStat(text),
              group: linuxPgrpFromProcStat(text), identity: linuxProcessIdentityFromStat(boot, text) });
          } catch (error) {
            if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          }
        }
        const owned = new Set(processes.filter(p => census.some(row => row.pid === p.pid &&
          row.identity === p.processIdentity)).map(p => p.pid));
        const groups = new Set(processes.flatMap(p => p.processGroup === undefined ? [] : [p.processGroup]));
        // A reused leader cannot lend its group identity to a previous attempt.
        for (const process of processes)
          assert.ok(!census.some(row => row.pid === process.pid && row.identity !== process.processIdentity),
            'inventory process PID was reused; group custody unproven');
        let changed = true;
        while (changed) {
          changed = false;
          for (const row of census) if (!owned.has(row.pid) &&
            (groups.has(row.group!) || owned.has(row.parentPid!))) {
            assert.ok(row.identity, 'descendant start identity unverified');
            owned.add(row.pid); changed = true;
            const id = `process:${row.pid}:${row.identity}`;
            if (!processes.some(p => p.pid === row.pid && p.processIdentity === row.identity) && !resources.has(id))
              record({ id, kind: 'process', pid: row.pid, processIdentity: row.identity! });
          }
        }
      }
  };
  const inventory = {
    record,
    /** Retain this outside the journal in the existing task/checkpoint receipt.
     * Deriving an anchor from a log AFTER restart would trust a truncated history. */
    checkpoint(): InventoryHistoryAnchor {
      assert.equal(readFileSync(options.path, 'utf8'), bytes, 'inventory history changed before checkpoint');
      return Object.freeze({ byteLength: Buffer.byteLength(bytes),
        sha256: createHash('sha256').update(bytes).digest('hex'), dev: receiptIdentity.dev, ino: receiptIdentity.ino });
    },
    /** Always discover group/recursive descendants BEFORE terminal observations.
     * A live/unknown process keeps the ledger open. No fixture deletion or parent
     * close alone can manufacture an EXIT observation. */
    async reconcile({ outcome, custody }: { outcome: VerifierTeardownOutcome; custody: Record<string, unknown> }): Promise<InventoryTerminal> {
      assert.ok(!sealed, 'inventory already sealed');
      assert.deepEqual(custody, header.custody, 'original parent custody changed');
      assert.ok(!originalOutcome || originalOutcome === outcome, 'original teardown outcome changed');
      await discoverProcesses();
      const observations: InventoryObservation[] = [];
      for (const resource of resources.values()) {
        if (resource.kind === 'process') {
          let state = 'unknown';
          try {
            const text = await readFile(`/proc/${resource.pid}/stat`, 'utf8');
            assert.equal(linuxProcessIdentityFromStat(await readFile('/proc/sys/kernel/random/boot_id', 'utf8'), text),
              resource.processIdentity, 'inventory process identity changed');
            const kernelState = linuxProcStateFromStat(text);
            state = kernelState === 'Z' || kernelState === 'X' ? 'exited' : kernelState ? 'live' : 'unknown';
          } catch (error) {
            if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
            state = processGone(resource.pid) ? 'exited' : 'unknown';
          }
          observations.push({ id: resource.id, state, pid: resource.pid, processIdentity: resource.processIdentity });
        } else {
          const identity = resourceIdentity(resource);
          if (resource.retain) assert.deepEqual(identity, resource.originalIdentity, 'retained inventory resource changed');
          observations.push({ id: resource.id, state: resource.retain ? 'retained' : identity ? 'present' : 'removed',
            identity, ...(resource.retain ? { reason: resource.retain } : {}) });
        }
      }
      const survivors = observations.filter(row => !['exited', 'removed', 'retained'].includes(row.state)).map(row => row.id);
      if (survivors.length === 0) {
        // A helper may fork between the first census and its EXIT observation.
        // Reconcile that new population before sealing; a live child forces the
        // next observation to remain incomplete even when its leader has exited.
        const count = resources.size;
        await discoverProcesses();
        if (resources.size !== count) return inventory.reconcile({ outcome, custody });
      }
      deadlineExceeded ||= now() >= header.deadlineEpochMs;
      const terminal = { outcome, deadlineEpochMs: header.deadlineEpochMs, deadlineExceeded,
        observations, survivors, sealed: survivors.length === 0,
        status: survivors.length ? 'incomplete' : outcome === 'success' && !deadlineExceeded ? 'completed' : 'failed' };
      append('reconciled', terminal);
      return terminal;
    },
  };
  return inventory;
}

/** Persist ownership before checkout/dependency preparation can block or be killed. */
export function writeVerifierTaskReceipt(owned: string, repoRoot: string, env: NodeJS.ProcessEnv, externalPath?: string) {
  const taskId = env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID || null;
  const processIdentity = readProcessIdentity(process.pid);
  if ((taskId !== null && !/^[A-Za-z0-9-]{1,100}$/.test(taskId)) || !processIdentity)
    throw new Error('verifier task ownership cannot be established');
  // This is the payload's kernel membership, captured BEFORE the launcher's
  // asynchronous markSpawned write. Descendants retain the owning task scope.
  const kernelPath = readProcessCgroupPath(process.pid);
  const parts = kernelPath?.split('/') ?? [];
  const scopeIndex = taskId === null ? -1 : parts.findIndex(part => taskIdFromScopeUnit(part) === taskId);
  const cgroupPath = scopeIndex > 0 ? parts.slice(0, scopeIndex + 1).join('/') : null;
  const receipt = {
    schemaVersion: 'verifier-task-v1', taskId, repoRoot: realpathSync(repoRoot),
    pid: process.pid, processIdentity, cgroupPath, ownedRoot: realpathSync(owned), cleanup: 'pending',
  };
  const bytes = JSON.stringify(receipt) + '\n';
  writeFileSync(join(owned, TASK_RECEIPT), bytes, { flag: 'wx', mode: 0o600 });
  // CLI ownership must survive both a killed finally and removal of the tree.
  // A null taskId is evidence, never authority for the task reconciler to delete it.
  if (externalPath) writeFileSync(externalPath, bytes, { flag: 'wx', mode: 0o600 });
  return receipt;
}

function processGone(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || readProcessIdentity(pid) !== null) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/** The existing terminal close retries IO failures before losing the live ledger row.
 * Only an empty/released confined task can own this destructive cleanup. */
export async function cleanupEndedVerifierDirectories(row: TaskRow): Promise<void> {
  const scopeUnit = row.scopeUnit;
  if ((row.class !== 'bash-job' && row.class !== 'test-run') || !row.cwd || !isAbsolute(row.cwd) || !scopeUnit) return;
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
  async function cleanupScratch(scratch: string, scopeUnit: string): Promise<void> {
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
          : row.state === 'pending' && !row.cgroupPath && taskIdFromScopeUnit(scopeUnit) === row.taskId
            ? receipt.cgroupPath : null;
        if (typeof scopePath !== 'string' || !scopePath.startsWith('/') ||
            resolve(scopePath) !== scopePath || basename(scopePath) !== scopeUnit ||
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
  await cleanupScratch(join(repoRoot, '.papercusp', 'scratch'), scopeUnit);
  if (process.platform === 'linux') {
    try {
      // runVerifierCommand places root-device donors here. Retain the same
      // device boundary and apply the identical receipt/process checks to both
      // roots, including old allocations after a donor changes filesystem.
      const data = await realpath('/mnt/data');
      const scratch = join(data, 'tmp');
      const dataDevice = (await stat(data)).dev;
      if (dataDevice !== (await stat('/')).dev && (await stat(scratch)).dev === dataDevice)
        await cleanupScratch(scratch, scopeUnit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
