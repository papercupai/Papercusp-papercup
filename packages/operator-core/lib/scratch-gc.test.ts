/**
 * Phase 4 T2.3 scratch GC + quota unit tests.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

// Pass-through spies on the SYNCHRONOUS fs calls, so a test can prove the reservation hot path
// (WI-10004513) and the GC sweep (WI-10005135) never touch the disk synchronously. Behaviour is
// the real implementation. mkdirSync is spied as the calibration control: ensureScratchRunDir
// still calls it, which proves these spies intercept scratch-gc.ts's own node:fs import.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
    statSync: vi.fn(actual.statSync),
    existsSync: vi.fn(actual.existsSync),
    rmSync: vi.fn(actual.rmSync),
    mkdirSync: vi.fn(actual.mkdirSync),
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir), rm: vi.fn(actual.rm), stat: vi.fn(actual.stat) };
});
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  utimesSync,
  readdirSync,
  statSync,
  readFileSync,
  symlinkSync,
  openSync,
  closeSync,
  realpathSync,
  truncateSync,
} from 'node:fs';
import { mkdir, readdir as readdirAsync, rm as rmAsync, stat as statAsync, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { withFsMutex } from '../../../scripts/lib/fs-mutex.mjs';
import {
  runScratchGc,
  reserveScratchSpace,
  ensureScratchRunDir,
  ScratchQuotaError,
  RETENTION_MS,
  SCRATCH_QUOTA_RECOVERY_HEADROOM_BYTES,
  USAGE_REFRESH_MS,
  _resetScratchGcCountersForTests,
  scratchEvictionBytes,
  refreshScratchUsage,
  scratchUsageBytes,
  _setScratchUsageForTests,
  _resetScratchUsageForTests,
  WORKSPACE_QUOTA_BYTES,
  SCRATCH_GC_CRONTAB,
  SCRATCH_GC_SWEEP_PERIOD_MS,
  SCRATCH_RUN_DIR_MAX_AGE_MS,
  WORKSPACE_SCRATCH_MARKER,
  DEAD_WORKSPACE_QUIET_MS,
  writeWithScratchQuota,
  type ScratchWriteTimings,
} from './scratch-gc';
import type { OpenWriterScan } from './native-bg-task-ledger';
import { parseScratchReference, writeScratchReference } from './scratch-reference';
import { applyResultDoorAsync, RESULT_DOOR_TOKENS } from './result-door';
import { scratchRootForWorkspace } from './scratch-uri';
import { createRetentionPin } from './storage/retention-pins';
import { spawn } from 'node:child_process';
import { createTextCollector } from './child-output.js';

// Tests run against a sandbox scratch root so they don't touch the
// real ~/.papercusp/scratch tree. `os.homedir()` on Linux reads
// /etc/passwd not $HOME, so the PAPERCUSP_SCRATCH_ROOT env-var
// override is the only reliable swap.
let prevScratchRoot: string | undefined;
let prevFsMutexLockDir: string | undefined;
let prevXdgRuntimeDir: string | undefined;
let prevDisableFsMutex: string | undefined;
let prevRetentionRoot: string | undefined;
let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'papercusp-scratch-test-'));
  prevScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
  prevFsMutexLockDir = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  prevXdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
  prevDisableFsMutex = process.env.PAPERCUSP_DISABLE_FS_MUTEX;
  prevRetentionRoot = process.env.PAPERCUSP_RELEASE_RETENTION_ROOT;
  process.env.PAPERCUSP_RELEASE_RETENTION_ROOT = join(sandbox, 'retention-leases');
  delete process.env.PAPERCUSP_DISABLE_FS_MUTEX;
  process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, '.papercusp', 'scratch');
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = join(sandbox, 'fs-mutex-locks');
  _resetScratchGcCountersForTests();
  _resetScratchUsageForTests();
});

afterEach(() => {
  _resetScratchUsageForTests();
  if (prevScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = prevScratchRoot;
  if (prevFsMutexLockDir === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = prevFsMutexLockDir;
  if (prevXdgRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = prevXdgRuntimeDir;
  if (prevDisableFsMutex === undefined) delete process.env.PAPERCUSP_DISABLE_FS_MUTEX;
  else process.env.PAPERCUSP_DISABLE_FS_MUTEX = prevDisableFsMutex;
  if (prevRetentionRoot === undefined) delete process.env.PAPERCUSP_RELEASE_RETENTION_ROOT;
  else process.env.PAPERCUSP_RELEASE_RETENTION_ROOT = prevRetentionRoot;
  rmSync(sandbox, { recursive: true, force: true });
});

const UUID = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

function makeRunDir(workspaceId: string, toolName: string, runId: string, bytes: number, ageMs = 0): string {
  const dir = ensureScratchRunDir({ workspaceId, toolName, runId });
  writeFileSync(join(dir, 'data.bin'), Buffer.alloc(bytes));
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(dir, t, t);
  }
  return dir;
}

function makeSparseRun(workspaceId: string, runId: string, bytes: number, ageMs = 0): string {
  const dir = makeRunDir(workspaceId, 'quota', runId, 0, ageMs);
  truncateSync(join(dir, 'data.bin'), bytes);
  return dir;
}

/** Stamp EVERY file and dir under `dir` (children first, then `dir`) `ageMs` into the past. */
function ageTree(dir: string, ageMs: number): void {
  const t = (Date.now() - ageMs) / 1000;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) ageTree(child, ageMs);
    else utimesSync(child, t, t);
  }
  utimesSync(dir, t, t);
}

/** Size of a workspace root's WORKSPACE_SCRATCH_MARKER (it varies with the id and timestamp). */
function markerBytes(workspaceId: string): number {
  const size = statSync(join(process.env.PAPERCUSP_SCRATCH_ROOT!, workspaceId, WORKSPACE_SCRATCH_MARKER)).size;
  expect(size).toBeGreaterThan(0);
  return size;
}

function scratchRmCallCount(): number {
  const root = process.env.PAPERCUSP_SCRATCH_ROOT;
  if (!root) return 0;
  return vi.mocked(rmAsync).mock.calls.filter(([path]) =>
    String(path).startsWith(root + sep),
  ).length;
}

function startScratchChild(script: string, env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const stdout = createTextCollector(child.stdout);
  const stderr = createTextCollector(child.stderr);
  let spawnError: string | null = null;
  const seenMessages = new Set<string>();
  const messageWaiters = new Map<string, () => void>();
  child.on('message', (message: unknown) => {
    const type = message && typeof message === 'object' && 'type' in message
      ? String((message as { type: unknown }).type)
      : '';
    seenMessages.add(type);
    messageWaiters.get(type)?.();
  });
  child.once('error', (error) => { spawnError = error.message; });
  const finished = new Promise<{ code: number | null; stdout: string; stderr: string; spawnError: string | null }>((resolve) => {
    child.once('close', (code) => resolve({ code, stdout: stdout.text(), stderr: stderr.text(), spawnError }));
  });
  const waitForMessage = (type: string) => {
    if (seenMessages.has(type)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        messageWaiters.delete(type);
        reject(new Error('Timed out waiting for child message ' + type + '; stderr: ' + stderr.peek()));
      }, 8_000);
      messageWaiters.set(type, () => {
        clearTimeout(timer);
        messageWaiters.delete(type);
        resolve();
      });
      child.once('close', () => {
        clearTimeout(timer);
        messageWaiters.delete(type);
        reject(new Error('Child exited before message ' + type + '; stdout: ' + stdout.peek() + '; stderr: ' + stderr.peek()));
      });
    });
  };
  return { child, finished, waitForMessage };
}

/** A complete /proc scan that saw no holder anywhere. */
const noHolders = async (): Promise<OpenWriterScan> => ({ byPath: new Map(), complete: true });

describe('scratch quota mutex root', () => {
  it('uses XDG_RUNTIME_DIR for scratch mutex metadata when no global override is set', async () => {
    const runtimeDir = join(sandbox, 'xdg-runtime');
    delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    makeRunDir('ws-runtime-lock', 'demo:tool', UUID(10), 8);
    await runScratchGc({ workspaceRegistry: ['ws-runtime-lock'], enforceQuota: false });

    expect(existsSync(join(runtimeDir, 'papercusp', 'fs-mutex-locks'))).toBe(true);
    expect(existsSync(join(sandbox, 'fs-mutex-locks'))).toBe(false);
  });

  it('keeps PAPERCUSP_FS_MUTEX_LOCK_DIR authoritative over the runtime root', async () => {
    const runtimeDir = join(sandbox, 'xdg-runtime');
    const explicitRoot = join(sandbox, 'explicit-locks');
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = explicitRoot;

    makeRunDir('ws-explicit-lock', 'demo:tool', UUID(11), 8);
    await runScratchGc({ workspaceRegistry: ['ws-explicit-lock'], enforceQuota: false });

    expect(existsSync(explicitRoot)).toBe(true);
    expect(existsSync(join(runtimeDir, 'papercusp', 'fs-mutex-locks'))).toBe(false);
  });
});

describe('scratch retention pins', () => {
  function pin(path: string, expiresAt = new Date(Date.now() + 3600_000).toISOString()) {
    return createRetentionPin({ path, owner: 'reviewer', reason: 'retain evidence', expiresAt });
  }

  it('keeps a run containing a pinned file while deleting an expired sibling, including previews', async () => {
    const kept = makeRunDir('ws-pin', 'tool', UUID(1), 32, RETENTION_MS + 1000);
    const removed = makeRunDir('ws-pin', 'tool', UUID(2), 32, RETENTION_MS + 1000);
    pin(join(kept, 'data.bin'));
    const preview = await runScratchGc({ workspaceRegistry: ['ws-pin'], dryRun: true });
    expect(preview.retentionEvictions).toBe(1);
    expect(existsSync(removed)).toBe(true);
    const actual = await runScratchGc({ workspaceRegistry: ['ws-pin'] });
    expect(actual.retentionEvictions).toBe(1);
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(removed)).toBe(false);
  });

  it('allows retention again after the pin expires', async () => {
    const run = makeRunDir('ws-pin', 'tool', UUID(1), 32, RETENTION_MS + 1000);
    createRetentionPin({ path: run, owner: 'reviewer', reason: 'expired review',
      expiresAt: new Date(Date.now() - 1000).toISOString() }, { nowMs: Date.now() - 2000 });
    await runScratchGc({ workspaceRegistry: ['ws-pin'] });
    expect(existsSync(run)).toBe(false);
  });

  it('keeps a dead workspace containing a pinned descendant', async () => {
    const run = makeRunDir('ws-dead-pin', 'tool', UUID(1), 32);
    pin(join(run, 'data.bin'));
    ageTree(scratchRootForWorkspace('ws-dead-pin'), DEAD_WORKSPACE_QUIET_MS + 60_000);
    const summary = await runScratchGc({ workspaceRegistry: [], scanOpenPaths: noHolders });
    expect(summary.deadWorkspaces).toBe(0);
    expect(summary.deadWorkspacesDeferred).toContainEqual({ workspaceId: 'ws-dead-pin', reason: 'retention-pin' });
    expect(existsSync(run)).toBe(true);
  });

  it('quota eviction skips the pinned oldest run and reclaims an unpinned run', async () => {
    const kept = makeSparseRun('ws-pin', UUID(1), WORKSPACE_QUOTA_BYTES, 2000);
    const removed = makeSparseRun('ws-pin', UUID(2), 1024, 1000);
    pin(kept);
    const summary = await runScratchGc({ workspaceRegistry: ['ws-pin'] });
    expect(summary.quotaEvictions).toBe(1);
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(removed)).toBe(false);
  });

  it('fails closed before deleting when pin metadata is corrupt', async () => {
    const run = makeRunDir('ws-pin', 'tool', UUID(1), 32, RETENTION_MS + 1000);
    mkdirSync(process.env.PAPERCUSP_RELEASE_RETENTION_ROOT!, { recursive: true });
    writeFileSync(join(process.env.PAPERCUSP_RELEASE_RETENTION_ROOT!, 'lease-agent-pin-corrupt.tsv'), 'broken');
    await expect(runScratchGc({ workspaceRegistry: ['ws-pin'] })).rejects.toThrow('retention pins unreadable');
    expect(existsSync(run)).toBe(true);
  });

  it('reads pin state after acquiring the same mutex as pin creation', async () => {
    const run = makeRunDir('ws-pin', 'tool', UUID(1), 32, RETENTION_MS + 1000);
    vi.mocked(statAsync).mockClear();
    let sweep: ReturnType<typeof runScratchGc> | undefined;
    await withFsMutex('papercusp-disk-retention', async () => {
      sweep = runScratchGc({ workspaceRegistry: ['ws-pin'] });
      // Candidate sizing has begun while the pin writer owns the retention mutex.
      await vi.waitFor(() => expect(vi.mocked(statAsync).mock.calls.some(([p]) => String(p) === run)).toBe(true));
      pin(run);
    });
    expect((await sweep!).retentionEvictions).toBe(0);
    expect(existsSync(run)).toBe(true);
  });
});

