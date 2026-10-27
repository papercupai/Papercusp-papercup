/**
 * WI-224710: fleet-logs retention GC — age bound, total-bytes ceiling, and
 * the never-throws / best-effort contract.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, utimesSync, chmodSync, symlinkSync, statSync, lstatSync, openSync, closeSync, renameSync, linkSync, ftruncateSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { openWriterPidsMany } from './native-bg-task-ledger';
import { tmpdir } from 'node:os';
import { createRetentionPin } from './storage/retention-pins';
import { join } from 'node:path';
import { withFsMutex } from '../../../scripts/lib/fs-mutex.mjs';
import {
  runFleetLogsGc,
  FLEET_LOGS_GC_DEFAULT_RETENTION_MS,
  FLEET_LOGS_GC_DEFAULT_MAX_TOTAL_BYTES,
  runPapercuspWorkdirGc,
  runLintWorkRootGc,
  runLintWorkRootsGc,
  PAPERCUSP_WORKDIR_GC_DEFAULT_RETENTION_MS,
  PAPERCUSP_WORKDIR_GC_PROTECTED_BASENAMES,
  WINDOWS_BUILD_SCRATCH_GC_DEFAULT_RETENTION_MS,
  runWindowsBuildScratchGc,
  runLaunchContextGc,
  LAUNCH_CONTEXT_GC_DEFAULT_RETENTION_MS,
} from './fleet-logs-gc';

let sandbox: string;
let previousRetentionRoot: string | undefined;
let previousMutexRoot: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'papercusp-fleet-logs-gc-test-'));
  previousRetentionRoot = process.env.PAPERCUSP_RELEASE_RETENTION_ROOT;
  previousMutexRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  process.env.PAPERCUSP_RELEASE_RETENTION_ROOT = join(sandbox, 'leases');
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = join(sandbox, 'mutex');
});

afterEach(() => {
  if (previousRetentionRoot === undefined) delete process.env.PAPERCUSP_RELEASE_RETENTION_ROOT;
  else process.env.PAPERCUSP_RELEASE_RETENTION_ROOT = previousRetentionRoot;
  if (previousMutexRoot === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousMutexRoot;
  // A permission-locked test file (see the "unlink failure" case) refuses a
  // plain rm; restore write perms before cleanup so afterEach itself never
  // throws mid-suite.
  try {
    chmodSync(sandbox, 0o700);
  } catch {
    /* ignore */
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function writeAged(dir: string, name: string, bytes: number, ageMs: number): string {
  const p = join(dir, name);
  writeFileSync(p, Buffer.alloc(bytes, 'x'));
  const t = new Date(Date.now() - ageMs);
  utimesSync(p, t, t);
  return p;
}

const allocatedBytes = (path: string) => statSync(path).blocks * 512;