describe('runScratchGc — retention', () => {
  it('keeps fresh run-dirs', async () => {
    makeRunDir('ws-A', 'demo:tool', UUID(1), 100, 0);
    const r = await runScratchGc({ workspaceRegistry: ['ws-A'] });
    expect(r.retentionEvictions).toBe(0);
    expect(existsSync(ensureScratchRunDir({ workspaceId: 'ws-A', toolName: 'demo:tool', runId: UUID(1) }))).toBe(true);
  });

  it('drops run-dirs past RETENTION_MS', async () => {
    makeRunDir('ws-A', 'demo:tool', UUID(1), 100, RETENTION_MS + 1000);
    const before = ensureScratchRunDir({ workspaceId: 'ws-A', toolName: 'demo:tool', runId: UUID(1) });
    // ensureScratchRunDir doesn't reset mtime — re-stamp old timestamp
    // BEFORE running GC. (utimes was just called by makeRunDir.)
    const r = await runScratchGc({ workspaceRegistry: ['ws-A'] });
    expect(r.retentionEvictions).toBeGreaterThanOrEqual(1);
    expect(existsSync(before)).toBe(false);
  });

  it('does not hold the workspace mutex while sizing retention candidates', async () => {
    const workspaceId = 'ws-retention-admission';
    const staleRun = makeRunDir(workspaceId, 'demo:tool', UUID(20), 100, RETENTION_MS + 1000);
    await refreshScratchUsage(workspaceId);
    const writerPath = join(
      ensureScratchRunDir({ workspaceId, toolName: 'result-door', runId: UUID(21) }),
      'spill.bin',
    );

    const originalStat = vi.mocked(statAsync).getMockImplementation();
    if (!originalStat) throw new Error('async stat mock has no original implementation');
    let releaseSizing!: () => void;
    let reachedSizing!: () => void;
    const sizingGate = new Promise<void>((resolve) => { releaseSizing = resolve; });
    const sizingStarted = new Promise<void>((resolve) => { reachedSizing = resolve; });
    vi.mocked(statAsync).mockImplementation((async (path, options) => {
      const result = await originalStat(path, options);
      if (String(path) === join(staleRun, 'data.bin')) {
        reachedSizing();
        await sizingGate;
      }
      return result;
    }) as typeof statAsync);

    let sweep: Promise<Awaited<ReturnType<typeof runScratchGc>>> | undefined;
    let writer: Promise<void> | undefined;
    try {
      sweep = runScratchGc({ workspaceRegistry: [workspaceId], enforceQuota: false });
      await sizingStarted;

      let writeFinished!: () => void;
      const writeDone = new Promise<void>((resolve) => { writeFinished = resolve; });
      writer = writeWithScratchQuota({ workspaceId, filePath: writerPath, bytes: 1 }, async () => {
        await writeFile(writerPath, Buffer.alloc(1));
        writeFinished();
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const enteredDuringSizing = await Promise.race([
        writeDone.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), 1_000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      expect(enteredDuringSizing).toBe(true);
      await writer;
    } finally {
      releaseSizing();
      vi.mocked(statAsync).mockImplementation(originalStat);
      await Promise.allSettled([...(sweep ? [sweep] : []), ...(writer ? [writer] : [])]);
    }

    expect((await sweep!).retentionEvictions).toBe(1);
    expect(existsSync(staleRun)).toBe(false);
  });

  it('honors an extended requested retention window without relaxing the safe default', async () => {
    const requestedRetentionMs = RETENTION_MS + 60_000;
    const withinRequestedWindow = makeRunDir('ws-A', 'demo:tool', UUID(2), 100, RETENTION_MS + 1_000);
    const beyondRequestedWindow = makeRunDir('ws-A', 'demo:tool', UUID(3), 100, requestedRetentionMs + 1_000);

    const r = await runScratchGc({ workspaceRegistry: ['ws-A'], retentionMs: requestedRetentionMs });

    expect(r.retentionEvictions).toBe(1);
    expect(existsSync(withinRequestedWindow)).toBe(true);
    expect(existsSync(beyondRequestedWindow)).toBe(false);
  });
});

/**
 * WI-10004532: the sweep schedule used to be described by a hand-maintained
 * `GC_INTERVAL_MS = 1h` that nothing read, while the real DBOS crontab was daily. That
 * mismatch made a working GC look broken ("thousands of run dirs older than 24h"). These pin
 * the schedule to ONE source and pin the max-age bound an investigator should check against.
 */
describe('scratch GC schedule — single source + max-age bound (WI-10004532)', () => {
  /** Period of a 6-field (seconds-first) crontab, for the two shapes we use. */
  function crontabPeriodMs(crontab: string): number {
    const f = crontab.trim().split(/\s+/);
    if (f.length !== 6) throw new Error(`expected a 6-field crontab, got: ${crontab}`);
    const fixed = (s: string) => /^\d+$/.test(s);
    const [sec, min, hour, dom, mon, dow] = f;
    if (dom === '*' && mon === '*' && dow === '*') {
      if (fixed(sec) && fixed(min) && fixed(hour)) return 24 * 60 * 60 * 1000;
      if (fixed(sec) && fixed(min) && hour === '*') return 60 * 60 * 1000;
    }
    throw new Error(`crontabPeriodMs does not understand ${crontab}; extend it with the new shape`);
  }

  it('SCRATCH_GC_SWEEP_PERIOD_MS matches SCRATCH_GC_CRONTAB', () => {
    expect(crontabPeriodMs(SCRATCH_GC_CRONTAB)).toBe(SCRATCH_GC_SWEEP_PERIOD_MS);
  });

  it('calibration: the period parser distinguishes daily from hourly', () => {
    expect(crontabPeriodMs('0 0 3 * * *')).toBe(24 * 60 * 60 * 1000);
    expect(crontabPeriodMs('0 0 * * * *')).toBe(60 * 60 * 1000);
  });

  it('the DBOS registration uses SCRATCH_GC_CRONTAB, not a literal crontab', () => {
    const src = readFileSync(new URL('./dbos/periodic-workflows.ts', import.meta.url), 'utf8');
    const call = src.match(/registerScheduled\(\s*scratchGcWorkflow\s*,\s*\{[^}]*\}/);
    expect(call, 'scratchGc registration not found in periodic-workflows.ts').not.toBeNull();
    expect(call![0]).toMatch(/crontab:\s*SCRATCH_GC_CRONTAB\b/);
  });

  it('a run-dir that just escapes one sweep is evicted by the next, before SCRATCH_RUN_DIR_MAX_AGE_MS', async () => {
    const ageAtFirstSweep = RETENTION_MS - 60_000;
    const dir = makeRunDir('ws-A', 'demo:tool', UUID(7), 100, ageAtFirstSweep);
    const t0 = Date.now();

    const first = await runScratchGc({ workspaceRegistry: ['ws-A'], now: t0 });
    expect(first.retentionEvictions).toBe(0);
    expect(existsSync(dir)).toBe(true);

    const second = await runScratchGc({ workspaceRegistry: ['ws-A'], now: t0 + SCRATCH_GC_SWEEP_PERIOD_MS });
    expect(second.retentionEvictions).toBe(1);
    expect(existsSync(dir)).toBe(false);
    // Its age when the second sweep removed it stays inside the documented bound.
    expect(ageAtFirstSweep + SCRATCH_GC_SWEEP_PERIOD_MS).toBeLessThan(SCRATCH_RUN_DIR_MAX_AGE_MS);
  });
});

describe('runScratchGc — dead-workspace cleanup', () => {
  it('drops a quiet, marked scratch root whose workspace is not in the registry', async () => {
    makeRunDir('ws-DEAD', 'demo:tool', UUID(1), 100);
    makeRunDir('ws-ALIVE', 'demo:tool', UUID(2), 100);
    ageTree(join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-DEAD'), DEAD_WORKSPACE_QUIET_MS + 60_000);
    const r = await runScratchGc({ workspaceRegistry: ['ws-ALIVE'], scanOpenPaths: noHolders });
    expect(r.deadWorkspaces).toBe(1);
    expect(r.deadWorkspaceBytes).toBeGreaterThan(0);
    const scratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT!;
    expect(existsSync(join(scratchRoot, 'ws-DEAD'))).toBe(false);
    expect(existsSync(join(scratchRoot, 'ws-ALIVE'))).toBe(true);
  });

  it('is a no-op when scratch root has zero workspace dirs', async () => {
    // The outer beforeEach gave us a fresh sandbox HOME with nothing
    // under .papercusp/scratch yet (this test doesn't call makeRunDir).
    // GC should report no work.
    const r = await runScratchGc({ workspaceRegistry: ['ws-X'] });
    expect(r.deadWorkspaces).toBe(0);
    expect(r.retentionEvictions).toBe(0);
    expect(r.quotaEvictions).toBe(0);
  });
});

describe('reserveScratchSpace — quota enforcement', () => {
  it('accepts a write that fits', () => {
    expect(() => reserveScratchSpace({ workspaceId: 'ws-A', bytes: 1024 })).not.toThrow();
  });

  it('rejects a single write larger than the workspace quota', () => {
    expect(() =>
      reserveScratchSpace({ workspaceId: 'ws-A', bytes: 100 * 1024 * 1024 * 1024 /* 100GB */ }),
    ).toThrow(ScratchQuotaError);
  });

  it('rejects negative bytes', () => {
    expect(() => reserveScratchSpace({ workspaceId: 'ws-A', bytes: -1 })).toThrow(ScratchQuotaError);
  });
});

describe('reserveScratchSpace — no synchronous walk on the hot path (WI-10004513)', () => {
  beforeEach(() => {
    _resetScratchUsageForTests();
  });
  afterEach(() => {
    _resetScratchUsageForTests();
  });

  it('calibration: the spies DO see scratch-gc.ts sync fs calls (so the zero-call assertions are not vacuous)', () => {
    // ensureScratchRunDir is the module's one remaining synchronous fs call (mkdirSync). Seeing it
    // proves the vi.mock above intercepts scratch-gc.ts's own node:fs import, which is the only
    // way the zero-call assertions below could pass vacuously.
    vi.mocked(mkdirSync).mockClear();
    ensureScratchRunDir({ workspaceId: 'ws-A', toolName: 'tool', runId: UUID(9) });
    expect(vi.mocked(mkdirSync)).toHaveBeenCalled();
    // And the spied functions are the ones scratch-gc.ts would call: a direct call is recorded.
    vi.mocked(readdirSync).mockClear();
    readdirSync(process.env.PAPERCUSP_SCRATCH_ROOT!);
    expect(vi.mocked(readdirSync)).toHaveBeenCalled();
  });

  it('performs ZERO synchronous fs calls, however large the tree', async () => {
    // A populated tree: the old implementation did a recursive readdirSync+statSync over all of it
    // on every reservation, which blocked the :3070 worker's event loop past the 20s sentinel.
    for (let i = 0; i < 40; i++) makeRunDir('ws-A', `tool-${i % 4}`, UUID(i), 128);
    await refreshScratchUsage('ws-A'); // fresh cache → no background re-measure either
    vi.mocked(readdirSync).mockClear();
    vi.mocked(statSync).mockClear();
    vi.mocked(existsSync).mockClear();
    for (let i = 0; i < 25; i++) reserveScratchSpace({ workspaceId: 'ws-A', bytes: 64 });
    expect(vi.mocked(readdirSync)).not.toHaveBeenCalled();
    expect(vi.mocked(statSync)).not.toHaveBeenCalled();
    expect(vi.mocked(existsSync)).not.toHaveBeenCalled();
  });

  it('also does no synchronous fs work when the cache is stale (the re-measure is async)', () => {
    makeRunDir('ws-A', 'tool', UUID(1), 4096);
    vi.mocked(readdirSync).mockClear();
    vi.mocked(statSync).mockClear();
    vi.mocked(existsSync).mockClear();
    reserveScratchSpace({ workspaceId: 'ws-A', bytes: 10 }); // never measured → kicks a background refresh
    expect(vi.mocked(readdirSync)).not.toHaveBeenCalled();
    expect(vi.mocked(statSync)).not.toHaveBeenCalled();
    expect(vi.mocked(existsSync)).not.toHaveBeenCalled();
    expect(scratchUsageBytes('ws-A')).toBe(10); // the reservation itself is counted immediately
  });

  it('coalesces stale refreshes and retains reservations made during the first walk', async () => {
    makeRunDir('ws-A', 'tool-a', UUID(1), 1000);
    makeRunDir('ws-A', 'tool-b', UUID(2), 2000);
    const readdirMock = vi.mocked(readdirAsync);
    const originalRead = readdirMock.getMockImplementation();
    if (!originalRead) throw new Error('async readdir mock has no original implementation');
    const read = originalRead as unknown as (path: unknown, options?: unknown) => Promise<unknown>;
    let releaseWalk!: () => void;
    let reachedRoot!: () => void;
    const walkGate = new Promise<void>((resolve) => { releaseWalk = resolve; });
    const atRoot = new Promise<void>((resolve) => { reachedRoot = resolve; });
    let gated = false;
    readdirMock.mockImplementation((async (path: unknown, options?: unknown) => {
      if (!gated && String(path) === scratchRootForWorkspace('ws-A')) {
        gated = true;
        reachedRoot();
        await walkGate;
      }
      return await read(path, options) as never;
    }) as typeof readdirAsync);
    try {
      reserveScratchSpace({ workspaceId: 'ws-A', bytes: 10 });
      await atRoot; // prove the background walk is in flight before the second reservation
      reserveScratchSpace({ workspaceId: 'ws-A', bytes: 10 });
      const firstMeasure = refreshScratchUsage('ws-A'); // joins the gated in-flight measure
      // The second reservation invalidated that snapshot: do not erase its reserved bytes.
      expect(scratchUsageBytes('ws-A')).toBe(20);
      releaseWalk();
      await firstMeasure;
      await refreshScratchUsage('ws-A'); // the clean follow-up may replace the conservative total
      // The workspace-root marker (WI-10006512) is real bytes on disk and is counted too.
      expect(scratchUsageBytes('ws-A')).toBe(3000 + markerBytes('ws-A'));
    } finally {
      releaseWalk();
      readdirMock.mockImplementation(originalRead);
      await refreshScratchUsage('ws-A');
    }
  });

  it('refreshScratchUsage measures the tree size asynchronously (missing tree = 0)', async () => {
    await refreshScratchUsage('ws-empty');
    expect(scratchUsageBytes('ws-empty')).toBe(0);
    makeRunDir('ws-B', 'tool', UUID(3), 5000);
    makeRunDir('ws-B', 'tool', UUID(4), 7000);
    await refreshScratchUsage('ws-B');
    expect(scratchUsageBytes('ws-B')).toBe(12000 + markerBytes('ws-B'));
  });

  it('treats a missing workspace root as empty before the first quota write', async () => {
    const workspaceId = 'ws-first-write';
    const runDir = join(scratchRootForWorkspace(workspaceId), 'tool', UUID(5));
    const filePath = join(runDir, 'payload');
    expect(existsSync(scratchRootForWorkspace(workspaceId))).toBe(false);

    await writeWithScratchQuota({ workspaceId, filePath, bytes: 7 }, async () => {
      await mkdir(runDir, { recursive: true, mode: 0o700 });
      await writeFile(filePath, Buffer.alloc(7));
    });

    expect(readFileSync(filePath)).toHaveLength(7);
    expect(scratchUsageBytes(workspaceId)).toBe(7);
  });

  it('keeps the scratch quota mutex available while a stale usage refresh scans the tree', async () => {
    const workspaceId = 'ws-refresh-outside-lock';
    const runDir = makeRunDir(workspaceId, 'quota', UUID(6), 8);
    const workspaceRoot = resolve(scratchRootForWorkspace(workspaceId));
    const mutexDigest = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 40);
    const mutexName = `papercusp-scratch-quota-${mutexDigest}`;
    const readdirMock = vi.mocked(readdirAsync);
    const originalRead = readdirMock.getMockImplementation()!;
    const read = originalRead as unknown as (path: unknown, options?: unknown) => Promise<unknown>;
    let releaseScan!: () => void;
    let reachedRoot!: () => void;
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    const atRoot = new Promise<void>((resolve) => { reachedRoot = resolve; });
    const wsRoot = scratchRootForWorkspace(workspaceId);
    let rootReads = 0;
    readdirMock.mockImplementation((async (path: unknown, options: unknown) => {
      const entries = await read(path, options);
      if (String(path) === wsRoot && ++rootReads === 1) {
        reachedRoot();
        await scanGate;
      }
      return entries as never;
    }) as typeof readdirAsync);

    const filePath = join(runDir, 'new.bin');
    let write: Promise<void> | undefined;
    let probe: Promise<void> | undefined;
    try {
      write = writeWithScratchQuota({ workspaceId, filePath, bytes: 16 }, async () => {
        await writeFile(filePath, Buffer.alloc(16));
      });
      await atRoot;

      let probeEntered = false;
      probe = withFsMutex(mutexName, async () => { probeEntered = true; }, {
        timeoutMs: 500,
        retryMs: 5,
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const enteredDuringScan = await Promise.race([
        probe.then(() => true, () => false),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), 1_000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      expect(enteredDuringScan).toBe(true);
      expect(probeEntered).toBe(true);

      releaseScan();
      await write;
      await probe;
      expect(rootReads).toBe(1);
      expect(scratchUsageBytes(workspaceId)).toBe(24 + markerBytes(workspaceId));
    } finally {
      releaseScan();
      readdirMock.mockImplementation(originalRead);
      await Promise.allSettled([...(write ? [write] : []), ...(probe ? [probe] : [])]);
    }
  });

  it('does not wait for a stale but valid shared ledger before publishing a spill', async () => {
    const workspaceId = 'ws-stale-ledger-write';
    const runDir = makeRunDir(workspaceId, 'result-door', UUID(7), 8);
    await refreshScratchUsage(workspaceId);

    const readdirMock = vi.mocked(readdirAsync);
    const originalRead = readdirMock.getMockImplementation()!;
    const read = originalRead as unknown as (path: unknown, options?: unknown) => Promise<unknown>;
    let releaseScan!: () => void;
    let reachedRoot!: () => void;
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    const atRoot = new Promise<void>((resolve) => { reachedRoot = resolve; });
    const wsRoot = scratchRootForWorkspace(workspaceId);
    let rootReads = 0;
    readdirMock.mockImplementation((async (path: unknown, options: unknown) => {
      const entries = await read(path, options);
      if (String(path) === wsRoot && ++rootReads === 1) {
        reachedRoot();
        await scanGate;
      }
      return entries as never;
    }) as typeof readdirAsync);

    const staleNow = Date.now() + USAGE_REFRESH_MS + 1;
    const now = vi.spyOn(Date, 'now').mockReturnValue(staleNow);
    const timings: ScratchWriteTimings[] = [];
    const filePath = join(runDir, 'spill.bin');
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => { writeStarted = resolve; });
    let write: Promise<void> | undefined;
    try {
      write = writeWithScratchQuota({
        workspaceId,
        filePath,
        bytes: 16,
        onTiming: (row) => timings.push(row),
      }, async () => {
        await writeFile(filePath, Buffer.alloc(16));
        writeStarted();
      });

      // The stale reconciliation is gated, but the payload reaches the writer first. This is the
      // publication-deadline regression: a result-door spill must not wait on the full scan.
      await started;
      await write;
      await atRoot;
      expect(readFileSync(filePath)).toHaveLength(16);
      expect(timings.find((row) => !row.progress)).toMatchObject({
        refreshWaitMs: 0,
        writeMs: expect.any(Number),
      });
    } finally {
      releaseScan();
      readdirMock.mockImplementation(originalRead);
      now.mockRestore();
      await Promise.allSettled([...(write ? [write] : [])]);
      await refreshScratchUsage(workspaceId);
    }
  });

  it('keeps each workspace walk sequential and caps filesystem work across concurrent workspaces', async () => {
    for (let i = 0; i < 6; i++) {
      makeRunDir('ws-Q', `tool-${i}`, UUID(10 + i), 128);
      makeRunDir('ws-R', `tool-${i}`, UUID(20 + i), 256);
    }
    const readdirMock = vi.mocked(readdirAsync);
    const statMock = vi.mocked(statAsync);
    const originalRead = readdirMock.getMockImplementation();
    const originalStat = statMock.getMockImplementation();
    if (!originalRead || !originalStat) throw new Error('async fs mocks have no original implementation');
    const read = originalRead as unknown as (path: unknown, options?: unknown) => Promise<unknown>;
    const stat = originalStat as unknown as (path: unknown, options?: unknown) => Promise<unknown>;
    const qTools = new Set(Array.from({ length: 6 }, (_, i) => join(scratchRootForWorkspace('ws-Q'), `tool-${i}`)));
    const rTools = new Set(Array.from({ length: 6 }, (_, i) => join(scratchRootForWorkspace('ws-R'), `tool-${i}`)));
    const installGate = (toolDirs: Set<string>) => {
      let release!: () => void;
      let reachedOne!: () => void;
      let reachedTwo!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const oneRead = new Promise<void>((resolve) => { reachedOne = resolve; });
      const twoReads = new Promise<void>((resolve) => { reachedTwo = resolve; });
      let activeFs = 0;
      let maxFs = 0;
      let activeToolReads = 0;
      let maxToolReads = 0;
      const trackStart = () => {
        activeFs += 1;
        maxFs = Math.max(maxFs, activeFs);
      };
      readdirMock.mockImplementation((async (path: unknown, options?: unknown) => {
        trackStart();
        const isToolDir = toolDirs.has(String(path));
        if (isToolDir) {
          activeToolReads += 1;
          maxToolReads = Math.max(maxToolReads, activeToolReads);
          if (activeToolReads >= 1) reachedOne();
          if (activeToolReads >= 2) reachedTwo();
        }
        try {
          if (isToolDir) await gate;
          return await read(path, options);
        } finally {
          if (isToolDir) activeToolReads -= 1;
          activeFs -= 1;
        }
      }) as typeof readdirAsync);
      statMock.mockImplementation((async (path: unknown, options?: unknown) => {
        trackStart();
        try { return await stat(path, options); }
        finally { activeFs -= 1; }
      }) as typeof statAsync);
      return { oneRead, twoReads, release, get maxFs() { return maxFs; }, get maxToolReads() { return maxToolReads; } };
    };
    const waitForSignalOrTimeout = async (signal: Promise<void>) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([signal, new Promise<void>((resolve) => { timeout = setTimeout(resolve, 1000); })]);
      if (timeout) clearTimeout(timeout);
    };
    try {
      const oneScan = installGate(qTools);
      const qScan = refreshScratchUsage('ws-Q');
      try {
        await waitForSignalOrTimeout(oneScan.oneRead);
        expect(oneScan.maxToolReads).toBe(1);
        expect(oneScan.maxFs).toBe(1);
      } finally {
        oneScan.release();
        await qScan;
      }
      expect(scratchUsageBytes('ws-Q')).toBe(6 * 128 + markerBytes('ws-Q'));

      const twoScans = installGate(new Set([...qTools, ...rTools]));
      const bothScans = Promise.all([refreshScratchUsage('ws-Q'), refreshScratchUsage('ws-R')]);
      try {
        await waitForSignalOrTimeout(twoScans.twoReads);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        expect(twoScans.maxToolReads).toBe(2);
        expect(twoScans.maxFs).toBe(2);
      } finally {
        twoScans.release();
        await bothScans;
      }
      expect(scratchUsageBytes('ws-R')).toBe(6 * 256 + markerBytes('ws-R'));
    } finally {
      readdirMock.mockImplementation(originalRead);
      statMock.mockImplementation(originalStat);
    }
  });

  it('still enforces the workspace quota against the cached total', () => {
    _setScratchUsageForTests('ws-A', WORKSPACE_QUOTA_BYTES - 1000);
    expect(() => reserveScratchSpace({ workspaceId: 'ws-A', bytes: 600 })).not.toThrow();
    // 600 is now counted, so another 600 overflows.
    expect(() => reserveScratchSpace({ workspaceId: 'ws-A', bytes: 600 })).toThrow(ScratchQuotaError);
    expect(scratchUsageBytes('ws-A')).toBe(WORKSPACE_QUOTA_BYTES - 400);
  });
});

describe('runScratchGc — no synchronous fs on the event loop (WI-10005135)', () => {
  it('sweeps dead workspaces, expired runs and the quota pass with ZERO synchronous fs calls', async () => {
    // A tree that exercises every pass: a dead workspace, expired and fresh run dirs.
    makeRunDir('ws-DEAD', 'tool', UUID(1), 256);
    ageTree(join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-DEAD'), DEAD_WORKSPACE_QUIET_MS + 60_000);
    for (let i = 0; i < 12; i++) makeRunDir('ws-A', `tool-${i % 3}`, UUID(10 + i), 128, RETENTION_MS + 60_000);
    for (let i = 0; i < 6; i++) makeRunDir('ws-A', `tool-${i % 3}`, UUID(40 + i), 128);
    for (const fn of [readdirSync, statSync, existsSync, rmSync, mkdirSync]) vi.mocked(fn).mockClear();

    const r = await runScratchGc({ workspaceRegistry: ['ws-A'], scanOpenPaths: noHolders });

    // It did the work (so the zero-call assertions below are not vacuous) ...
    expect(r.deadWorkspaces).toBe(1);
    expect(r.retentionEvictions).toBe(12);
    const scratch = process.env.PAPERCUSP_SCRATCH_ROOT!;
    // ... with no synchronous fs call on the calling thread.
    expect(vi.mocked(readdirSync)).not.toHaveBeenCalled();
    expect(vi.mocked(statSync)).not.toHaveBeenCalled();
    expect(vi.mocked(existsSync)).not.toHaveBeenCalled();
    expect(vi.mocked(rmSync)).not.toHaveBeenCalled();
    expect(vi.mocked(mkdirSync)).not.toHaveBeenCalled();
    // Outcome check, read after the assertions so the test's own calls do not count.
    expect(existsSync(join(scratch, 'ws-DEAD'))).toBe(false);
    expect(readdirSync(join(scratch, 'ws-A', 'tool-0')).length).toBe(2);
  });

  it('yields to the event loop while it walks (a timer scheduled before the sweep fires before it ends)', async () => {
    for (let i = 0; i < 6; i++) makeRunDir('ws-A', `tool-${i % 2}`, UUID(60 + i), 64);
    let timerFiredDuringSweep = false;
    let sweepDone = false;
    setTimeout(() => {
      if (!sweepDone) timerFiredDuringSweep = true;
    }, 0);
    await runScratchGc({ workspaceRegistry: ['ws-A'] });
    sweepDone = true;
    expect(timerFiredDuringSweep).toBe(true);
  });

  it('treats a missing scratch root as an empty tree', async () => {
    process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'does-not-exist');
    const r = await runScratchGc({ workspaceRegistry: ['ws-A'] });
    expect(r).toEqual({
      retentionEvictions: 0,
      retentionEvictedBytes: 0,
      deadWorkspaces: 0,
      deadWorkspaceBytes: 0,
      quotaEvictions: 0,
      quotaEvictedBytes: 0,
      markersWritten: 0,
      unprovenEntries: 0,
      deadWorkspacesDeferred: [],
    });
  });

  it('returns a truncated summary when a caller wall-time budget is already exhausted', async () => {
    makeRunDir('ws-A', 'tool', UUID(70), 64, RETENTION_MS + 60_000);
    const r = await runScratchGc({
      workspaceRegistry: ['ws-A'],
      dryRun: true,
      enforceQuota: false,
      maxDurationMs: 0,
    });

    expect(r.truncated).toBe(true);
    expect(r.retentionEvictions).toBe(0);
  });
});

/**
 * WI-10006512 (2026-10-06): the 03:00 sweep `rm -rf`ed every top-level entry under the scratch
 * root that was not a registered workspace id — including a running benchmark's PG datadir in
 * `~/.papercusp/scratch/portable-bench/`, the location the bash resource gate tells agents to use.
 * The pass may now delete only a tree it can PROVE is a dead workspace root, and only when quiet.
 */
describe('runScratchGc — deletes only provably-dead, quiet workspace roots (WI-10006512)', () => {
  const OLD = DEAD_WORKSPACE_QUIET_MS + 60 * 60_000;
  const root = (): string => process.env.PAPERCUSP_SCRATCH_ROOT!;

  /** An agent's own scratch tree: no marker, aged far past every window. */
  function makeAgentDir(name: string): string {
    const dir = join(root(), name);
    mkdirSync(join(dir, 'pg-shared', 'global'), { recursive: true });
    writeFileSync(join(dir, 'pg-shared', 'global', 'pg_control'), Buffer.alloc(64));
    writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\n');
    ageTree(dir, OLD);
    return dir;
  }

  /** A workspace root left behind by a workspace that is no longer registered. */
  function makeDeadWorkspace(workspaceId: string, ageMs = OLD): string {
    makeRunDir(workspaceId, 'demo:tool', UUID(500), 100);
    const dir = join(root(), workspaceId);
    ageTree(dir, ageMs);
    return dir;
  }

  it('never deletes an unmarked agent dir or `packs`, however old, and counts them', async () => {
    const bench = makeAgentDir('portable-bench');
    const packs = makeAgentDir('packs');
    const r = await runScratchGc({ workspaceRegistry: ['papercusp-workspace'], scanOpenPaths: noHolders });
    expect(existsSync(join(bench, 'pg-shared', 'global', 'pg_control'))).toBe(true);
    expect(existsSync(packs)).toBe(true);
    expect(r.deadWorkspaces).toBe(0);
    expect(r.unprovenEntries).toBe(2);
  });

  it('a top-level FILE is never deleted either', async () => {
    mkdirSync(root(), { recursive: true });
    writeFileSync(join(root(), 'notes.txt'), 'keep me');
    ageTree(root(), OLD);
    const r = await runScratchGc({ workspaceRegistry: [], scanOpenPaths: noHolders });
    expect(existsSync(join(root(), 'notes.txt'))).toBe(true);
    expect(r.unprovenEntries).toBe(1);
  });

  it('the scratch writer marks a root it creates, and that root is collected once dead and quiet', async () => {
    const wsRoot = scratchRootForWorkspace('ws-W');
    const deferred: Promise<void>[] = [];
    writeScratchReference({
      filePath: join(wsRoot, 'tool:x', UUID(600), 'a.spill'),
      payload: 'sync',
      workspaceId: 'ws-W',
      mediaType: 'text/plain',
    });
    writeScratchReference({
      filePath: join(scratchRootForWorkspace('ws-V'), 'tool:x', UUID(601), 'b.spill'),
      payload: 'deferred',
      workspaceId: 'ws-V',
      mediaType: 'text/plain',
      deferredWrites: deferred,
    });
    await Promise.all(deferred);
    for (const ws of ['ws-W', 'ws-V']) {
      const marker = JSON.parse(readFileSync(join(root(), ws, WORKSPACE_SCRATCH_MARKER), 'utf8'));
      expect(marker.workspaceId).toBe(ws);
      ageTree(join(root(), ws), OLD);
    }
    const r = await runScratchGc({ workspaceRegistry: [], scanOpenPaths: noHolders });
    expect(r.deadWorkspaces).toBe(2);
    expect(existsSync(wsRoot)).toBe(false);
  });

  it('backfills the marker onto a registered root that predates markers, and never creates a root', async () => {
    const wsRoot = join(root(), 'ws-LEGACY');
    mkdirSync(join(wsRoot, 'tool', UUID(700)), { recursive: true });
    const first = await runScratchGc({ workspaceRegistry: ['ws-LEGACY', 'ws-NO-ROOT'], scanOpenPaths: noHolders });
    expect(first.markersWritten).toBe(1);
    expect(existsSync(join(wsRoot, WORKSPACE_SCRATCH_MARKER))).toBe(true);
    expect(existsSync(join(root(), 'ws-NO-ROOT'))).toBe(false);
    // Once the workspace leaves the registry and goes quiet, the backfilled marker is the proof.
    ageTree(wsRoot, OLD);
    const second = await runScratchGc({ workspaceRegistry: [], scanOpenPaths: noHolders });
    expect(second.deadWorkspaces).toBe(1);
    expect(existsSync(wsRoot)).toBe(false);
  });

  it('keeps a dead workspace whose tree changed recently, even when only a deep file did', async () => {
    const dir = makeDeadWorkspace('ws-BUSY');
    // A deep write leaves every directory mtime old; only the file itself is fresh.
    writeFileSync(join(dir, 'demo:tool', UUID(500), 'data.bin'), 'still writing');
    const r = await runScratchGc({ workspaceRegistry: [], scanOpenPaths: noHolders });
    expect(existsSync(dir)).toBe(true);
    expect(r.deadWorkspacesDeferred).toEqual([{ workspaceId: 'ws-BUSY', reason: 'recent-write' }]);
  });

  it('honors an extended quiet window for dead workspace roots', async () => {
    const dir = makeDeadWorkspace('ws-QUIET', DEAD_WORKSPACE_QUIET_MS + 1_000);
    const requestedQuietMs = DEAD_WORKSPACE_QUIET_MS + 60_000;

    const r = await runScratchGc({ workspaceRegistry: [], scanOpenPaths: noHolders, quietMs: requestedQuietMs });

    expect(existsSync(dir)).toBe(true);
    expect(r.deadWorkspaces).toBe(0);
    expect(r.deadWorkspacesDeferred).toEqual([{ workspaceId: 'ws-QUIET', reason: 'recent-write' }]);
  });

  it('dry-run reports eligible cleanup without deleting paths or writing markers', async () => {
    const deadRoot = makeDeadWorkspace('ws-DRYRUN');
    const liveRoot = join(root(), 'ws-LIVE');
    const staleRun = join(liveRoot, 'demo:tool', UUID(800));
    mkdirSync(staleRun, { recursive: true });
    writeFileSync(join(staleRun, 'data.bin'), Buffer.alloc(100));
    ageTree(liveRoot, RETENTION_MS + 1_000);

    const r = await runScratchGc({ workspaceRegistry: ['ws-LIVE'], scanOpenPaths: noHolders, dryRun: true });

    expect(r.deadWorkspaces).toBe(1);
    expect(r.retentionEvictions).toBe(1);
    expect(r.markersWritten).toBe(0);
    expect(existsSync(deadRoot)).toBe(true);
    expect(existsSync(staleRun)).toBe(true);
    expect(existsSync(join(liveRoot, WORKSPACE_SCRATCH_MARKER))).toBe(false);
  });

  it('keeps a dead workspace a process still holds open', async () => {
    const dir = makeDeadWorkspace('ws-HELD');
    const real = realpathSync(dir);
    const scan = async (paths: readonly string[]): Promise<OpenWriterScan> => ({
      byPath: new Map(paths.filter((p) => p === real).map((p) => [p, ['4242']])),
      complete: true,
    });
    const r = await runScratchGc({ workspaceRegistry: [], scanOpenPaths: scan });
    expect(existsSync(dir)).toBe(true);
    expect(r.deadWorkspacesDeferred).toEqual([{ workspaceId: 'ws-HELD', reason: 'open-writer' }]);
  });

  it('fails closed when the process scan is incomplete or throws', async () => {
    const a = makeDeadWorkspace('ws-PARTIAL');
    const partial = await runScratchGc({
      workspaceRegistry: [],
      scanOpenPaths: async () => ({ byPath: new Map(), complete: false }),
    });
    expect(existsSync(a)).toBe(true);
    expect(partial.deadWorkspacesDeferred).toEqual([{ workspaceId: 'ws-PARTIAL', reason: 'process-scan-incomplete' }]);

    const thrown = await runScratchGc({
      workspaceRegistry: [],
      scanOpenPaths: async () => {
        throw new Error('EACCES /proc');
      },
    });
    expect(existsSync(a)).toBe(true);
    expect(thrown.deadWorkspaces).toBe(0);
  });

  it('a marker naming ANOTHER workspace (a copied tree) is not proof', async () => {
    const original = makeDeadWorkspace('ws-ORIG');
    const copy = join(root(), 'ws-COPY');
    mkdirSync(copy);
    writeFileSync(join(copy, WORKSPACE_SCRATCH_MARKER), readFileSync(join(original, WORKSPACE_SCRATCH_MARKER)));
    ageTree(copy, OLD);
    const r = await runScratchGc({ workspaceRegistry: ['ws-ORIG'], scanOpenPaths: noHolders });
    expect(existsSync(copy)).toBe(true);
    expect(r.unprovenEntries).toBe(1);
  });

  it('a symlink at the top level is not followed into a marked tree', async () => {
    const target = makeDeadWorkspace('ws-TARGET');
    symlinkSync(target, join(root(), 'ws-LINK'));
    const r = await runScratchGc({ workspaceRegistry: ['ws-TARGET'], scanOpenPaths: noHolders });
    expect(existsSync(join(root(), 'ws-LINK'))).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(r.unprovenEntries).toBe(1);
  });

  // The DEFAULT scan (no seam): proves the real /proc wiring matches files BELOW the root
  // (descendants) and working directories (includeCwd), not just the root path itself.
  it('default scan: an open file deep inside the root keeps it', async () => {
    const dir = makeDeadWorkspace('ws-FD');
    const fd = openSync(join(dir, 'demo:tool', UUID(500), 'data.bin'), 'r');
    try {
      const r = await runScratchGc({ workspaceRegistry: [] });
      expect(existsSync(dir)).toBe(true);
      expect(r.deadWorkspaces).toBe(0);
      expect(['open-writer', 'process-scan-incomplete']).toContain(r.deadWorkspacesDeferred[0]?.reason);
    } finally {
      closeSync(fd);
    }
  }, 60_000);

  it('default scan: a process whose cwd is inside the root keeps it', async () => {
    const dir = makeDeadWorkspace('ws-CWD');
    const child = spawn('sleep', ['60'], { cwd: join(dir, 'demo:tool'), stdio: 'ignore' });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
      });
      const r = await runScratchGc({ workspaceRegistry: [] });
      expect(existsSync(dir)).toBe(true);
      expect(r.deadWorkspaces).toBe(0);
      expect(['open-writer', 'process-scan-incomplete']).toContain(r.deadWorkspacesDeferred[0]?.reason);
    } finally {
      child.kill('SIGKILL');
    }
  }, 60_000);
});

describe('runScratchGc — quota eviction', () => {
  it('FIFO-evicts oldest run-dirs when over quota', async () => {
    const oldest = makeSparseRun('ws-Q', UUID(10), 4 * 1024 ** 3, 10_000);
    const newest = makeSparseRun('ws-Q', UUID(11), 2 * 1024 ** 3);
    const result = await runScratchGc({ workspaceRegistry: ['ws-Q'] });
    expect(result.quotaEvictions).toBe(1);
    expect(result.quotaEvictedBytes).toBe(4 * 1024 ** 3);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(newest)).toBe(true);
    expect(scratchEvictionBytes()).toBe(4 * 1024 ** 3);
    // GC also clears the cached full verdict, so a subsequent reservation can succeed.
    expect(() => reserveScratchSpace({ workspaceId: 'ws-Q', bytes: 1024 })).not.toThrow();
  });

  it('can skip quota eviction when the caller only owns retention pruning', async () => {
    const oversized = makeSparseRun('ws-Q', UUID(12), WORKSPACE_QUOTA_BYTES + 1);

    const result = await runScratchGc({ workspaceRegistry: ['ws-Q'], enforceQuota: false });

    expect(result.quotaEvictions).toBe(0);
    expect(existsSync(oversized)).toBe(true);
  });
});