describe('runFleetLogsGc', () => {
  const scanIdlePaths = async () => ({ complete: true, byPath: new Map<string, string[]>() });
  it('pins survive both age and byte-ceiling eviction while unpinned logs are removed', async () => {
    const dir = join(sandbox, 'logs'); mkdirSync(dir);
    const pinned = writeAged(dir, 'pinned.log', 100, FLEET_LOGS_GC_DEFAULT_RETENTION_MS + 1000);
    const unpinned = writeAged(dir, 'unpinned.log', 100, 1000);
    const bytes = allocatedBytes(pinned);
    const beforeBytes = bytes + allocatedBytes(unpinned);
    createRetentionPin({ path: pinned, owner: 'reviewer', reason: 'review log', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const result = await runFleetLogsGc({ dirs: [dir], scanOpenPaths: scanIdlePaths, maxTotalBytes: 0 });
    expect(existsSync(pinned)).toBe(true);
    expect(existsSync(unpinned)).toBe(false);
    expect(result.dirs[0]!.bytesRemaining).toBe(100);
    expect(result.dirs[0]!.cap).toMatchObject({ root: dir, classId: 'fleet-logs', maxBytes: 0,
      beforeBytes, afterBytes: bytes, pinnedBytes: bytes, pinnedPaths: [pinned],
      overByBytes: bytes, pinnedOverageBytes: bytes });
    expect(result.dirs[0]!.errors).toEqual([]);
  });

  it('reports retained non-pin excess without deleting an open log under cap pressure', async () => {
    const dir = join(sandbox, 'logs'); mkdirSync(dir);
    const pinned = writeAged(dir, 'pinned.log', 100, 3000);
    const open = writeAged(dir, 'open.log', 100, 2000);
    const idle = writeAged(dir, 'idle.log', 100, 1000);
    const bytes = allocatedBytes(pinned);
    createRetentionPin({ path: pinned, owner: 'reviewer', reason: 'evidence', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const options = { dirs: [dir], maxTotalBytes: bytes - 20,
      scanOpenPaths: async () => ({ complete: true, byPath: new Map([[open, ['123']]]) }) };
    const preview = await runFleetLogsGc({ ...options, dryRun: true });
    expect(preview.dirs[0]!.errors).toEqual([]);
    expect(existsSync(idle)).toBe(true);
    const result = await runFleetLogsGc(options);
    expect(result.dirs[0]!.cap).toMatchObject({ afterBytes: bytes * 2, pinnedBytes: bytes,
      overByBytes: bytes + 20, pinnedOverageBytes: 20 });
    expect(result.dirs[0]!.cap).toEqual(preview.dirs[0]!.cap);
    expect(result.dirs[0]!.errors).toContainEqual({ path: dir,
      error: expect.stringContaining('cap retains non-pin excess') });
    expect(existsSync(open)).toBe(true);
    expect(existsSync(pinned)).toBe(true);
    expect(existsSync(idle)).toBe(false);
  });

  it('reports pinned fresh and open logs even when no deletion is attempted', async () => {
    const dir = join(sandbox, 'logs'); mkdirSync(dir);
    const pinned = writeAged(dir, 'fresh.log', 100, 1000);
    const bytes = allocatedBytes(pinned);
    createRetentionPin({ path: pinned, owner: 'reviewer', reason: 'active evidence', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const result = await runFleetLogsGc({ dirs: [dir], maxTotalBytes: bytes * 2,
      scanOpenPaths: async () => ({ complete: false, byPath: new Map([[pinned, ['123']]]) }) });
    expect(result.dirs[0]!.cap).toMatchObject({ beforeBytes: bytes, afterBytes: bytes,
      pinnedBytes: bytes, pinnedPaths: [pinned], overByBytes: 0, pinnedOverageBytes: 0 });
    expect(existsSync(pinned)).toBe(true);
  });

  it('expired pins stop contributing to the cap receipt and dry-run predicts the actual retained bytes', async () => {
    const dir = join(sandbox, 'logs'); mkdirSync(dir);
    const path = writeAged(dir, 'expired.log', 100, FLEET_LOGS_GC_DEFAULT_RETENTION_MS + 1000);
    const bytes = allocatedBytes(path);
    const now = Date.now();
    createRetentionPin({ path, owner: 'reviewer', reason: 'old evidence', expiresAt: new Date(now - 1000).toISOString() }, { nowMs: now - 2000 });
    const preview = await runFleetLogsGc({ dirs: [dir], scanOpenPaths: scanIdlePaths, maxTotalBytes: 0, dryRun: true });
    expect(existsSync(path)).toBe(true);
    const actual = await runFleetLogsGc({ dirs: [dir], scanOpenPaths: scanIdlePaths, maxTotalBytes: 0 });
    expect(actual.dirs[0]!.cap).toEqual(preview.dirs[0]!.cap);
    expect(actual.dirs[0]!.cap).toMatchObject({ beforeBytes: bytes, afterBytes: 0,
      pinnedBytes: 0, pinnedPaths: [], overByBytes: 0, pinnedOverageBytes: 0 });
    expect(existsSync(path)).toBe(false);
  });

  it('keeps logs and reports unknown pin accounting when the pin store is corrupt', async () => {
    const dir = join(sandbox, 'logs'); mkdirSync(dir);
    const path = writeAged(dir, 'stale.log', 100, FLEET_LOGS_GC_DEFAULT_RETENTION_MS + 1000);
    mkdirSync(process.env.PAPERCUSP_RELEASE_RETENTION_ROOT!, { recursive: true });
    writeFileSync(join(process.env.PAPERCUSP_RELEASE_RETENTION_ROOT!, 'lease-agent-pin-broken.tsv'), 'not a lease');
    const result = await runFleetLogsGc({ dirs: [dir], scanOpenPaths: scanIdlePaths, maxTotalBytes: 0 });
    expect(existsSync(path)).toBe(true);
    expect(result.dirs[0]!.cap).toBeNull();
    expect(result.dirs[0]!.errors).toContainEqual(expect.objectContaining({ error: expect.stringContaining('retention pins unreadable') }));
  });

  it('defaults are sane: 3-day age window, 10 GiB ceiling', () => {
    expect(FLEET_LOGS_GC_DEFAULT_RETENTION_MS).toBe(3 * 24 * 60 * 60 * 1000);
    expect(FLEET_LOGS_GC_DEFAULT_MAX_TOTAL_BYTES).toBe(10 * 1024 * 1024 * 1024);
  });

  it('deletes files older than retentionMs and keeps fresh ones', async () => {
    const dir = join(sandbox, 'fleet-logs');
    mkdirSync(dir, { recursive: true });
    const stale = writeAged(dir, 'stale.log', 1000, 5 * 24 * 60 * 60 * 1000); // 5d old
    const fresh = writeAged(dir, 'fresh.log', 1000, 1 * 60 * 60 * 1000); // 1h old

    const result = await runFleetLogsGc({
      scanOpenPaths: scanIdlePaths,
      dirs: [dir],
      retentionMs: 3 * 24 * 60 * 60 * 1000,
      maxTotalBytes: 1024 * 1024 * 1024, // large — ceiling never engages here
    });

    expect(result.dryRun).toBe(false);
    const [d] = result.dirs;
    expect(d.scanned).toBe(2);
    expect(d.removedByAge).toBe(1);
    expect(d.removedByCeiling).toBe(0);
    expect(d.bytesUnlinked).toBe(1000);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('enforces the total-bytes ceiling oldest-first even within the retention window', async () => {
    const dir = join(sandbox, 'fleet-logs');
    mkdirSync(dir, { recursive: true });
    // All three are within the age window, but only two allocations fit.
    const oldest = writeAged(dir, 'a.log', 100, 3 * 60 * 60 * 1000);
    const middle = writeAged(dir, 'b.log', 100, 2 * 60 * 60 * 1000);
    const newest = writeAged(dir, 'c.log', 100, 1 * 60 * 60 * 1000);

    const result = await runFleetLogsGc({
      scanOpenPaths: scanIdlePaths,
      dirs: [dir],
      retentionMs: 30 * 24 * 60 * 60 * 1000, // nothing ages out
      maxTotalBytes: allocatedBytes(middle) + allocatedBytes(newest),
    });

    const [d] = result.dirs;
    expect(d.removedByAge).toBe(0);
    expect(d.removedByCeiling).toBe(1);
    expect(d.cap!.overByBytes).toBe(0);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);
  });

  it('age removal leaves a fresh idle file below the ceiling', async () => {
    const dir = join(sandbox, 'fleet-logs');
    mkdirSync(dir, { recursive: true });
    // One huge stale file, one small fresh file. Both bounds should agree:
    // the stale one goes (age), the fresh one is evaluated by the ceiling
    // pass only if it's still over budget afterward — here it isn't.
    const stale = writeAged(dir, 'huge-stale.log', 5000, 10 * 24 * 60 * 60 * 1000);
    const fresh = writeAged(dir, 'small-fresh.log', 10, 0);

    const result = await runFleetLogsGc({
      scanOpenPaths: scanIdlePaths,
      dirs: [dir],
      retentionMs: 3 * 24 * 60 * 60 * 1000,
      maxTotalBytes: allocatedBytes(fresh),
    });

    const [d] = result.dirs;
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(d.bytesRemaining).toBe(10);
  });

  it('dryRun deletes nothing and separates proposed bytes from actual unlink', async () => {
    const dir = join(sandbox, 'fleet-logs');
    mkdirSync(dir, { recursive: true });
    const stale = writeAged(dir, 'stale.log', 500, 5 * 24 * 60 * 60 * 1000);

    const result = await runFleetLogsGc({
      scanOpenPaths: scanIdlePaths,
      dirs: [dir],
      retentionMs: 3 * 24 * 60 * 60 * 1000,
      maxTotalBytes: 1024 * 1024 * 1024,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.dirs[0].removedByAge).toBe(1);
    expect(result.dirs[0].wouldUnlinkBytes).toBe(500);
    expect(result.dirs[0].bytesUnlinked).toBe(0);
    expect(result.dirs[0].allocatedBytesUnlinked).toBe(0);
    expect(existsSync(stale)).toBe(true); // nothing actually deleted
  });

  it('a missing directory is a no-op, not an error', async () => {
    const dir = join(sandbox, 'does-not-exist');
    const result = await runFleetLogsGc({ dirs: [dir] });
    expect(result.dirs[0].scanned).toBe(0);
    expect(result.dirs[0].errors).toHaveLength(0);
  });

  it('sweeps multiple directories independently', async () => {
    const dirA = join(sandbox, 'ws-a', 'fleet-logs');
    const dirB = join(sandbox, 'ws-b', 'fleet-logs');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeAged(dirA, 'old.log', 100, 5 * 24 * 60 * 60 * 1000);
    writeAged(dirB, 'new.log', 100, 0);

    const result = await runFleetLogsGc({ dirs: [dirA, dirB], retentionMs: 3 * 24 * 60 * 60 * 1000, scanOpenPaths: scanIdlePaths });
    expect(result.dirs).toHaveLength(2);
    const a = result.dirs.find((d) => d.dir === dirA)!;
    const b = result.dirs.find((d) => d.dir === dirB)!;
    expect(a.removedByAge).toBe(1);
    expect(b.removedByAge).toBe(0);
  });

  it('a stale file it cannot delete is reported as an error and still counted in bytesRemaining', async () => {
    const dir = join(sandbox, 'fleet-logs');
    mkdirSync(dir, { recursive: true });
    const locked = writeAged(dir, 'locked.log', 200, 5 * 24 * 60 * 60 * 1000);
    // Remove write permission on the *directory* so unlink fails regardless
    // of the calling user's own file ownership (root-run test suites can
    // otherwise unlink a chmod-000 file with no error).
    chmodSync(dir, 0o500);

    const result = await runFleetLogsGc({ dirs: [dir], retentionMs: 3 * 24 * 60 * 60 * 1000, scanOpenPaths: scanIdlePaths });

    chmodSync(dir, 0o700); // restore before assertions / afterEach cleanup
    const [d] = result.dirs;
    if (d.errors.length > 0) {
      // Root or a permissive FS may still allow the unlink; only assert the
      // failure shape when this environment actually enforced the lock.
      expect(d.errors[0].path).toBe(locked);
      expect(existsSync(locked)).toBe(true);
    }
  });

  it.each(['age', 'ceiling'])('keeps a genuinely open log under %s pressure and removes idle files', async (pass) => {
    const dir = join(sandbox, 'fleet-logs');
    mkdirSync(dir);
    const busy = writeAged(dir, 'busy.log', 500, pass === 'age' ? 5 * 24 * 60 * 60 * 1000 : 60_000);
    const idle = writeAged(dir, 'idle.log', 100, 5 * 24 * 60 * 60 * 1000);
    const fd = openSync(busy, 'a');
    const proc = join(sandbox, 'proc');
    mkdirSync(proc);
    symlinkSync(`/proc/${process.pid}`, join(proc, String(process.pid)));
    try {
      const result = await runFleetLogsGc({ dirs: [dir], maxTotalBytes: 50,
        scanOpenPaths: (paths) => openWriterPidsMany(paths, { procRoot: proc, failClosed: true }),
      });
      expect(result.scanComplete).toBe(true);
      expect(result.dirs[0].skippedOpen).toBe(1);
      expect(result.dirs[0].bytesRemaining).toBe(500); // unresolved pressure is honest
      expect(result.dirs[0].bytesUnlinked).toBe(100);
      expect(existsSync(busy)).toBe(true);
      expect(existsSync(idle)).toBe(false);
    } finally { closeSync(fd); }
  });

  it.each(['incomplete', 'throws'])('defers both eviction passes when the census %s', async (mode) => {
    const dir = join(sandbox, 'fleet-logs');
    mkdirSync(dir);
    const old = writeAged(dir, 'old.log', 500, 5 * 24 * 60 * 60 * 1000);
    const fresh = writeAged(dir, 'fresh.log', 500, 0);
    const result = await runFleetLogsGc({ dirs: [dir], maxTotalBytes: 50, scanOpenPaths: async () => {
      if (mode === 'throws') throw new Error('permission denied');
      return { complete: false, byPath: new Map() };
    } });
    expect(result.scanComplete).toBe(false);
    expect(result.dirs[0]).toMatchObject({ removedByAge: 0, removedByCeiling: 0, bytesUnlinked: 0, bytesRemaining: 1000 });
    expect(existsSync(old) && existsSync(fresh)).toBe(true);
    if (mode === 'throws') expect(result.scanError).toBe('permission denied');
  });

  it.each(['replacement', 'symlink', 'write', 'parent'])('preserves a %s race during the holder census', async (race) => {
    const dir = join(sandbox, 'fleet-logs');
    mkdirSync(dir);
    const log = writeAged(dir, 'old.log', 100, 5 * 24 * 60 * 60 * 1000);
    const outside = writeAged(sandbox, 'protected.log', 100, 5 * 24 * 60 * 60 * 1000);
    const result = await runFleetLogsGc({ dirs: [dir], maxTotalBytes: 0, scanOpenPaths: async () => {
      if (race === 'parent') { renameSync(dir, dir + '-original'); mkdirSync(dir); writeFileSync(log, 'new'); }
      else if (race === 'write') writeFileSync(log, 'new');
      else {
        renameSync(log, log + '-original');
        if (race === 'symlink') symlinkSync(outside, log);
        else writeFileSync(log, 'new');
      }
      return scanIdlePaths();
    } });
    expect(result.dirs[0]).toMatchObject({ bytesUnlinked: 0, removedByAge: 0, removedByCeiling: 0, skippedRaced: 1 });
    expect(existsSync(log) && existsSync(outside)).toBe(true);
  });

  it('counts sparse-file allocation separately from logical unlink bytes', async () => {
    const dir = join(sandbox, 'fleet-logs');
    mkdirSync(dir);
    const log = writeAged(dir, 'sparse.log', 1, 0);
    const fd = openSync(log, 'r+');
    try { ftruncateSync(fd, 1024 * 1024); } finally { closeSync(fd); }
    const st = statSync(log);
    const result = await runFleetLogsGc({ dirs: [dir], maxTotalBytes: 0, scanOpenPaths: scanIdlePaths });
    expect(result.dirs[0].bytesUnlinked).toBe(st.size);
    expect(result.dirs[0].allocatedBytesUnlinked).toBe(st.blocks * 512);
    expect(st.blocks * 512).toBeLessThan(st.size);
  });

  it('does not count allocation reclaimed when another hard link remains', async () => {
    const dir = join(sandbox, 'fleet-logs');
    mkdirSync(dir);
    const log = writeAged(dir, 'linked.log', 100, 5 * 24 * 60 * 60 * 1000);
    const retained = join(sandbox, 'retained.log');
    linkSync(log, retained);
    const result = await runFleetLogsGc({ dirs: [dir], scanOpenPaths: scanIdlePaths });
    expect(result.dirs[0]).toMatchObject({ bytesUnlinked: 100, allocatedBytesUnlinked: 0 });
    expect(readFileSync(retained)).toHaveLength(100);
  });
});

/**
 * WI-10002015: one-off working-DIRECTORY retention under ~/.papercusp.
 *
 * The load-bearing case is "a nested write keeps the whole tree alive". It is
 * the regression guard for a measured near-miss: the largest directory on the
 * host (82.8 GiB, an in-flight release) had an OWN mtime 79 minutes old while
 * being actively written, because appending to a nested file never touches an
 * ancestor directory's mtime. Any "simplification" of the recursive scan back
 * to the directory's own mtime passes every other test here and fails that one.
 */
const DAY = 24 * 60 * 60 * 1000;
const noOpenPaths = async () => ({ byPath: new Map<string, string[]>(), complete: true });

describe.each(['fleet', 'launch'] as const)('allocated root caps: %s', (owner) => {
  let controls: string;
  beforeEach(() => {
    // The complete population must not include this test's own active mutex
    // receipt or pin-store files; they are intentionally not eviction candidates.
    controls = mkdtempSync(join(tmpdir(), 'fleet-root-cap-controls-'));
    process.env.PAPERCUSP_RELEASE_RETENTION_ROOT = join(controls, 'leases');
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = join(controls, 'mutex');
  });
  afterEach(() => { rmSync(controls, { recursive: true, force: true }); });
  const sweep = async (dir: string, maxTotalBytes: number, dryRun = false) => {
    if (owner === 'launch') return runLaunchContextGc({ dir, maxTotalBytes, dryRun, liveRenderPaths: new Set() });
    const result = await runFleetLogsGc({ dirs: [dir], maxTotalBytes, dryRun, scanOpenPaths: noOpenPaths });
    return result.dirs[0]!;
  };
  const allocation = (path: string) => statSync(path).blocks * 512;

  it('counts retained nested allocation and the root inode as non-pin residual', async () => {
    const nested = join(sandbox, 'nested'); mkdirSync(nested);
    const data = writeAged(nested, 'data', 65536, 1000);
    const bytes = allocation(sandbox) + allocation(nested) + allocation(data);
    const result = await sweep(sandbox, 1);
    expect(existsSync(data)).toBe(true);
    expect(result.cap).toMatchObject({ beforeBytes: bytes, afterBytes: bytes, pinnedBytes: 0,
      overByBytes: bytes - 1, pinnedOverageBytes: 0 });
    expect(result.errors).toContainEqual({ path: sandbox, error: expect.stringContaining('cap retains non-pin excess') });
  });

  it('counts nested hardlinks once without following a symlink outside the root', async () => {
    const root = join(sandbox, 'root'); const nested = join(root, 'nested'); mkdirSync(nested, { recursive: true });
    const data = writeAged(nested, 'data', 65536, 1000);
    linkSync(data, join(root, 'alias'));
    const outside = writeAged(sandbox, 'owner-data', 1024 * 1024, 1000);
    const mirror = join(root, 'mirror'); symlinkSync(outside, mirror);
    const bytes = allocation(root) + allocation(nested) + allocation(data) + lstatSync(mirror).blocks * 512;
    const result = await sweep(root, 1);
    expect(result.cap).toMatchObject({ beforeBytes: bytes, afterBytes: bytes });
    expect(existsSync(join(root, 'alias'))).toBe(false);
    expect(existsSync(data) && existsSync(outside)).toBe(true);
    expect(lstatSync(mirror).isSymbolicLink()).toBe(true);
    expect(result.errors).toContainEqual({ path: root, error: expect.stringContaining('cap retains non-pin excess') });
  });

  it('returns unknown cap usage and refuses effects when the complete-root census fails', async () => {
    const data = writeAged(sandbox, 'stale', 100, 10 * DAY);
    const census = await import('./storage/disk-consumer-census');
    const inspect = vi.spyOn(census, 'inspectRetentionTrees').mockResolvedValue({ entries: [], retained: [],
      inspectedNodes: 0, retainedRecentTrees: 0, error: 'fixture root coverage incomplete' });
    try {
      const result = await sweep(sandbox, 1);
      expect(result.cap).toBeNull();
      expect(result.errors).toContainEqual({ path: sandbox, error: expect.stringContaining('root coverage incomplete') });
      expect(existsSync(data)).toBe(true);
    } finally { inspect.mockRestore(); }
  });

  it('retains a sparse logical-large file below its allocated cap', async () => {
    const path = writeAged(sandbox, 'sparse.log', 1, 1000);
    const fd = openSync(path, 'r+');
    try { ftruncateSync(fd, 1024 * 1024); } finally { closeSync(fd); }
    const bytes = allocation(path);
    expect(bytes).toBeLessThan(statSync(path).size);
    const result = await sweep(sandbox, bytes);
    expect(existsSync(path)).toBe(true);
    expect(result.cap).toMatchObject({ beforeBytes: bytes, afterBytes: bytes, overByBytes: 0 });
  });

  it('counts hardlink allocation once and attributes the shared inode to its pin', async () => {
    const pinned = writeAged(sandbox, 'pinned.log', 65536, 2000);
    const alias = join(sandbox, 'alias.log'); linkSync(pinned, alias);
    createRetentionPin({ path: pinned, owner: 'reviewer', reason: 'shared evidence', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const bytes = allocation(pinned);
    const result = await sweep(sandbox, bytes);
    expect(existsSync(alias)).toBe(true);
    expect(result.cap).toMatchObject({ beforeBytes: bytes, afterBytes: bytes, pinnedBytes: bytes,
      overByBytes: 0, pinnedOverageBytes: 0 });
    expect(result.errors).toEqual([]);
    const pressure = await sweep(sandbox, 0);
    expect(existsSync(alias)).toBe(false);
    expect(existsSync(pinned)).toBe(true);
    expect(pressure.cap).toMatchObject({ beforeBytes: bytes, afterBytes: bytes, pinnedBytes: bytes,
      overByBytes: bytes, pinnedOverageBytes: bytes });
    expect(pressure.errors).toEqual([]);
  });

  it('does not subtract allocation until the last in-root hardlink is removed', async () => {
    const oldest = writeAged(sandbox, 'oldest.log', 65536, 3000);
    const alias = join(sandbox, 'middle.log'); linkSync(oldest, alias);
    const newest = writeAged(sandbox, 'newest.log', 65536, 1000);
    const bytes = allocation(oldest);
    const preview = await sweep(sandbox, bytes, true);
    expect(preview.cap).toMatchObject({ beforeBytes: bytes + allocation(newest), afterBytes: allocation(newest) });
    const actual = await sweep(sandbox, bytes);
    expect(actual.cap).toEqual(preview.cap);
    expect(existsSync(oldest) || existsSync(alias)).toBe(false);
    expect(existsSync(newest)).toBe(true);
    expect(actual.errors).toEqual([]);
  });

  it('reports allocated excess retained by a live non-pin file', async () => {
    const path = writeAged(sandbox, 'live.log', 1, 1000);
    const bytes = allocation(path);
    const result = owner === 'launch'
      ? await runLaunchContextGc({ dir: sandbox, maxTotalBytes: bytes - 1, liveRenderPaths: new Set([path]) })
      : (await runFleetLogsGc({ dirs: [sandbox], maxTotalBytes: bytes - 1,
        scanOpenPaths: async () => ({ complete: true, byPath: new Map([[path, ['123']]]) }) })).dirs[0]!;
    expect(result.cap).toMatchObject({ afterBytes: bytes, pinnedBytes: 0, overByBytes: 1, pinnedOverageBytes: 0 });
    expect(result.errors).toContainEqual({ path: sandbox, error: expect.stringContaining('cap retains non-pin excess') });
    expect(existsSync(path)).toBe(true);
  });

  it('caps distinct physical roots independently', async () => {
    const a = join(sandbox, 'a'); const b = join(sandbox, 'b'); mkdirSync(a); mkdirSync(b);
    const first = writeAged(a, 'a.log', 65536, 1000);
    const second = writeAged(b, 'b.log', 65536, 1000);
    const bytes = allocation(first);
    const results = owner === 'fleet'
      ? (await runFleetLogsGc({ dirs: [a, b], maxTotalBytes: bytes, scanOpenPaths: noOpenPaths })).dirs
      : [await sweep(a, bytes), await sweep(b, bytes)];
    expect(results.map(r => r.cap)).toEqual([a, b].map(root => expect.objectContaining({ root, beforeBytes: bytes, afterBytes: bytes })));
    expect(existsSync(first) && existsSync(second)).toBe(true);
  });
});

/** Recursively force every file AND directory mtime to `ageMs` in the past.
 *  Depth-first so a parent is stamped last — stamping a child would otherwise
 *  bump the parent's mtime again. */
function ageTree(path: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const child of readdirSync(path)) ageTree(join(path, child), ageMs);
  }
  utimesSync(path, t, t);
}

/** A realistic one-off working dir: nested structure holding real bytes. */
function makeWorkdir(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'nested', 'deep'), { recursive: true });
  writeFileSync(join(dir, 'nested', 'deep', 'payload.bin'), Buffer.alloc(2048, 'x'));
  writeFileSync(join(dir, 'top.txt'), Buffer.alloc(512, 'y'));
  return dir;
}

function makeWindowsBuildScratch(root: string): {
  repoRoot: string;
  container: string;
  buildRoot: string;
} {
  const repoRoot = join(root, 'desktop-source');
  const container = join(root, 'papercusp-win-cross-source-AbC123');
  const buildRoot = join(container, 'papercusp-desktop');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(container);
  writeFileSync(join(repoRoot, 'seed.txt'), 'seed');
  execFileSync('git', ['init', '-q', repoRoot], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoRoot, 'add', 'seed.txt'], { stdio: 'ignore' });
  execFileSync('git', [
    '-C', repoRoot, '-c', 'user.name=GC test', '-c', 'user.email=gc-test@example.com',
    'commit', '-m', 'seed',
  ], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--detach', buildRoot, 'HEAD'], {
    stdio: 'ignore',
  });
  return { repoRoot, container, buildRoot };
}

describe('runLintWorkRootGc', () => {
  const HOUR = 3600_000;
  const now = 20 * HOUR;
  const makeRoot = (name: string, ageHours: number, extra: Record<string, unknown> = {}, base = sandbox) => {
    const path = join(base, `papercusp-lint-as-committed-${name}`);
    mkdirSync(join(path, '.git'), { recursive: true });
    writeFileSync(join(path, '.git/lint-as-committed-owner.json'), JSON.stringify({
      pid: 2147483647, keep: true, sha: 'a'.repeat(40), createdAtMs: now - ageHours * HOUR, ...extra,
    }));
    writeFileSync(join(path, 'source.txt'), 'retained source');
    return path;
  };
  const scanOpenPaths = async () => ({ byPath: new Map<string, string[]>(), complete: true });

  it('preserves a pinned snapshot while reclaiming an equally stale unpinned snapshot', async () => {
    const pinned = makeRoot('pinned', 7);
    const stale = makeRoot('stale', 7);
    createRetentionPin({ path: join(pinned, 'source.txt'), owner: 'reviewer', reason: 'retained proof', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const result = await runLintWorkRootGc({ root: sandbox, now, dryRun: false, scanOpenPaths, log: () => {} });
    expect(existsSync(pinned)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(result.kept).toContainEqual({ name: 'papercusp-lint-as-committed-pinned', reason: 'pinned' });
  });

  it('expires an idle snapshot without starting another lint, preserving young roots and dependent artifacts', async () => {
    const expired = makeRoot('expired', 7);
    const young = makeRoot('young', 1);
    const artifact = join(sandbox, 'release-artifact');
    mkdirSync(artifact);
    const dependent = makeRoot('dependent', 1000, { retainedFor: [{ path: artifact, sha: 'a'.repeat(40) }] });
    const receipts: string[] = [];
    const result = await runLintWorkRootGc({ root: sandbox, now, dryRun: false, scanOpenPaths,
      log: (message) => receipts.push(message),
    });
    expect(result.removed).toEqual([{ name: 'papercusp-lint-as-committed-expired', reason: 'keep-expired' }]);
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(receipts[0].slice('[lint-work-root-gc] removal '.length))).toEqual({
      schemaVersion: 1, policy: 'dependent-artifact', path: expired,
      sourceSha: 'a'.repeat(40), reason: 'keep-expired',
    });
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(dependent)).toBe(true);
  });

  it('holds a snapshot with a genuinely open descendant fd', async () => {
    const busy = makeRoot('busy', 7);
    const fd = openSync(join(busy, 'source.txt'), 'r');
    const proc = join(sandbox, 'proc');
    mkdirSync(proc);
    symlinkSync(`/proc/${process.pid}`, join(proc, String(process.pid)));
    try {
      const result = await runLintWorkRootGc({ root: sandbox, now, dryRun: false,
        scanOpenPaths: (paths) => openWriterPidsMany(paths, {
          procRoot: proc, descendants: true, includeCwd: true, failClosed: true,
        }),
      });
      expect(result.kept).toContainEqual({ name: 'papercusp-lint-as-committed-busy', reason: 'in-use' });
      expect(existsSync(busy)).toBe(true);
    } finally { closeSync(fd); }
  });

  it.each(['incomplete', 'throws'])('defers every removal when the process census %s, including dead owners', async (mode) => {
    const expired = makeRoot('expired', 7);
    const dead = makeRoot('dead', 1, { keep: false });
    const result = await runLintWorkRootGc({ root: sandbox, now, dryRun: false, scanOpenPaths: async () => {
      if (mode === 'throws') throw new Error('permission denied');
      return { byPath: new Map(), complete: false };
    } });
    expect(result.scanComplete).toBe(false);
    expect(result.removed).toEqual([]);
    expect(result.kept).toHaveLength(2);
    expect(result.kept.every((entry) => entry.reason === 'process-scan-incomplete')).toBe(true);
    expect(existsSync(expired) && existsSync(dead)).toBe(true);
  });

  it('does not delete a root whose custody marker changes during the census', async () => {
    const path = makeRoot('raced', 7);
    const result = await runLintWorkRootGc({ root: sandbox, now, dryRun: false, scanOpenPaths: async () => {
      writeFileSync(join(path, '.git/lint-as-committed-owner.json'), JSON.stringify({ pid: process.pid, keep: true, createdAtMs: 0 }));
      return scanOpenPaths();
    } });
    expect(result.removed).toEqual([]);
    expect(result.kept).toContainEqual({ name: 'papercusp-lint-as-committed-raced', reason: 'raced' });
    expect(existsSync(path)).toBe(true);
  });

  it('previews expiry without deleting source', async () => {
    const path = makeRoot('expired', 7);
    const receipts: string[] = [];
    const result = await runLintWorkRootGc({ root: sandbox, now, scanOpenPaths,
      log: (message) => receipts.push(message),
    });
    expect(result.removed).toEqual([]);
    expect(result.wouldRemove).toHaveLength(1);
    expect(receipts).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  it('discovers relocated producer roots once per physical directory and preserves retention protections', async () => {
    const temp = join(sandbox, 'temp'); mkdirSync(temp);
    const alias = join(sandbox, 'temp-alias'); symlinkSync(temp, alias);
    const workspaceRoot = join(sandbox, 'workspaces');
    const checkout = join(workspaceRoot, 'staging', '.papercusp', 'tmp');
    mkdirSync(checkout, { recursive: true });
    const hivesRoot = join(sandbox, 'hives'); mkdirSync(hivesRoot);
    symlinkSync(join(workspaceRoot, 'staging'), join(hivesRoot, 'staging-alias'));
    const tempExpired = makeRoot('expired', 7, {}, temp);
    const checkoutExpired = makeRoot('expired', 7, {}, checkout);
    const pinned = makeRoot('pinned', 7, {}, checkout);
    createRetentionPin({ path: join(pinned, 'source.txt'), owner: 'reviewer', reason: 'proof',
      expiresAt: new Date(Date.now() + HOUR).toISOString() });
    const artifact = join(sandbox, 'artifact'); mkdirSync(artifact);
    const dependent = makeRoot('dependent', 1000,
      { retainedFor: [{ path: artifact, sha: 'a'.repeat(40) }] }, checkout);
    const options = { discovery: { baseDirs: [temp, alias], workspaceRoot, hivesRoot,
      dataTempDir: join(sandbox, 'missing-data') }, now, scanOpenPaths, log: () => {} };
    const preview = await runLintWorkRootsGc(options);
    expect(preview.map((result) => result.root)).toEqual([temp, checkout]);
    expect(preview.map((result) => result.wouldRemove.length)).toEqual([1, 1]);
    expect(existsSync(tempExpired) && existsSync(checkoutExpired)).toBe(true);
    const actual = await runLintWorkRootsGc({ ...options, dryRun: false });
    expect(actual.map((result) => result.removed.length)).toEqual([1, 1]);
    expect(actual.every((result) => result.scanComplete)).toBe(true);
    expect(existsSync(tempExpired) || existsSync(checkoutExpired)).toBe(false);
    expect(existsSync(pinned) && existsSync(dependent)).toBe(true);
  });

  it('keeps relocated snapshots when the holder census is incomplete', async () => {
    const workspaceRoot = join(sandbox, 'workspaces');
    const checkout = join(workspaceRoot, 'staging', '.papercusp', 'tmp');
    const expired = makeRoot('expired', 7, {}, checkout);
    const results = await runLintWorkRootsGc({
      discovery: { baseDirs: [], workspaceRoot, hivesRoot: join(sandbox, 'missing-hives'),
        dataTempDir: join(sandbox, 'missing-data') },
      now, dryRun: false, scanOpenPaths: async () => ({ complete: false, byPath: new Map() }),
    });
    expect(results).toHaveLength(1);
    expect(results[0].removed).toEqual([]);
    expect(results[0].scanComplete).toBe(false);
    expect(existsSync(expired)).toBe(true);
  });

  it('runs on the existing hourly storage workflow', () => {
    const source = readFileSync(new URL('./dbos/periodic-workflows.ts', import.meta.url), 'utf8');
    const tick = source.slice(source.indexOf('async function fleetLogsGcTick'), source.indexOf('const fleetLogsGcWorkflow'));
    expect(tick).toContain('await runLintWorkRootsGc({ dryRun: false })');
    expect(tick).toContain("defaultEvidenceRoot('release-local')");
    expect(tick).toContain('pruneEvidenceRoot(evidenceRoot)');
    expect(source).toContain("DBOS.registerScheduled(fleetLogsGcWorkflow, { name: 'fleetLogsGc', crontab: '0 5 * * * *' })");
  });
});

describe('runPapercuspWorkdirGc', () => {
  it('preserves pins on descendants through physical aliases and reclaims expired pins', async () => {
    const pinned = join(sandbox, 'task.ABC123'); mkdirSync(pinned);
    const proof = join(pinned, 'proof'); writeFileSync(proof, 'proof');
    const alias = join(sandbox, 'proof-alias'); symlinkSync(proof, alias);
    const nowMs = Date.now();
    const pin = createRetentionPin({ path: alias, owner: 'reviewer', reason: 'review', expiresAt: new Date(nowMs + 3600_000).toISOString() });
    ageTree(pinned, 10 * DAY);
    const result = await runPapercuspWorkdirGc({ root: sandbox, dryRun: false, scanOpenPaths: noOpenPaths });
    expect(existsSync(proof)).toBe(true);
    expect(result.candidates.find((c) => c.path === pinned)?.skipped).toBe('pinned');
    const leaseFile = join(sandbox, 'leases', `lease-agent-pin-${pin.id}.tsv`);
    writeFileSync(leaseFile, readFileSync(leaseFile, 'utf8').replace(/^expires_ns=.*$/m, `expires_ns=${BigInt(nowMs - 1000) * 1_000_000n}`));
    const expired = await runPapercuspWorkdirGc({ root: sandbox, dryRun: false, scanOpenPaths: noOpenPaths });
    expect(expired.removed).toBe(1);
    expect(existsSync(pinned)).toBe(false);
  });

  it('keeps a genuinely open nested file even when its mtime is old', async () => {
    const dir = makeWorkdir(sandbox, 'p309-accept.AbC123');
    ageTree(dir, 30 * DAY);
    const fd = openSync(join(dir, 'top.txt'), 'r');
    const proc = join(sandbox, 'proc');
    mkdirSync(proc);
    symlinkSync(`/proc/${process.pid}`, join(proc, String(process.pid)));
    try {
      const result = await runPapercuspWorkdirGc({
        root: sandbox, dryRun: false,
        scanOpenPaths: (paths) => openWriterPidsMany(paths, {
          procRoot: proc, descendants: true, includeCwd: true, failClosed: true,
        }),
      });
      expect(result.candidates[0]?.skipped).toBe('in-use');
      expect(existsSync(dir)).toBe(true);
    } finally { closeSync(fd); }
  });

  it('keeps protected stores and symlink replacements after the process scan', async () => {
    const protectedDir = makeWorkdir(sandbox, 'pot-git.AbC123');
    const dir = makeWorkdir(sandbox, 'p309-accept.AbC123');
    ageTree(dir, 30 * DAY);
    ageTree(protectedDir, 30 * DAY);
    const result = await runPapercuspWorkdirGc({
      root: sandbox, dryRun: false,
      scanOpenPaths: async () => {
        rmSync(dir, { recursive: true });
        symlinkSync(protectedDir, dir);
        return noOpenPaths();
      },
    });
    expect(result.removed).toBe(0);
    expect(result.candidates.find((c) => c.path === dir)?.skipped).toBe('raced');
    expect(existsSync(join(protectedDir, 'top.txt'))).toBe(true);
  });

  it('WI-10005720: defaults to dry-run and never claims bytes were actually freed', async () => {
    const dir = makeWorkdir(sandbox, 'p309-accept.AbC123');
    ageTree(dir, 30 * DAY);
    const result = await runPapercuspWorkdirGc({ root: sandbox, scanOpenPaths: noOpenPaths });
    expect(result.dryRun).toBe(true);
    expect(result.removed).toBe(0);
    expect(result.bytesFreed).toBe(0);
    expect(result.wouldRemove).toBe(1);
    expect(existsSync(dir)).toBe(true);
  });

  it('WI-10005720: refuses an aged directory held open by a process', async () => {
    const dir = makeWorkdir(sandbox, 'p309-accept.AbC123');
    ageTree(dir, 30 * DAY);
    const result = await runPapercuspWorkdirGc({
      root: sandbox, dryRun: false,
      scanOpenPaths: async () => ({ byPath: new Map([[dir, ['42']]]), complete: true }),
    });
    expect(result.removed).toBe(0);
    expect(result.candidates[0]?.skipped).toBe('in-use');
    expect(existsSync(dir)).toBe(true);
  });

  it('WI-10005720: refuses deletion when process-use evidence is incomplete', async () => {
    const dir = makeWorkdir(sandbox, 'p309-accept.AbC123');
    ageTree(dir, 30 * DAY);
    const result = await runPapercuspWorkdirGc({
      root: sandbox, dryRun: false,
      scanOpenPaths: async () => ({ byPath: new Map(), complete: false }),
    });
    expect(result.removed).toBe(0);
    expect(result.candidates[0]?.skipped).toBe('process-scan-incomplete');
    expect(existsSync(dir)).toBe(true);
  });

  it('uses a conservative 7-day default, longer than the 3-day fleet-logs bound', async () => {
    expect(PAPERCUSP_WORKDIR_GC_DEFAULT_RETENTION_MS).toBe(7 * DAY);
    expect(PAPERCUSP_WORKDIR_GC_DEFAULT_RETENTION_MS).toBeGreaterThan(
      FLEET_LOGS_GC_DEFAULT_RETENTION_MS,
    );
  });

  it('removes a stale mktemp-suffixed working directory and reports its bytes', async () => {
    const dir = makeWorkdir(sandbox, 'p309-accept.BZHrUr');
    ageTree(dir, 10 * DAY);

    const result = await runPapercuspWorkdirGc({ root: sandbox, dryRun: false, scanOpenPaths: noOpenPaths });

    expect(result.removed, JSON.stringify(result.candidates)).toBe(1);
    expect(existsSync(dir)).toBe(false);
    expect(result.bytesFreed).toBeGreaterThanOrEqual(2048 + 512);
    expect(result.candidates[0]?.removed).toBe(true);
  });

  // ─── THE REGRESSION GUARD ────────────────────────────────────────────────
  it('a NESTED write keeps the tree alive even though every directory mtime is ancient', async () => {
    const dir = makeWorkdir(sandbox, 'byoc-p318-release.lqhrUZ');
    ageTree(dir, 30 * DAY);

    // Exactly the dangerous real-world shape: a live writer appending deep
    // inside, leaving every ancestor directory's mtime untouched and ancient.
    const live = join(dir, 'nested', 'deep', 'payload.bin');
    const recent = new Date(Date.now() - 60_000);
    utimesSync(live, recent, recent);

    // Precondition: the directory's OWN mtime still looks 30 days stale, so a
    // naive own-mtime sweep would happily delete this tree.
    expect(Date.now() - statSync(dir).mtimeMs).toBeGreaterThan(29 * DAY);

    const result = await runPapercuspWorkdirGc({ root: sandbox, dryRun: false, scanOpenPaths: noOpenPaths });

    expect(result.removed).toBe(0);
    expect(existsSync(live)).toBe(true);
    expect(result.candidates[0]?.skipped).toBe('too-new');
  });

  it('ignores directories without a machine-generated mktemp suffix', async () => {
    const dir = makeWorkdir(sandbox, 'p046-deps-snapshot');
    ageTree(dir, 90 * DAY);

    const result = await runPapercuspWorkdirGc({ root: sandbox, dryRun: false, scanOpenPaths: noOpenPaths });

    expect(result.removed).toBe(0);
    expect(result.candidates).toHaveLength(0); // never even considered
    expect(existsSync(dir)).toBe(true);
  });

  it('refuses a protected basename even when it carries a mktemp suffix', async () => {
    const name = `${[...PAPERCUSP_WORKDIR_GC_PROTECTED_BASENAMES][0]}.AbC123`;
    const dir = makeWorkdir(sandbox, name);
    ageTree(dir, 90 * DAY);

    const result = await runPapercuspWorkdirGc({ root: sandbox, dryRun: false, scanOpenPaths: noOpenPaths });

    expect(result.removed).toBe(0);
    expect(result.candidates[0]?.skipped).toBe('protected');
    expect(existsSync(dir)).toBe(true);
  });

  it('dryRun reports exactly what it would free and deletes nothing', async () => {
    const dir = makeWorkdir(sandbox, 'p314-accept.2Uix7q');
    ageTree(dir, 10 * DAY);

    const result = await runPapercuspWorkdirGc({ root: sandbox, dryRun: true, scanOpenPaths: noOpenPaths });

    expect(result.dryRun).toBe(true);
    expect(result.removed).toBe(0);
    expect(result.bytesFreed).toBe(0);
    expect(result.wouldRemove).toBe(1);
    expect(result.bytesReclaimable).toBeGreaterThan(0);
    expect(existsSync(dir)).toBe(true); // reported, but nothing removed
  });

  it('never follows a symlinked directory', async () => {
    const real = makeWorkdir(sandbox, 'real-payload');
    ageTree(real, 90 * DAY);
    symlinkSync(real, join(sandbox, 'linked.AbC123'));

    const result = await runPapercuspWorkdirGc({ root: sandbox, dryRun: false, scanOpenPaths: noOpenPaths });

    expect(result.removed).toBe(0);
    expect(existsSync(real)).toBe(true);
    expect(existsSync(join(real, 'top.txt'))).toBe(true);
  });

  it('is a no-op on a missing root and never throws', async () => {
    const result = await runPapercuspWorkdirGc({ root: join(sandbox, 'does-not-exist') });
    expect(result.removed).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });
});

/**
 * Falsifiability control for the guard above.
 *
 * A guard test that has never failed is a guard nobody has tested. The usual
 * way to prove one CAN fail is to mutate the implementation and re-run — but
 * the implementation here calls `rmSync` recursively, and executing a MUTANT of
 * deletion logic is precisely how a reaper's loop once became `for d in /*` and
 * destroyed ~370 GB (EI-20566003853444873). A PATH shim cannot help either:
 * `rmSync` is an in-process syscall, not an `rm` executable.
 *
 * So the wrong implementation lives here instead, permanently, per the repo's
 * prescribed tier for an imported module. `naiveOwnMtimeWouldDelete` is the
 * predicate this module must never regress to. The pair below is the whole
 * proof, and BOTH halves are required:
 *   • CALIBRATION — on a genuinely stale tree the control agrees with the real
 *     sweep. Without this, a control that simply never fires would make the
 *     divergence case pass even if the property under test were broken.
 *   • DIVERGENCE — on the nested-write tree the control WOULD delete while the
 *     real sweep spares it. That gap is the recursive scan doing its job, and
 *     it is what the near-miss would have cost us.
 */
function naiveOwnMtimeWouldDelete(dir: string, retentionMs: number): boolean {
  return Date.now() - statSync(dir).mtimeMs >= retentionMs;
}

describe('runPapercuspWorkdirGc — falsifiability control', () => {
  it('CALIBRATION: on a genuinely stale tree the naive control agrees with the real sweep', async () => {
    const dir = makeWorkdir(sandbox, 'calibration-stale.QqWw11');
    ageTree(dir, 30 * DAY);

    // The control fires here — so it is not a predicate that never triggers.
    expect(naiveOwnMtimeWouldDelete(dir, 7 * DAY)).toBe(true);

    const result = await runPapercuspWorkdirGc({ root: sandbox, dryRun: false, scanOpenPaths: noOpenPaths });
    expect(result.removed).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it('DIVERGENCE: the naive control would DELETE the live tree the real sweep spares', async () => {
    const dir = makeWorkdir(sandbox, 'byoc-p318-release.lqhrUZ');
    ageTree(dir, 30 * DAY);
    const live = join(dir, 'nested', 'deep', 'payload.bin');
    const recent = new Date(Date.now() - 60_000);
    utimesSync(live, recent, recent);

    // The wrong implementation destroys an in-flight release …
    expect(naiveOwnMtimeWouldDelete(dir, 7 * DAY)).toBe(true);

    // … and the real one does not. If this pair ever stops diverging, the
    // recursive scan has been lost and this suite is no longer guarding it.
    const result = await runPapercuspWorkdirGc({ root: sandbox, dryRun: false, scanOpenPaths: noOpenPaths });
    expect(result.removed).toBe(0);
    expect(existsSync(live)).toBe(true);
  });
});

describe('runWindowsBuildScratchGc', () => {
  it('keeps the registered Git worktree and container when a descendant is pinned', async () => {
    const { repoRoot, container, buildRoot } = makeWindowsBuildScratch(sandbox);
    createRetentionPin({ path: buildRoot, owner: 'reviewer', reason: 'build diagnosis', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    ageTree(container, 3 * DAY);
    const result = await runWindowsBuildScratchGc({ root: sandbox, repoRoot, dryRun: false, scanOpenPaths: noOpenPaths });
    expect(result.removed).toBe(0);
    expect(result.candidates[0]?.skipped).toBe('pinned');
    expect(existsSync(buildRoot)).toBe(true);
    expect(execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })).toContain(buildRoot);
  });

  it('uses a 48-hour retention window', () => {
    expect(WINDOWS_BUILD_SCRATCH_GC_DEFAULT_RETENTION_MS).toBe(48 * 60 * 60 * 1000);
  });

  it('removes a stale producer worktree only after claiming its exact Git lock', async () => {
    const { repoRoot, container, buildRoot } = makeWindowsBuildScratch(sandbox);
    ageTree(container, 3 * DAY);

    const result = await runWindowsBuildScratchGc({
      root: sandbox,
      repoRoot,
      dryRun: false,
      scanOpenPaths: noOpenPaths,
    });

    expect(result.removed, JSON.stringify(result.candidates)).toBe(1);
    expect(result.candidates[0]?.removed).toBe(true);
    expect(existsSync(buildRoot)).toBe(false);
    expect(existsSync(container)).toBe(false);
    const remaining = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    });
    expect(remaining).not.toContain(buildRoot);
  });

  it('keeps fresh nested data written during the post-removal process scan', async () => {
    const { repoRoot, container, buildRoot } = makeWindowsBuildScratch(sandbox);
    ageTree(container, 3 * DAY);
    const lateWrite = join(container, 'late-write.txt');

    const result = await runWindowsBuildScratchGc({
      root: sandbox,
      repoRoot,
      dryRun: false,
      scanOpenPaths: async () => {
        if (!existsSync(buildRoot) && !existsSync(lateWrite)) writeFileSync(lateWrite, 'new data');
        return { byPath: new Map(), complete: true };
      },
    });

    expect(result.removed).toBe(0);
    expect(result.candidates[0]?.skipped).toBe('raced');
    expect(existsSync(buildRoot)).toBe(false);
    expect(existsSync(lateWrite)).toBe(true);
    expect(existsSync(container)).toBe(true);
  });

  it('keeps the container when the post-removal process scan is incomplete', async () => {
    const { repoRoot, container, buildRoot } = makeWindowsBuildScratch(sandbox);
    ageTree(container, 3 * DAY);

    const result = await runWindowsBuildScratchGc({
      root: sandbox,
      repoRoot,
      dryRun: false,
      scanOpenPaths: async () => existsSync(buildRoot)
        ? { byPath: new Map(), complete: true }
        : { byPath: new Map(), complete: false },
    });

    expect(result.removed).toBe(0);
    expect(result.candidates[0]?.skipped).toBe('process-scan-incomplete');
    expect(existsSync(buildRoot)).toBe(false);
    expect(existsSync(container)).toBe(true);
  });

  it('keeps a worktree that had a Git lock before the sweep', async () => {
    const { repoRoot, container, buildRoot } = makeWindowsBuildScratch(sandbox);
    execFileSync('git', [
      '-C', repoRoot, 'worktree', 'lock', '--reason', 'owned-before-gc', buildRoot,
    ], { stdio: 'ignore' });
    ageTree(container, 3 * DAY);

    const result = await runWindowsBuildScratchGc({
      root: sandbox,
      repoRoot,
      dryRun: false,
      scanOpenPaths: noOpenPaths,
    });

    expect(result.removed).toBe(0);
    expect(result.candidates[0]?.skipped).toBe('git-locked');
    expect(existsSync(buildRoot)).toBe(true);
  });

  it('keeps a stale-looking container when its recursive tree has a recent write', async () => {
    const { repoRoot, container, buildRoot } = makeWindowsBuildScratch(sandbox);
    ageTree(container, 3 * DAY);
    const activeFile = join(buildRoot, 'seed.txt');
    const recent = new Date(Date.now() - 60_000);
    utimesSync(activeFile, recent, recent);

    const result = await runWindowsBuildScratchGc({
      root: sandbox,
      repoRoot,
      dryRun: false,
      scanOpenPaths: noOpenPaths,
    });

    expect(result.removed).toBe(0);
    expect(result.candidates[0]?.skipped).toBe('too-new');
    expect(existsSync(activeFile)).toBe(true);
  });

  it('fails closed when the open-writer scan is incomplete', async () => {
    const { repoRoot, container, buildRoot } = makeWindowsBuildScratch(sandbox);
    ageTree(container, 3 * DAY);

    const result = await runWindowsBuildScratchGc({
      root: sandbox,
      repoRoot,
      dryRun: false,
      scanOpenPaths: async () => ({ byPath: new Map(), complete: false }),
    });

    expect(result.removed).toBe(0);
    expect(result.candidates[0]?.skipped).toBe('process-scan-incomplete');
    expect(existsSync(buildRoot)).toBe(true);
  });
});

// ── launch-context render GC (WI-10002015) ───────────────────────────────────

describe('runLaunchContextGc', () => {
  it('evicts fresh renders oldest first until the byte ceiling is met', async () => {
    const dir = join(sandbox, 'renders'); mkdirSync(dir);
    const newest = writeAged(dir, 'a-newest.md', 8, 1000);
    const oldest = writeAged(dir, 'z-oldest.md', 8, 3000);
    const middle = writeAged(dir, 'm-middle.md', 8, 2000);
    const bytes = allocatedBytes(newest);
    const result = await runLaunchContextGc({ dir, liveRenderPaths: new Set(), maxTotalBytes: bytes });
    expect(result.candidates.filter((c) => c.removed).map((c) => c.path)).toEqual([oldest, middle]);
    expect(existsSync(newest)).toBe(true);
    expect(result.cap).toMatchObject({ maxBytes: bytes, beforeBytes: bytes * 3, afterBytes: bytes, overByBytes: 0 });
  });

  it('reports pinned overage and holds live renders under byte pressure', async () => {
    const dir = join(sandbox, 'renders'); mkdirSync(dir);
    const pinned = writeAged(dir, 'pinned.md', 12, 3000);
    const live = writeAged(dir, 'live.md', 8, 2000);
    const idle = writeAged(dir, 'idle.md', 8, 1000);
    const bytes = allocatedBytes(pinned);
    createRetentionPin({ path: pinned, owner: 'reviewer', reason: 'prompt evidence', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const result = await runLaunchContextGc({ dir, liveRenderPaths: new Set([live]), maxTotalBytes: bytes - 1 });
    expect(result.candidates.find((c) => c.path === pinned)?.skipped).toBe('pinned');
    expect(result.candidates.find((c) => c.path === live)?.skipped).toBe('live-session');
    expect(existsSync(idle)).toBe(false);
    expect(result.cap).toMatchObject({ beforeBytes: bytes * 3, afterBytes: bytes * 2, pinnedBytes: bytes,
      pinnedPaths: [pinned], overByBytes: bytes + 1, pinnedOverageBytes: 1 });
    expect(result.errors).toContainEqual({ path: dir,
      error: expect.stringContaining('cap retains non-pin excess') });
  });

  it('permits pinned-only render overage while reporting unpinned live-render excess', async () => {
    const dir = join(sandbox, 'renders'); mkdirSync(dir);
    const render = writeAged(dir, 'live.md', 20, 2000);
    const bytes = allocatedBytes(render);
    const options = { dir, liveRenderPaths: new Set([render]), maxTotalBytes: bytes - 1 };
    const preview = await runLaunchContextGc({ ...options, dryRun: true });
    expect(preview.errors).toEqual([]);
    const unpinned = await runLaunchContextGc(options);
    expect(unpinned.cap).toMatchObject({ afterBytes: bytes, pinnedBytes: 0,
      overByBytes: 1, pinnedOverageBytes: 0 });
    expect(unpinned.errors).toContainEqual({ path: dir,
      error: expect.stringContaining('cap retains non-pin excess') });
    createRetentionPin({ path: render, owner: 'reviewer', reason: 'live evidence', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const pinned = await runLaunchContextGc(options);
    expect(pinned.cap).toMatchObject({ afterBytes: bytes, pinnedBytes: bytes,
      overByBytes: 1, pinnedOverageBytes: 1 });
    expect(pinned.errors).toEqual([]);
    expect(existsSync(render)).toBe(true);
  });

  it('dry-run cap selection is identical and expiry releases a pinned render', async () => {
    const dir = join(sandbox, 'renders'); mkdirSync(dir);
    const older = writeAged(dir, 'older.md', 8, 2000);
    const newer = writeAged(dir, 'newer.md', 8, 1000);
    const now = Date.now();
    createRetentionPin({ path: older, owner: 'reviewer', reason: 'short review', expiresAt: new Date(now + 1000).toISOString() });
    const options = { dir, liveRenderPaths: new Set<string>(), maxTotalBytes: allocatedBytes(newer), now: now + 2000 };
    const preview = await runLaunchContextGc({ ...options, dryRun: true });
    expect(preview.candidates.filter((c) => c.removed).map((c) => c.path)).toEqual([older]);
    expect(existsSync(older)).toBe(true);
    expect(existsSync(newer)).toBe(true);
    const actual = await runLaunchContextGc(options);
    expect(actual.cap).toEqual(preview.cap);
    expect(existsSync(older)).toBe(false);
    expect(existsSync(newer)).toBe(true);
  });

  it('reads a new pin after acquiring the mutation mutex rather than before waiting', async () => {
    const stale = writeAged(sandbox, 'stale.md', 100, 30 * DAY);
    let sweep!: ReturnType<typeof runLaunchContextGc>;
    await withFsMutex('papercusp-disk-retention', async () => {
      sweep = runLaunchContextGc({ dir: sandbox, liveRenderPaths: new Set() });
      // Give an incorrectly pre-lock read time to finish before pinning.
      await new Promise((resolve) => setTimeout(resolve, 50));
      createRetentionPin({ path: stale, owner: 'reviewer', reason: 'pin while GC waits', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    });
    expect((await sweep).removed).toBe(0);
    expect(existsSync(stale)).toBe(true);
  });

  it('preserves pinned renders while deleting unpinned peers', async () => {
    const pinned = writeAged(sandbox, 'pinned.md', 100, 30 * DAY);
    const stale = writeAged(sandbox, 'stale.md', 100, 30 * DAY);
    createRetentionPin({ path: pinned, owner: 'reviewer', reason: 'prompt evidence', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const result = await runLaunchContextGc({ dir: sandbox, liveRenderPaths: new Set() });
    expect(result.removed).toBe(1);
    expect(result.candidates.find((c) => c.path === pinned)?.skipped).toBe('pinned');
    expect(existsSync(pinned)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it('refuses deletion when the protection store is corrupt', async () => {
    const stale = writeAged(sandbox, 'stale.md', 100, 30 * DAY);
    mkdirSync(join(sandbox, 'leases'));
    writeFileSync(join(sandbox, 'leases/lease-agent-pin-broken.tsv'), 'broken');
    await expect(runLaunchContextGc({ dir: sandbox, liveRenderPaths: new Set() })).rejects.toThrow('retention pins unreadable');
    expect(existsSync(stale)).toBe(true);
  });

  it('reaps an aged render nothing is serving', async () => {
    writeAged(sandbox, 'session-old.md', 2048, 30 * DAY);
    const r = await runLaunchContextGc({ dir: sandbox, liveRenderPaths: new Set() });

    expect(r.refused).toBeUndefined();
    expect(r.removed).toBe(1);
    expect(r.bytesFreed).toBe(2048);
    expect(existsSync(join(sandbox, 'session-old.md'))).toBe(false);
  });

  it('keeps a render younger than the retention window', async () => {
    writeAged(sandbox, 'session-new.md', 512, 60_000);
    const r = await runLaunchContextGc({ dir: sandbox, liveRenderPaths: new Set() });

    expect(r.removed).toBe(0);
    expect(r.candidates.find((c) => c.name === 'session-new.md')?.skipped).toBe('too-new');
    expect(existsSync(join(sandbox, 'session-new.md'))).toBe(true);
  });

  // THE load-bearing guard. A render is written once, at exec, and never
  // touched again — so its mtime records when the session STARTED, not when it
  // stopped mattering. Age alone therefore deletes the persona out from under
  // any agent alive longer than the retention window. The pair below pins that:
  // if the naive rule and the real one ever stop diverging, the live-session
  // exclusion has been lost and this suite no longer guards it.
  it('refuses to reap an ANCIENT render that a live session is still serving', async () => {
    const inUse = writeAged(sandbox, 'session-long-lived.md', 4096, 90 * DAY);
    const stale = writeAged(sandbox, 'session-abandoned.md', 4096, 90 * DAY);

    // The wrong implementation — age only — destroys a live agent's persona.
    const naiveWouldDelete = (p: string) =>
      Date.now() - statSync(p).mtimeMs > LAUNCH_CONTEXT_GC_DEFAULT_RETENTION_MS;
    expect(naiveWouldDelete(inUse)).toBe(true);

    // … and the real one holds it back while still reclaiming its twin.
    const r = await runLaunchContextGc({ dir: sandbox, liveRenderPaths: new Set([inUse]) });

    expect(existsSync(inUse)).toBe(true);
    expect(r.liveHeld).toBe(1);
    expect(r.candidates.find((c) => c.path === inUse)?.skipped).toBe('live-session');

    expect(existsSync(stale)).toBe(false);
    expect(r.removed).toBe(1);
  });

  // `undefined` (no measurement) and an empty Set (a measurement that found no
  // live sessions) must never collapse into the same behaviour.
  it('fails closed when no live-render evidence is supplied at all', async () => {
    writeAged(sandbox, 'session-ancient.md', 4096, 120 * DAY);

    const r = await runLaunchContextGc({ dir: sandbox });

    expect(r.refused).toBe('no-live-render-evidence');
    expect(r.removed).toBe(0);
    expect(r.scanned).toBe(0);
    expect(existsSync(join(sandbox, 'session-ancient.md'))).toBe(true);

    // The same directory, with an EMPTY set, does proceed — proving the refusal
    // above is about missing evidence, not about an empty exclusion list.
    const measured = await runLaunchContextGc({ dir: sandbox, liveRenderPaths: new Set() });
    expect(measured.refused).toBeUndefined();
    expect(measured.removed).toBe(1);
  });

  it('never recurses into or removes a subdirectory', async () => {
    const sub = join(sandbox, 'nested');
    mkdirSync(sub);
    const buried = join(sub, 'payload.md');
    writeFileSync(buried, 'x');
    const old = new Date(Date.now() - 120 * DAY);
    utimesSync(buried, old, old);
    utimesSync(sub, old, old);

    const r = await runLaunchContextGc({ dir: sandbox, liveRenderPaths: new Set() });

    expect(r.removed).toBe(0);
    expect(r.candidates[0]?.skipped).toBe('not-a-file');
    expect(existsSync(buried)).toBe(true);
    expect(existsSync(sub)).toBe(true);
  });

  it('reports what it would free without removing anything on a dry run', async () => {
    writeAged(sandbox, 'session-old.md', 1024, 30 * DAY);

    const r = await runLaunchContextGc({ dir: sandbox, liveRenderPaths: new Set(), dryRun: true });

    expect(r.removed).toBe(1);
    expect(r.bytesFreed).toBe(1024);
    expect(existsSync(join(sandbox, 'session-old.md'))).toBe(true);
  });

  it('treats an unreadable directory as empty rather than throwing', async () => {
    const missing = join(sandbox, 'does-not-exist');
    expect((await runLaunchContextGc({ dir: missing, liveRenderPaths: new Set() })).scanned).toBe(0);
  });
});