describe('cross-process scratch quota coordination', () => {
  it('shares one workspace quota reservation between writer processes', async () => {
    const workspaceId = 'ws-MULTIPROCESS-QUOTA';
    const workspaceRoot = scratchRootForWorkspace(workspaceId);
    mkdirSync(workspaceRoot, { recursive: true });
    const markerPath = join(workspaceRoot, WORKSPACE_SCRATCH_MARKER);
    const marker = Buffer.from(JSON.stringify({
      kind: 'papercusp-workspace-scratch-root',
      workspaceId,
      markedAt: new Date().toISOString(),
    }) + '\n');
    writeFileSync(markerPath, marker);
    const baselinePath = join(workspaceRoot, 'legacy-baseline.bin');
    const availableBytes = 120;
    writeFileSync(baselinePath, Buffer.alloc(0));
    truncateSync(baselinePath, WORKSPACE_QUOTA_BYTES - availableBytes - marker.length);

    const script = [
      'const { writeWithScratchQuota } = await import(process.env.PC_SCRATCH_GC_MODULE);',
      "const { writeFile } = await import('node:fs/promises');",
      'const workspaceId = process.env.PC_WORKSPACE_ID;',
      'const filePath = process.env.PC_FILE_PATH;',
      'try {',
      '  await writeWithScratchQuota({ workspaceId, filePath, bytes: 80 }, async () => {',
      '    await new Promise((resolve) => setTimeout(resolve, 80));',
      '    await writeFile(filePath, Buffer.alloc(80));',
      '  });',
      '  process.stdout.write(JSON.stringify({ ok: true }));',
      '} catch (error) {',
      '  process.stdout.write(JSON.stringify({ ok: false, code: error && error.code }));',
      '}',
    ].join('\n');
    const baseEnv = {
      PC_SCRATCH_GC_MODULE: new URL('./scratch-gc.ts', import.meta.url).href,
      PC_WORKSPACE_ID: workspaceId,
    };
    const firstPath = join(workspaceRoot, 'writer-one.bin');
    const secondPath = join(workspaceRoot, 'writer-two.bin');
    const first = startScratchChild(script, { ...baseEnv, PC_FILE_PATH: firstPath });
    const second = startScratchChild(script, { ...baseEnv, PC_FILE_PATH: secondPath });
    const [firstResult, secondResult] = await Promise.all([first.finished, second.finished]);

    expect(firstResult.code, firstResult.stderr || firstResult.spawnError || undefined).toBe(0);
    expect(secondResult.code, secondResult.stderr || secondResult.spawnError || undefined).toBe(0);
    const outcomes = [JSON.parse(firstResult.stdout), JSON.parse(secondResult.stdout)];
    expect(outcomes.map((outcome) => outcome.ok).sort()).toEqual([false, true]);
    expect(outcomes.find((outcome) => !outcome.ok)).toMatchObject({ code: 'SCRATCH_QUOTA_EXCEEDED' });
    expect([existsSync(firstPath), existsSync(secondPath)].filter(Boolean)).toHaveLength(1);
  }, 15_000);

  it('waits for a cross-process writer before retention deletes its run directory', async () => {
    const workspaceId = 'ws-MULTIPROCESS-GC';
    const runDir = makeRunDir(workspaceId, 'quota', UUID(8800), 8, RETENTION_MS + 60_000);
    ageTree(runDir, RETENTION_MS + 60_000);
    const filePath = join(runDir, 'live-write.bin');
    const moduleUrl = new URL('./scratch-gc.ts', import.meta.url).href;
    const writerScript = [
      'const { writeWithScratchQuota } = await import(process.env.PC_SCRATCH_GC_MODULE);',
      "const { open, utimes } = await import('node:fs/promises');",
      'const filePath = process.env.PC_FILE_PATH;',
      'const runDir = process.env.PC_RUN_DIR;',
      'const old = new Date(Number(process.env.PC_OLD_MTIME));',
      'await writeWithScratchQuota({ workspaceId: process.env.PC_WORKSPACE_ID, filePath, bytes: 16 }, async () => {',
      "  const handle = await open(filePath, 'w');",
      '  await utimes(runDir, old, old);',
      "  process.send({ type: 'writer-ready' });",
      '  await new Promise((resolve) => setTimeout(resolve, 8_000));',
      "  await handle.writeFile('still-live');",
      '  await handle.close();',
      '  try { const fresh = new Date(); await utimes(runDir, fresh, fresh); } catch {}',
      '});',
      'process.stdout.write(JSON.stringify({ ok: true }));',
    ].join('\n');
    const gcScript = [
      'const { runScratchGc } = await import(process.env.PC_SCRATCH_GC_MODULE);',
      "process.send({ type: 'gc-started' });",
      'const result = await runScratchGc({ workspaceRegistry: [process.env.PC_WORKSPACE_ID] });',
      'process.stdout.write(JSON.stringify({ retentionEvictions: result.retentionEvictions }));',
    ].join('\n');
    const commonEnv = {
      PC_SCRATCH_GC_MODULE: moduleUrl,
      PC_WORKSPACE_ID: workspaceId,
    };
    const writer = startScratchChild(writerScript, {
      ...commonEnv,
      PC_FILE_PATH: filePath,
      PC_RUN_DIR: runDir,
      PC_OLD_MTIME: String(Date.now() - RETENTION_MS - 60_000),
    });
    let gc: ReturnType<typeof startScratchChild> | undefined;
    try {
      await writer.waitForMessage('writer-ready');
      const lockPathEntries = readdirSync(join(sandbox, 'fs-mutex-locks'));
      expect(lockPathEntries.some((entry) => entry.endsWith('.lock'))).toBe(true);
      gc = startScratchChild(gcScript, commonEnv);
      await gc.waitForMessage('gc-started');
      const gcFinishedBeforeWriter = await Promise.race([
        gc.finished.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      expect(gcFinishedBeforeWriter).toBe(false);
      const [writerResult, gcResult] = await Promise.all([writer.finished, gc.finished]);
      expect(writerResult.code, writerResult.stderr || writerResult.spawnError || undefined).toBe(0);
      expect(gcResult.code, gcResult.stderr || gcResult.spawnError || undefined).toBe(0);
      expect(JSON.parse(gcResult.stdout)).toMatchObject({ retentionEvictions: 0 });
      expect(existsSync(filePath)).toBe(true);
    } finally {
      if (writer.child.exitCode === null) writer.child.kill('SIGTERM');
      if (gc?.child.exitCode === null) gc.child.kill('SIGTERM');
    }
  }, 25_000);
});

describe('deferred scratch quota recovery', () => {
  it('the background usage refresh restores quota headroom before a writer needs recovery', async () => {
    const oldest = makeSparseRun('ws-Q', UUID(1), 512 * 1024 ** 2, 10_000);
    const newest = makeSparseRun('ws-Q', UUID(2), 4 * 1024 ** 3 + 410 * 1024 ** 2);
    const phaseRows: ScratchWriteTimings[] = [];

    vi.mocked(rmAsync).mockClear();
    await refreshScratchUsage('ws-Q');

    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(newest)).toBe(true);
    expect(scratchUsageBytes('ws-Q')).toBeLessThanOrEqual(
      WORKSPACE_QUOTA_BYTES - SCRATCH_QUOTA_RECOVERY_HEADROOM_BYTES,
    );

    const filePath = join(newest, 'after-refresh');
    await writeWithScratchQuota({
      workspaceId: 'ws-Q',
      filePath,
      bytes: 512,
      onTiming: (row) => { phaseRows.push(row); },
    }, async () => { await writeFile(filePath, Buffer.alloc(512)); });

    expect(phaseRows).toHaveLength(1);
    expect(phaseRows[0]).toMatchObject({ quotaRecoveryMs: 0, refreshWaitMs: 0 });
    expect(scratchRmCallCount()).toBe(1);
  });

  it('reuses an in-flight usage measurement when quota waiters have not written yet', async () => {
    const runDir = makeRunDir('ws-Q', 'quota', UUID(1), 100);
    const wsRoot = scratchRootForWorkspace('ws-Q');
    _setScratchUsageForTests('ws-Q', WORKSPACE_QUOTA_BYTES + 1);
    const readdirMock = vi.mocked(readdirAsync);
    const originalRead = readdirMock.getMockImplementation();
    if (!originalRead) throw new Error('readdir mock has no original implementation');
    const read = originalRead as unknown as (path: unknown, options?: unknown) => Promise<unknown>;
    let releaseRead!: () => void;
    let reachedRoot!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const atRoot = new Promise<void>((resolve) => { reachedRoot = resolve; });
    let rootReads = 0;
    readdirMock.mockImplementation((async (path: unknown, options: unknown) => {
      const entries = await read(path, options);
      if (String(path) === wsRoot && ++rootReads === 1) {
        reachedRoot();
        await readGate;
      }
      return entries as never;
    }) as typeof readdirAsync);
    const measurement = refreshScratchUsage('ws-Q');
    const scansAtWrite: number[] = [];
    const phaseRows: ScratchWriteTimings[] = [];
    const doorPhases: ScratchWriteTimings[] = [];
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    let writers: Promise<void>[] = [];
    let door: ReturnType<typeof applyResultDoorAsync> | undefined;
    try {
      await atRoot;
      writers = Array.from({ length: 3 }, (_, i) => {
        const filePath = join(runDir, `write-${i}`);
        return writeWithScratchQuota({ workspaceId: 'ws-Q', filePath, bytes: 512,
          onTiming: (row) => { phaseRows[i] = row; } }, async () => {
          scansAtWrite.push(rootReads);
          await writeFile(filePath, Buffer.alloc(512));
        });
      });
      const checkpoint = 'late checkpoint content '.repeat(RESULT_DOOR_TOKENS);
      door = applyResultDoorAsync({ content: [{ type: 'text', text: checkpoint }] }, {
        toolName: 'work_items:get', workspaceId: 'ws-Q', runId: UUID(2),
        onScratchWriteTiming: (row) => { doorPhases.push(row); },
      });
      // A waiting writer has neither reserved bytes nor changed the measured filesystem.
      expect(scansAtWrite).toEqual([]);
      expect(phaseRows).toEqual([]);
      clock = 25;
      releaseRead();
      await measurement;
      await Promise.all(writers);
      const result = await door;
      const spillPath = (result._meta?.resultDoor as { spillPath?: string } | undefined)?.spillPath;
      expect(spillPath).toBeTypeOf('string');
      const spill = readFileSync(spillPath!);
      expect(parseScratchReference(spill)?.payload.toString()).toContain(checkpoint);
      expect(JSON.stringify(result.content)).toContain(spillPath);
      expect(scansAtWrite).toEqual([1, 1, 1]);
      expect(rootReads).toBe(1);
      expect(phaseRows[0]).toMatchObject({ quotaWaitMs: 0, refreshWaitMs: 25, quotaRecoveryMs: 0, writeMs: 0, totalMs: 25 });
      expect(phaseRows.slice(1)).toMatchObject(Array(2).fill({ quotaWaitMs: 25, refreshWaitMs: 0, quotaRecoveryMs: 0, writeMs: 0, totalMs: 25 }));
      expect(doorPhases.filter((row) => !row.progress)).toMatchObject([
        { quotaWaitMs: 25, refreshWaitMs: 0, quotaRecoveryMs: 0, writeMs: 0, totalMs: 25 },
      ]);
      expect(scratchUsageBytes('ws-Q')).toBe(100 + markerBytes('ws-Q') + 3 * 512 + spill.length);
    } finally {
      releaseRead();
      await Promise.allSettled([measurement, ...writers, ...(door ? [door] : [])]);
      // Drain any follow-up refresh before restoring the test's scratch root.
      await refreshScratchUsage('ws-Q');
      readdirMock.mockImplementation(originalRead);
      now.mockRestore();
    }
  });

  it('attributes a gated FIFO scan to its initiator and the shared wait to its follower', async () => {
    makeSparseRun('ws-Q', UUID(1), WORKSPACE_QUOTA_BYTES + 1024);
    _setScratchUsageForTests('ws-Q', WORKSPACE_QUOTA_BYTES + 1024);
    const readdirMock = vi.mocked(readdirAsync);
    const originalRead = readdirMock.getMockImplementation()!;
    const read = originalRead as unknown as (path: unknown, options?: unknown) => Promise<unknown>;
    const statMock = vi.mocked(statAsync);
    const originalStat = statMock.getMockImplementation()!;
    let clock = 0;
    let rootOperationStartedAt = 0;
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const atRoot = new Promise<void>((resolve) => { reached = resolve; });
    let gated = false;
    readdirMock.mockImplementation((async (path: unknown, options: unknown) => {
      const entries = await read(path, options);
      if (!gated && String(path) === scratchRootForWorkspace('ws-Q')) {
        gated = true;
        rootOperationStartedAt = clock;
        reached();
        await gate;
      }
      clock += 2;
      return entries as never;
    }) as typeof readdirAsync);
    statMock.mockImplementation((async (...args: Parameters<typeof statAsync>) => {
      const stats = await originalStat(...args);
      clock += 3;
      return stats;
    }) as typeof statAsync);
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const phases: ScratchWriteTimings[] = [];
    const writes: Promise<void>[] = [];
    try {
      writes.push(writeWithScratchQuota({ workspaceId: 'ws-Q', filePath: join(scratchRootForWorkspace('ws-Q'), 'first'), bytes: 16,
        onTiming: (row) => { phases[0] = row; } }, async () => {}));
      await atRoot;
      writes.push(writeWithScratchQuota({ workspaceId: 'ws-Q', filePath: join(scratchRootForWorkspace('ws-Q'), 'second'), bytes: 16,
        onTiming: (row) => { phases[1] = row; } }, async () => {}));
      clock = 40; release(); await Promise.all(writes);
      expect(phases[0]).toMatchObject({
        quotaWaitMs: expect.any(Number), refreshWaitMs: 0, quotaRecoveryMs: expect.any(Number), writeMs: 0, totalMs: expect.any(Number),
        quotaRecoveryDiagnostics: {
          sizeWalkMs: expect.any(Number),
          sizeWalkDirectories: expect.any(Number),
          sizeWalkEntries: expect.any(Number),
          sizeWalkFiles: expect.any(Number),
          readdirOperations: expect.any(Number),
          statOperations: expect.any(Number),
          operationTotalMs: expect.any(Number),
          maxOperationMs: expect.any(Number),
          maxOperationKind: 'readdir',
          currentOperationKind: null,
          currentOperationElapsedMs: 0,
          directoryReadErrors: 0,
          fileStatErrors: 0,
          runListingMs: expect.any(Number),
          runsListed: 1,
          selectedRunSizingMs: 0,
          runsConsidered: 1,
          fallbackRunSizes: 0,
          deletionMs: expect.any(Number),
          deleteAttempts: 1,
          runsDeleted: 1,
          deletedBytes: expect.any(Number),
        },
      });
      expect(phases[0].quotaRecoveryDiagnostics?.sizeWalkDirectories).toBeGreaterThan(0);
      expect(phases[0].quotaRecoveryDiagnostics?.sizeWalkEntries).toBeGreaterThan(0);
      expect(phases[0].quotaRecoveryDiagnostics?.sizeWalkFiles).toBeGreaterThan(0);
      expect(phases[0].quotaRecoveryDiagnostics?.readdirOperations)
        .toBeGreaterThanOrEqual(phases[0].quotaRecoveryDiagnostics?.sizeWalkDirectories ?? 0);
      expect(phases[0].quotaRecoveryDiagnostics?.statOperations)
        .toBeGreaterThanOrEqual(phases[0].quotaRecoveryDiagnostics?.sizeWalkFiles ?? 0);
      expect(phases[0].quotaRecoveryDiagnostics?.operationTotalMs).toBeGreaterThan(0);
      expect(phases[0].quotaRecoveryDiagnostics?.maxOperationMs)
        .toBeGreaterThanOrEqual(40 - rootOperationStartedAt);
      expect(phases[0].quotaRecoveryMs).toBeGreaterThanOrEqual(40 - rootOperationStartedAt);
      expect(phases[1]).toMatchObject({
        quotaWaitMs: expect.any(Number), refreshWaitMs: 0, quotaRecoveryMs: 0,
        writeMs: 0, totalMs: expect.any(Number),
      });
      expect(phases[1].quotaWaitMs).toBeGreaterThanOrEqual(phases[0].quotaRecoveryMs);
      expect(phases[1].totalMs).toBeGreaterThanOrEqual(phases[1].quotaWaitMs);
    } finally {
      release(); await Promise.allSettled(writes);
      readdirMock.mockImplementation(originalRead); now.mockRestore();
      statMock.mockImplementation(originalStat);
    }
  });

  it('emits bounded progress every five seconds while a quota recovery phase is pending', async () => {
    makeSparseRun('ws-Q', UUID(1), WORKSPACE_QUOTA_BYTES + 1024);
    _setScratchUsageForTests('ws-Q', WORKSPACE_QUOTA_BYTES + 1024);
    const readdirMock = vi.mocked(readdirAsync);
    const originalRead = readdirMock.getMockImplementation()!;
    const read = originalRead as unknown as (path: unknown, options?: unknown) => Promise<unknown>;
    let releaseScan!: () => void;
    let reachedRoot!: () => void;
    let rootReads = 0;
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    const atRoot = new Promise<void>((resolve) => { reachedRoot = resolve; });
    readdirMock.mockImplementation((async (path: unknown, options: unknown) => {
      const entries = await read(path, options);
      if (String(path) === scratchRootForWorkspace('ws-Q') && ++rootReads === 2) {
        reachedRoot();
        await scanGate;
      }
      return entries as never;
    }) as typeof readdirAsync);
    const timings: ScratchWriteTimings[] = [];
    const filePath = join(scratchRootForWorkspace('ws-Q'), 'quota', UUID(2), 'progress.bin');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const write = writeWithScratchQuota({
      workspaceId: 'ws-Q',
      filePath,
      bytes: 16,
      onTiming: (row) => timings.push(row),
    }, async () => {});
    try {
      await atRoot;
      await vi.advanceTimersByTimeAsync(15_000);
      const progressRows = timings.filter((row) => row.progress);
      expect(progressRows).toHaveLength(3);
      for (const row of progressRows) {
        expect(row.progress).toMatchObject({
          phase: 'quota-recovery',
          bytes: 16,
          pendingWrites: 1,
          recoveryActive: true,
          refreshActive: false,
          quotaRecoveryDiagnostics: {
            sizeWalkMs: expect.any(Number),
            sizeWalkDirectories: expect.any(Number),
            sizeWalkEntries: expect.any(Number),
            readdirOperations: expect.any(Number),
            currentOperationKind: 'readdir',
            currentOperationElapsedMs: expect.any(Number),
          },
        });
        expect(row.progress?.quotaRecoveryDiagnostics?.sizeWalkDirectories).toBeGreaterThan(0);
        expect(row.progress?.quotaRecoveryDiagnostics?.readdirOperations).toBeGreaterThan(0);
      }
      expect(JSON.stringify(progressRows)).not.toContain(scratchRootForWorkspace('ws-Q'));
      expect(JSON.stringify(progressRows)).not.toContain(UUID(1));
      releaseScan();
      await write;
      expect(timings.filter((row) => row.progress)).toHaveLength(3);
      expect(timings.find((row) => !row.progress)).toMatchObject({
        quotaRecoveryMs: expect.any(Number),
        writeMs: expect.any(Number),
      });
    } finally {
      releaseScan();
      readdirMock.mockImplementation(originalRead);
      vi.useRealTimers();
      await Promise.allSettled([write]);
    }
  });

  it('includes background scan counters in progress while a writer waits for usage refresh', async () => {
    const wsRoot = scratchRootForWorkspace('ws-Q');
    makeSparseRun('ws-Q', UUID(1), 128);
    makeRunDir('ws-Q', 'extra', UUID(3), 128);
    _setScratchUsageForTests('ws-Q', WORKSPACE_QUOTA_BYTES + 1024);

    const readdirMock = vi.mocked(readdirAsync);
    const originalRead = readdirMock.getMockImplementation()!;
    const read = originalRead as unknown as (path: unknown, options?: unknown) => Promise<unknown>;
    const statMock = vi.mocked(statAsync);
    const originalStat = statMock.getMockImplementation()!;
    const measuredRunDirs = [
      join(wsRoot, 'quota', UUID(1)),
      join(wsRoot, 'extra', UUID(3)),
    ];
    let activeWalkOperations = 0;
    let maxConcurrentWalkOperations = 0;
    const trackStart = (path: unknown): boolean => {
      const value = String(path);
      const isMeasuredPath = value === wsRoot
        || value === join(wsRoot, 'quota')
        || value === join(wsRoot, 'extra')
        || measuredRunDirs.some((runDir) => value === runDir || value.startsWith(`${runDir}/`));
      if (!isMeasuredPath) return false;
      activeWalkOperations += 1;
      maxConcurrentWalkOperations = Math.max(maxConcurrentWalkOperations, activeWalkOperations);
      return true;
    };
    const trackEnd = (tracked: boolean): void => {
      if (tracked) activeWalkOperations -= 1;
    };
    let releaseScan!: () => void;
    let reachedRoot!: () => void;
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    const atRoot = new Promise<void>((resolve) => { reachedRoot = resolve; });
    let rootReads = 0;
    readdirMock.mockImplementation((async (path: unknown, options: unknown) => {
      const tracked = trackStart(path);
      try {
        const entries = await read(path, options);
        if (String(path) === wsRoot && ++rootReads === 1) {
          reachedRoot();
          await scanGate;
        }
        if (tracked) await new Promise<void>((resolve) => setTimeout(resolve, 2));
        return entries as never;
      } finally {
        trackEnd(tracked);
      }
    }) as typeof readdirAsync);
    statMock.mockImplementation((async (...args: Parameters<typeof statAsync>) => {
      const tracked = trackStart(args[0]);
      try {
        if (tracked) await new Promise<void>((resolve) => setTimeout(resolve, 2));
        return await originalStat(...args);
      } finally {
        trackEnd(tracked);
      }
    }) as typeof statAsync);

    const timings: ScratchWriteTimings[] = [];
    const measurement = refreshScratchUsage('ws-Q');
    let write: Promise<void> | undefined;
    let progressTimeout: ReturnType<typeof setTimeout> | undefined;
    let observedProgress!: () => void;
    const progressObserved = new Promise<void>((resolveObserved, rejectObserved) => {
      observedProgress = resolveObserved;
      progressTimeout = setTimeout(() => rejectObserved(new Error('filesystem waiter progress was not observed')), 2_000);
    });
    try {
      await atRoot;
      const filePath = join(wsRoot, 'quota', UUID(2), 'refresh-wait.bin');
      write = writeWithScratchQuota({
        workspaceId: 'ws-Q',
        filePath,
        bytes: 16,
        onTiming: (row) => {
          timings.push(row);
          if (row.progress?.phase === 'usage-refresh-wait' && row.progress.refreshActive) observedProgress();
        },
      }, async () => {});

      await progressObserved;
      expect(timings.find((row) => row.progress?.phase === 'usage-refresh-wait')?.progress).toMatchObject({
        phase: 'usage-refresh-wait',
        pendingWrites: 1,
        recoveryActive: true,
        refreshActive: true,
        usageRefreshDiagnostics: {
          sizeWalkDirectories: 1,
          sizeWalkEntries: 0,
          sizeWalkFiles: 0,
        },
      });

      releaseScan();
      await measurement;
      await write;
      expect(rootReads).toBe(1);
      expect(maxConcurrentWalkOperations).toBe(1);
      expect(timings.find((row) => !row.progress)).toMatchObject({
        quotaRecoveryMs: 0,
        writeMs: expect.any(Number),
      });
    } finally {
      if (progressTimeout) clearTimeout(progressTimeout);
      releaseScan();
      readdirMock.mockImplementation(originalRead);
      statMock.mockImplementation(originalStat);
      await Promise.allSettled([measurement, ...(write ? [write] : [])]);
    }
  });

  it('includes background scan diagnostics in progress while a file write overlaps usage refresh', async () => {
    const wsRoot = scratchRootForWorkspace('ws-Q');
    makeSparseRun('ws-Q', UUID(1), 128);
    _setScratchUsageForTests('ws-Q', 0);

    const readdirMock = vi.mocked(readdirAsync);
    const originalRead = readdirMock.getMockImplementation()!;
    const read = originalRead as unknown as (path: unknown, options?: unknown) => Promise<unknown>;
    let releaseScan!: () => void;
    let reachedRoot!: () => void;
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    const atRoot = new Promise<void>((resolve) => { reachedRoot = resolve; });
    let rootReads = 0;
    readdirMock.mockImplementation((async (path: unknown, options: unknown) => {
      const entries = await read(path, options);
      if (String(path) === wsRoot && ++rootReads === 1) {
        reachedRoot();
        await scanGate;
      }
      return entries as never;
    }) as typeof readdirAsync);

    const timings: ScratchWriteTimings[] = [];
    let releaseWrite!: () => void;
    let startedWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writeStarted = new Promise<void>((resolve) => { startedWrite = resolve; });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const measurement = refreshScratchUsage('ws-Q');
    let write: Promise<void> | undefined;
    try {
      await atRoot;
      const filePath = join(wsRoot, 'quota', UUID(2), 'write-during-refresh.bin');
      write = writeWithScratchQuota({
        workspaceId: 'ws-Q',
        filePath,
        bytes: 16,
        onTiming: (row) => timings.push(row),
      }, async () => {
        startedWrite();
        await writeGate;
      });

      await writeStarted;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(timings).toHaveLength(1);
      expect(timings[0].progress).toMatchObject({
        phase: 'file-write',
        pendingWrites: 1,
        recoveryActive: false,
        refreshActive: true,
        usageRefreshDiagnostics: {
          readdirOperations: expect.any(Number),
          currentOperationKind: 'readdir',
          currentOperationElapsedMs: expect.any(Number),
        },
      });
      expect(timings[0].progress?.usageRefreshDiagnostics?.readdirOperations).toBeGreaterThan(0);
      expect(timings[0].progress?.usageRefreshDiagnostics?.currentOperationElapsedMs).toBeGreaterThan(0);

      releaseScan();
      await measurement;
      releaseWrite();
      await write;
      expect(timings.find((row) => !row.progress)).toMatchObject({
        quotaRecoveryMs: 0,
        writeMs: expect.any(Number),
      });
    } finally {
      releaseScan();
      releaseWrite();
      readdirMock.mockImplementation(originalRead);
      vi.useRealTimers();
      await Promise.allSettled([measurement, ...(write ? [write] : [])]);
    }
  });

  it('reports a failed filesystem write without letting its diagnostic observer replace the error', async () => {
    _setScratchUsageForTests('ws-Q', 0);
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const phases: ScratchWriteTimings[] = [];
    const failure = new Error('controlled filesystem failure');
    try {
      await expect(writeWithScratchQuota({ workspaceId: 'ws-Q', filePath: join(scratchRootForWorkspace('ws-Q'), 'failed'), bytes: 16,
        onTiming: (row) => { phases.push(row); throw new Error('observer failure'); } }, async () => {
        clock = 70; throw failure;
      })).rejects.toBe(failure);
      expect(phases).toMatchObject([{ quotaWaitMs: 0, refreshWaitMs: 0, quotaRecoveryMs: 0, writeMs: 70, totalMs: 70 }]);
      expect(scratchUsageBytes('ws-Q')).toBe(0);
    } finally { now.mockRestore(); }
  });

  it.each([false, true])('replaces stale over-quota usage with an active reservation (already written: %s)', async (alreadyWritten) => {
    const runDir = makeRunDir('ws-Q', 'quota', UUID(1), 100);
    _setScratchUsageForTests('ws-Q', 0);
    let finish!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const heldPath = join(runDir, 'held');
    const held = writeWithScratchQuota({ workspaceId: 'ws-Q', filePath: heldPath, bytes: 512 }, async () => {
      if (alreadyWritten) await writeFile(heldPath, Buffer.alloc(512));
      started();
      await new Promise<void>((resolve) => { finish = resolve; });
      if (!alreadyWritten) await writeFile(heldPath, Buffer.alloc(512));
    });
    await began;
    // Another process can reclaim old runs while this process retains their cached size.
    _setScratchUsageForTests('ws-Q', 5_400_804_525);
    const nextPath = join(runDir, 'next');
    const next = writeWithScratchQuota({ workspaceId: 'ws-Q', filePath: nextPath, bytes: 6709 },
      () => writeFile(nextPath, Buffer.alloc(6709)));
    // Submit the follower while the active reservation owns the workspace mutex, then let the
    // holder settle so the follower can reconcile the now-current shared quota state.
    finish();
    try {
      await expect(next).resolves.toBeUndefined();
      expect(scratchUsageBytes('ws-Q')).toBe(100 + markerBytes('ws-Q') + 512 + 6709);
    } finally {
      finish();
      await held;
    }
    await refreshScratchUsage('ws-Q');
    expect(scratchUsageBytes('ws-Q')).toBe(100 + markerBytes('ws-Q') + 512 + 6709);
  });

  it('replaces stale over-quota usage when multiple waiters join the recovery walk', async () => {
    const runDir = makeRunDir('ws-Q', 'quota', UUID(1), 100);
    _setScratchUsageForTests('ws-Q', 5_400_804_525);
    vi.mocked(rmAsync).mockClear();
    await Promise.all(Array.from({ length: 8 }, (_, i) => {
      const filePath = join(runDir, `write-${i}`);
      return writeWithScratchQuota({ workspaceId: 'ws-Q', filePath, bytes: 6709 },
        () => writeFile(filePath, Buffer.alloc(6709)));
    }));
    await refreshScratchUsage('ws-Q');
    expect(scratchUsageBytes('ws-Q')).toBe(100 + markerBytes('ws-Q') + 8 * 6709);
    expect(scratchRmCallCount()).toBe(0);
  });

  it('lets a spill finish while stale shared quota reconciliation is still scanning', async () => {
    const workspaceId = 'ws-Q';
    const workspaceRoot = scratchRootForWorkspace(workspaceId);
    const firstPath = join(workspaceRoot, 'quota', UUID(1), 'first.spill');
    await writeWithScratchQuota({ workspaceId, filePath: firstPath, bytes: 16 }, async () => {
      await mkdir(dirname(firstPath), { recursive: true });
      await writeFile(firstPath, Buffer.alloc(16));
    });

    // Make the already valid cross-process ledger stale. The next reservation can safely
    // advance it; a full tree reconciliation should run after that spill settles.
    const statePath = join(
      dirname(dirname(workspaceRoot)),
      'scratch-quota-state',
      createHash('sha256').update(resolve(workspaceRoot)).digest('hex') + '.json',
    );
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { updatedAt: number };
    writeFileSync(statePath, JSON.stringify({ ...state, updatedAt: Date.now() - USAGE_REFRESH_MS - 1 }));

    const readdirMock = vi.mocked(readdirAsync);
    const originalRead = readdirMock.getMockImplementation()!;
    const read = originalRead as unknown as (path: unknown, options?: unknown) => Promise<unknown>;
    let releaseScan!: () => void;
    let reachedRoot!: () => void;
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    const scanStarted = new Promise<void>((resolve) => { reachedRoot = resolve; });
    let gated = false;
    readdirMock.mockImplementation((async (path: unknown, options: unknown) => {
      const entries = await read(path, options);
      if (!gated && String(path) === workspaceRoot) {
        gated = true;
        reachedRoot();
        await scanGate;
      }
      return entries as never;
    }) as typeof readdirAsync);

    const spillPath = join(workspaceRoot, 'quota', UUID(2), 'after-stale.spill');
    let spillSettled = false;
    const spill = writeWithScratchQuota({ workspaceId, filePath: spillPath, bytes: 16 }, async () => {
      await mkdir(dirname(spillPath), { recursive: true });
      await writeFile(spillPath, Buffer.alloc(16));
    }).then(() => { spillSettled = true; });
    try {
      await scanStarted;
      expect(spillSettled).toBe(true);
      expect(existsSync(spillPath)).toBe(true);
    } finally {
      releaseScan();
      readdirMock.mockImplementation(originalRead);
      await Promise.allSettled([spill, refreshScratchUsage(workspaceId)]);
    }
  });

  it('coalesces pressure recovery while preserving concurrent reservations without synchronous scans', async () => {
    const old = makeSparseRun('ws-Q', UUID(1), 4 * 1024 ** 3, 10_000);
    const fresh = makeSparseRun('ws-Q', UUID(2), 1024 ** 3);
    const oldDataPath = join(old, 'data.bin');
    _setScratchUsageForTests('ws-Q', WORKSPACE_QUOTA_BYTES + markerBytes('ws-Q'));
    vi.mocked(readdirAsync).mockClear();
    vi.mocked(rmAsync).mockClear();
    vi.mocked(statAsync).mockClear();
    vi.mocked(readdirSync).mockClear();
    vi.mocked(statSync).mockClear();
    let oldDataStatsAtFirstWrite = -1;
    await Promise.all(Array.from({ length: 8 }, (_, i) => {
      const filePath = join(fresh, `write-${i}`);
      return writeWithScratchQuota({ workspaceId: 'ws-Q', filePath, bytes: 100 },
        async () => {
          if (oldDataStatsAtFirstWrite < 0) {
            oldDataStatsAtFirstWrite = vi.mocked(statAsync).mock.calls
              .filter(([path]) => path === oldDataPath).length;
          }
          await writeFile(filePath, Buffer.alloc(100));
        });
    }));
    expect(existsSync(old)).toBe(false);
    expect(scratchRmCallCount()).toBe(1);
    expect(oldDataStatsAtFirstWrite).toBe(1);
    // One shared usage walk plus FIFO discovery. Waiting callers do not trigger another walk.
    expect(vi.mocked(readdirAsync).mock.calls.filter(([path]) => path === scratchRootForWorkspace('ws-Q'))).toHaveLength(2);
    expect(vi.mocked(readdirSync)).not.toHaveBeenCalled();
    expect(vi.mocked(statSync)).not.toHaveBeenCalled();
    await refreshScratchUsage('ws-Q');
    expect(scratchUsageBytes('ws-Q')).toBe(1024 ** 3 + markerBytes('ws-Q') + 800);
  });

  it('uses a stable per-run index and sizes only FIFO candidates during request recovery', async () => {
    const oldest = makeSparseRun('ws-Q', UUID(1), 2 * 1024 ** 3, 10_000);
    const otherRuns = Array.from({ length: 12 }, (_, i) =>
      makeSparseRun('ws-Q', '00000000-0000-4000-8000-' + (i + 2).toString().padStart(12, '0'), 1024));
    await refreshScratchUsage('ws-Q');
    // Simulate accumulated reservations above the quota while preserving the stable run index.
    _setScratchUsageForTests('ws-Q', WORKSPACE_QUOTA_BYTES + 2048, Date.now(), true);
    vi.mocked(readdirAsync).mockClear();
    vi.mocked(statAsync).mockClear();

    const timings: ScratchWriteTimings[] = [];
    const writePath = join(otherRuns[0], 'recovery.bin');
    await writeWithScratchQuota({
      workspaceId: 'ws-Q', filePath: writePath, bytes: 64,
      onTiming: (row) => timings.push(row),
    }, async () => {
      await writeFile(writePath, Buffer.alloc(64));
      expect(existsSync(oldest)).toBe(false);
      expect(otherRuns.every((run) => existsSync(run))).toBe(true);
    });

    const recovery = timings[0]?.quotaRecoveryDiagnostics;
    expect(recovery).toMatchObject({ sizeWalkMs: 0, runsConsidered: 1, deleteAttempts: 1 });
    expect(recovery?.selectedRunSizingMs).toBeGreaterThanOrEqual(0);
    const dataFileStats = vi.mocked(statAsync).mock.calls
      .map(([path]) => String(path))
      .filter((path) => path.endsWith('/data.bin') || path.endsWith('/recovery.bin'));
    expect(dataFileStats).toEqual([join(oldest, 'data.bin')]);
    const sizedRunReads = vi.mocked(readdirAsync).mock.calls
      .map(([path]) => String(path))
      .filter((path) => [oldest, ...otherRuns].includes(path));
    expect(sizedRunReads).toEqual([oldest]);
    await refreshScratchUsage('ws-Q');
  });

  it('invalidates the local run index when another process advances the shared quota revision', async () => {
    const oldest = makeSparseRun('ws-Q', UUID(1), 2 * 1024 ** 3, 10_000);
    const otherRuns = Array.from({ length: 12 }, (_, i) =>
      makeSparseRun('ws-Q', '00000000-0000-4000-8000-' + (i + 2).toString().padStart(12, '0'), 1024));
    await refreshScratchUsage('ws-Q');
    const measuredBytes = scratchUsageBytes('ws-Q');
    const externalRunBytes = 4 * 1024 ** 3;
    const externalRun = makeSparseRun('ws-Q', UUID(20), externalRunBytes, 5_000);
    const sharedBytes = measuredBytes + externalRunBytes;

    // A second process updates only the shared file. The parent keeps its old local revision,
    // so quota recovery must discard the otherwise-complete run index and reconcile the tree.
    const script = [
      'const { _setScratchUsageForTests } = await import(process.env.PC_SCRATCH_GC_MODULE);',
      'await new Promise((resolve) => setTimeout(resolve, 5));',
      "_setScratchUsageForTests(process.env.PC_WORKSPACE_ID, Number(process.env.PC_BYTES), Date.now(), true);",
      "process.stdout.write(JSON.stringify({ ok: true }));",
    ].join('\n');
    const child = startScratchChild(script, {
      PC_SCRATCH_GC_MODULE: new URL('./scratch-gc.ts', import.meta.url).href,
      PC_WORKSPACE_ID: 'ws-Q',
      PC_BYTES: String(sharedBytes),
    });
    const childResult = await child.finished;
    expect(childResult.code, childResult.stderr || childResult.spawnError || undefined).toBe(0);
    expect(JSON.parse(childResult.stdout)).toMatchObject({ ok: true });

    vi.mocked(readdirAsync).mockClear();
    const timings: ScratchWriteTimings[] = [];
    const writePath = join(otherRuns[0], 'recovery.bin');
    await writeWithScratchQuota({
      workspaceId: 'ws-Q', filePath: writePath, bytes: 64,
      onTiming: (row) => timings.push(row),
    }, async () => {
      await writeFile(writePath, Buffer.alloc(64));
      expect(existsSync(oldest)).toBe(false);
      expect(existsSync(externalRun)).toBe(true);
      expect(otherRuns.every((run) => existsSync(run))).toBe(true);
    });

    expect(timings[0]?.quotaRecoveryDiagnostics?.sizeWalkMs).toBeGreaterThan(0);
    const sizeWalkDirectories = vi.mocked(readdirAsync).mock.calls
      .filter(([, options]) => options != null && typeof options === 'object' && 'withFileTypes' in options)
      .map(([path]) => String(path));
    expect(sizeWalkDirectories).toContain(scratchRootForWorkspace('ws-Q'));
    await refreshScratchUsage('ws-Q');
  });

  it('corrects cached usage when another process already removed an indexed FIFO run', async () => {
    const removedRunBytes = 300 * 1024 ** 2;
    const removedRun = makeSparseRun('ws-Q', UUID(1), removedRunBytes, 10_000);
    const retainedRun = makeRunDir('ws-Q', 'quota', UUID(2), 32);
    await refreshScratchUsage('ws-Q');
    await rmAsync(removedRun, { recursive: true, force: true });
    const writerBytes = 64;
    const recoveryTarget = WORKSPACE_QUOTA_BYTES - SCRATCH_QUOTA_RECOVERY_HEADROOM_BYTES - writerBytes;
    _setScratchUsageForTests('ws-Q', recoveryTarget + removedRunBytes, Date.now(), true);
    vi.mocked(rmAsync).mockClear();

    const timings: ScratchWriteTimings[] = [];
    const writePath = join(retainedRun, 'after-external-gc.bin');
    await writeWithScratchQuota({
      workspaceId: 'ws-Q', filePath: writePath, bytes: writerBytes,
      onTiming: (row) => timings.push(row),
    }, () => writeFile(writePath, Buffer.alloc(writerBytes)));

    expect(existsSync(retainedRun)).toBe(true);
    expect(scratchRmCallCount()).toBe(0);
    expect(timings[0]?.quotaRecoveryDiagnostics).toMatchObject({
      sizeWalkMs: 0, runsConsidered: 0, deleteAttempts: 0,
    });
    await refreshScratchUsage('ws-Q');
  });

  it('sizes a newly discovered run incrementally when another process adds an unindexed run', async () => {
    const removedRunBytes = 4 * 1024 ** 3;
    const removedRun = makeSparseRun('ws-Q', UUID(1), removedRunBytes, 10_000);
    const writerRun = makeRunDir('ws-Q', 'quota', UUID(3), 32);
    await refreshScratchUsage('ws-Q');
    // Make the request enter recovery, then simulate cross-process cleanup and growth.
    _setScratchUsageForTests('ws-Q', WORKSPACE_QUOTA_BYTES + 1024, Date.now(), true);
    await rmAsync(removedRun, { recursive: true, force: true });
    const externalRun = makeSparseRun('ws-Q', UUID(2), WORKSPACE_QUOTA_BYTES + 512 * 1024 ** 2, 20_000);
    vi.mocked(rmAsync).mockClear();
    vi.mocked(readdirAsync).mockClear();

    const timings: ScratchWriteTimings[] = [];
    const writePath = join(writerRun, 'after-external-growth.bin');
    await writeWithScratchQuota({
      workspaceId: 'ws-Q', filePath: writePath, bytes: 64,
      onTiming: (row) => timings.push(row),
    }, () => writeFile(writePath, Buffer.alloc(64)));

    expect(existsSync(externalRun)).toBe(false);
    expect(existsSync(writerRun)).toBe(true);
    expect(timings[0]?.quotaRecoveryDiagnostics).toMatchObject({
      sizeWalkMs: 0, runsListed: 2, runsConsidered: 1, deleteAttempts: 1,
    });
    const sizeWalkDirectories = vi.mocked(readdirAsync).mock.calls
      .filter(([, options]) => options != null && typeof options === 'object' && 'withFileTypes' in options)
      .map(([path]) => String(path));
    expect(sizeWalkDirectories).toContain(externalRun);
    await refreshScratchUsage('ws-Q');
  });

  it('keeps the complete workspace measurement when the per-run index is invalid', async () => {
    const retainedRun = makeSparseRun('ws-Q', UUID(1), 2 * 1024 ** 3, 10_000);
    const writerRun = makeRunDir('ws-Q', 'quota', UUID(2), 32);
    await refreshScratchUsage('ws-Q');
    _setScratchUsageForTests('ws-Q', WORKSPACE_QUOTA_BYTES + 1024, Date.now());
    vi.mocked(readdirAsync).mockClear();

    const timings: ScratchWriteTimings[] = [];
    const writePath = join(writerRun, 'after-invalid-index.bin');
    await writeWithScratchQuota({
      workspaceId: 'ws-Q', filePath: writePath, bytes: 64,
      onTiming: (row) => timings.push(row),
    }, () => writeFile(writePath, Buffer.alloc(64)));

    expect(existsSync(retainedRun)).toBe(true);
    expect(timings[0]?.quotaRecoveryDiagnostics?.sizeWalkMs).toBeGreaterThan(0);
    const sizeWalkDirectories = vi.mocked(readdirAsync).mock.calls
      .filter(([, options]) => options != null && typeof options === 'object' && 'withFileTypes' in options)
      .map(([path]) => String(path));
    expect(sizeWalkDirectories).toContain(scratchRootForWorkspace('ws-Q'));
    await refreshScratchUsage('ws-Q');
  });

  it('reports the request trace ID of the process-local scratch mutex holder when filesystem mutexes are disabled', async () => {
    process.env.PAPERCUSP_DISABLE_FS_MUTEX = '1';
    const holderTraceId = '21f43fb8-4354-4f61-8ba7-ec03098d0e22';
    let releaseHolder!: () => void;
    let startedHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holderStarted = new Promise<void>((resolve) => { startedHolder = resolve; });
    const holder = writeWithScratchQuota({
      workspaceId: 'ws-Q',
      filePath: join(makeRunDir('ws-Q', 'mutex', UUID(40), 16), 'holder.bin'),
      bytes: 1,
      requestTraceId: holderTraceId,
    }, async () => {
      startedHolder();
      await holderGate;
    });
    const timings: ScratchWriteTimings[] = [];
    let waiter: Promise<void> | undefined;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      await holderStarted;
      waiter = writeWithScratchQuota({
        workspaceId: 'ws-Q',
        filePath: join(makeRunDir('ws-Q', 'mutex', UUID(41), 16), 'waiter.bin'),
        bytes: 1,
        onTiming: (row) => timings.push(row),
      }, async () => {});
      await vi.advanceTimersByTimeAsync(5_000);
      expect(timings.find((row) => row.progress)?.progress?.mutexWaitOwner).toMatchObject({
        layer: 'process-local',
        operation: 'write',
        requestTraceId: holderTraceId,
      });
      releaseHolder();
      await holder;
      await waiter;
    } finally {
      releaseHolder();
      vi.useRealTimers();
      await Promise.allSettled([holder, ...(waiter ? [waiter] : [])]);
    }
  });

  it('reports the request trace ID from a filesystem scratch mutex owner', async () => {
    const workspaceId = 'ws-Q';
    const holderTraceId = '5c881ab6-288d-429b-a2fb-d86d54341588';
    const workspaceRoot = resolve(scratchRootForWorkspace(workspaceId));
    const mutexDigest = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 40);
    const mutexName = `papercusp-scratch-quota-${mutexDigest}`;
    let releaseHolder!: () => void;
    let startedHolder!: () => void;
    const holderGate = new Promise<void>((resolveGate) => { releaseHolder = resolveGate; });
    const holderStarted = new Promise<void>((resolveStarted) => { startedHolder = resolveStarted; });
    const holder = withFsMutex(mutexName, async () => {
      startedHolder();
      await holderGate;
    }, {
      intent: {
        subsystem: 'scratch-quota',
        operation: 'write',
        workspaceId,
        requestTraceId: holderTraceId,
      },
      waitingNoticeIntervalMs: 5_000,
    });
    const writerTraceIds = [
      'e95ce984-4f96-4c8c-b15a-6a9850411b44',
      '02974dbf-a7fd-49ad-824f-d77d59a82d62',
    ];
    const timingsByWriter: ScratchWriteTimings[][] = writerTraceIds.map(() => []);
    const observedWriter: Array<() => void> = [];
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    const writerObserved = writerTraceIds.map((_, index) => new Promise<void>((resolveObserved, rejectObserved) => {
      observedWriter[index] = resolveObserved;
      timeouts[index] = setTimeout(() => rejectObserved(new Error(`filesystem mutex writer ${index} was not observed`)), 2_000);
    }));
    let waiters: Promise<void>[] = [];
    try {
      await holderStarted;
      waiters = writerTraceIds.map((requestTraceId, index) => writeWithScratchQuota({
        workspaceId,
        filePath: join(makeRunDir(workspaceId, 'mutex', UUID(42 + index), 16), `waiter-${index}.bin`),
        bytes: 1,
        captureSubphaseTimings: true,
        requestTraceId,
        onTiming: (row) => {
          timingsByWriter[index]?.push(row);
          if (row.progress?.mutexWaitOwner) observedWriter[index]?.();
        },
      }, async () => {}));
      await Promise.all(writerObserved);
      for (const timings of timingsByWriter) {
        expect(timings.find((row) => row.progress)?.progress?.mutexWaitOwner).toMatchObject({
          layer: 'filesystem',
          operation: 'write',
          subsystem: 'scratch-quota',
          requestTraceId: holderTraceId,
        });
      }
      releaseHolder();
      await holder;
      await Promise.all(waiters);
      for (const timings of timingsByWriter) {
        expect(timings.find((row) => !row.progress)?.awaitSubphaseTimingsMs).toMatchObject({
          'fs-mutex-admission.reader-drain': expect.any(Number),
        });
        expect(timings.find((row) => !row.progress)?.awaitSubphaseTimingsMs)
          .not.toHaveProperty('fs-mutex-admission.root-mkdir');
      }
    } finally {
      for (const timeout of timeouts) clearTimeout(timeout);
      releaseHolder();
      await Promise.allSettled([holder, ...waiters]);
    }
  });

  it('bounds a scratch quota write when filesystem mutex admission stalls', async () => {
    const workspaceId = 'ws-Q';
    const workspaceRoot = resolve(scratchRootForWorkspace(workspaceId));
    const mutexDigest = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 40);
    const mutexName = `papercusp-scratch-quota-${mutexDigest}`;
    let releaseHolder!: () => void;
    let startedHolder!: () => void;
    const holderGate = new Promise<void>((resolveGate) => { releaseHolder = resolveGate; });
    const holderStarted = new Promise<void>((resolveStarted) => { startedHolder = resolveStarted; });
    const holder = withFsMutex(mutexName, async () => {
      startedHolder();
      await holderGate;
    }, {
      intent: { subsystem: 'scratch-quota', operation: 'write', workspaceId },
    });
    const timings: ScratchWriteTimings[] = [];
    try {
      await holderStarted;
      const startedAt = performance.now();
      await expect(writeWithScratchQuota({
        workspaceId,
        filePath: join(scratchRootForWorkspace(workspaceId), 'mutex-timeout', 'spill'),
        bytes: 1,
        captureSubphaseTimings: true,
        mutexTimeoutMs: 40,
        onTiming: (row) => timings.push(row),
      }, async () => {
        throw new Error('payload writer must not run after admission timeout');
      })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      const settled = timings.find((row) => !row.progress);
      expect(settled).toMatchObject({
        fsMutexAdmissionMs: expect.any(Number),
        quotaWaitMs: expect.any(Number),
      });
      expect(settled?.fsMutexAdmissionMs).toBeGreaterThanOrEqual(40);
      expect(settled?.awaitSubphaseTimingsMs).toEqual(expect.objectContaining({
        'fs-mutex-admission.abandoned-lock-reclaim': expect.any(Number),
        'fs-mutex-admission.abandoned-lock.owner-read': expect.any(Number),
      }));
    } finally {
      releaseHolder();
      await Promise.allSettled([holder]);
    }
  });

  it('protects an in-flight writer even when its run is the oldest FIFO candidate', async () => {
    const active = makeSparseRun('ws-Q', UUID(1), 2 * 1024 ** 3, 20_000);
    const other = makeSparseRun('ws-Q', UUID(2), 1024 ** 3, 10_000);
    const target = makeRunDir('ws-Q', 'quota', UUID(3), 32);
    await refreshScratchUsage('ws-Q');
    _setScratchUsageForTests('ws-Q', WORKSPACE_QUOTA_BYTES - 1024, Date.now(), true);
    let finish!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const held = writeWithScratchQuota({ workspaceId: 'ws-Q', filePath: join(active, 'held'), bytes: 512 }, async () => {
      started();
      await new Promise<void>((resolve) => { finish = resolve; });
      await writeFile(join(active, 'held'), Buffer.alloc(512));
    });
    await began;
    const next = writeWithScratchQuota({ workspaceId: 'ws-Q', filePath: join(target, 'next'), bytes: 2048 }, async () => {});
    finish();
    try {
      await next;
      expect(existsSync(active)).toBe(true);
      expect(existsSync(other)).toBe(false);
      expect(existsSync(target)).toBe(true);
    } finally {
      finish();
      await held;
    }
    await refreshScratchUsage('ws-Q');
  });

  it('refuses an impossible request without evicting or invoking the writer', async () => {
    const old = makeSparseRun('ws-Q', UUID(1), WORKSPACE_QUOTA_BYTES, 10_000);
    const write = vi.fn(async () => {});
    vi.mocked(rmAsync).mockClear();
    await expect(writeWithScratchQuota({ workspaceId: 'ws-Q', filePath: join(old, 'next'),
      bytes: WORKSPACE_QUOTA_BYTES + 1 }, write)).rejects.toMatchObject({ code: 'SCRATCH_QUOTA_EXCEEDED' });
    expect(write).not.toHaveBeenCalled();
    expect(scratchRmCallCount()).toBe(0);
    expect(existsSync(old)).toBe(true);
  });

  it('returns a typed failure when quota is occupied outside reclaimable run directories', async () => {
    const root = scratchRootForWorkspace('ws-Q');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'unmanaged'), '');
    truncateSync(join(root, 'unmanaged'), WORKSPACE_QUOTA_BYTES);
    await refreshScratchUsage('ws-Q');
    const write = vi.fn(async () => {});
    await expect(writeWithScratchQuota({ workspaceId: 'ws-Q', filePath: join(root, 'tool', UUID(1), 'next'),
      bytes: 1024 }, write)).rejects.toMatchObject({ code: 'SCRATCH_QUOTA_EXCEEDED' });
    expect(write).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'unmanaged'))).toBe(true);
  });

  it('releases a failed write reservation and preserves reservations across a concurrent refresh', async () => {
    const runDir = ensureScratchRunDir({ workspaceId: 'ws-Q', toolName: 'tool', runId: UUID(1) });
    const marker = markerBytes('ws-Q');
    _setScratchUsageForTests('ws-Q', marker, Date.now(), true);
    const filePath = join(runDir, 'next');
    await expect(writeWithScratchQuota({ workspaceId: 'ws-Q', filePath, bytes: 1024 }, async () => {
      await refreshScratchUsage('ws-Q');
      expect(scratchUsageBytes('ws-Q')).toBe(marker + 1024);
      throw new Error('write failed');
    })).rejects.toThrow('write failed');
    expect(scratchUsageBytes('ws-Q')).toBe(marker);
  });

  it('does not double-count a successful write already included in a usage refresh', async () => {
    _setScratchUsageForTests('ws-Q', 0);
    const runDir = join(scratchRootForWorkspace('ws-Q'), 'tool', UUID(1));
    mkdirSync(runDir, { recursive: true });
    const filePath = join(runDir, 'next');
    await writeWithScratchQuota({ workspaceId: 'ws-Q', filePath, bytes: 1024 }, async () => {
      await writeFile(filePath, Buffer.alloc(1024));
      await refreshScratchUsage('ws-Q');
    });
    expect(scratchUsageBytes('ws-Q')).toBe(1024);
  });

  it.each(['deferred', 'synchronous'])('does not lose a %s write that completes while a usage refresh is walking the tree', async (mode) => {
    _setScratchUsageForTests('ws-Q', 0);
    const runDir = join(scratchRootForWorkspace('ws-Q'), 'tool', UUID(2));
    mkdirSync(runDir, { recursive: true });
    const filePath = join(runDir, 'next');
    const readdirMock = vi.mocked(readdirAsync);
    const originalRead = readdirMock.getMockImplementation();
    if (!originalRead) throw new Error('readdir mock has no original implementation');
    const read = originalRead as unknown as (path: unknown, options?: unknown) => Promise<unknown>;
    let releaseRead!: () => void;
    let reachedRunDir!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const atRunDir = new Promise<void>((resolve) => { reachedRunDir = resolve; });
    readdirMock.mockImplementation((async (path: unknown, options: unknown) => {
      const entries = await read(path, options);
      if (String(path) === runDir) {
        reachedRunDir();
        await readGate;
      }
      return entries as never;
    }) as typeof readdirAsync);

    const measurement = refreshScratchUsage('ws-Q');
    try {
      await atRunDir;
      if (mode === 'synchronous') {
        reserveScratchSpace({ workspaceId: 'ws-Q', bytes: 1024 });
        writeFileSync(filePath, Buffer.alloc(1024));
      } else {
        await writeWithScratchQuota({ workspaceId: 'ws-Q', filePath, bytes: 1024 }, async () => {
          await writeFile(filePath, Buffer.alloc(1024));
        });
      }
    } finally {
      releaseRead();
      readdirMock.mockImplementation(originalRead);
    }
    await measurement;
    expect(scratchUsageBytes('ws-Q')).toBe(1024);
    await refreshScratchUsage('ws-Q');
  });
});

describe('ensureScratchRunDir', () => {
  it('creates the chain with 0700 mode', () => {
    const dir = ensureScratchRunDir({ workspaceId: 'ws-A', toolName: 'demo:tool', runId: UUID(99) });
    expect(existsSync(dir)).toBe(true);
    expect(dir).toContain('demo:tool');
    expect(dir).toContain(UUID(99));
  });
});
