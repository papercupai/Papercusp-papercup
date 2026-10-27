import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkSync, lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRetentionPin } from './retention-pins';
import {
  PACKAGE_CACHE_MUTEX_NAME,
  DEFAULT_PACKAGE_CACHE_MAX_BYTES,
  PRESSURE_PACKAGE_CACHE_MAX_BYTES,
  measurePackageCache,
  resolvePackageCacheTargets,
  runPackageCacheRetention,
  type PackageCacheMeasurement,
  type PackageCacheTarget,
} from './package-cache-retention';
import { RETENTION_POLICY, validatePolicy } from './retention-policy';
import { type DiskSnapshot } from './disk-space-alarm';
import * as diskSpaceAlarm from './disk-space-alarm';

const GIB = 1024 ** 3;
const diskSnapshot = (freeBytes: number): DiskSnapshot => ({
  path: '/objects', totalBytes: 20 * GIB, freeBytes, freePct: freeBytes / (20 * GIB),
  totalInodes: 0, freeInodes: 0, freeInodesPct: 0,
});
const measurement = (bytes: number, truncated = false): PackageCacheMeasurement => ({ bytes, truncated });

const targets: PackageCacheTarget[] = [
  { manager: 'npm', path: '/cache/npm', command: 'npm', args: ['cache', 'clean'] },
  { manager: 'bun', path: '/cache/bun', command: 'bun', args: ['pm', 'cache', 'rm'] },
  { manager: 'pnpm', path: '/cache/pnpm', command: 'pnpm', args: ['store', 'prune'] },
];

describe('resolvePackageCacheTargets', () => {
  it('declares the finite native cache cap in the canonical retention policy', () => {
    const cls = RETENTION_POLICY.find(cls => cls.id === 'package-caches')!;
    expect(cls.keep.kind).toBe('native');
    expect(cls.maxBytes).toBe(DEFAULT_PACKAGE_CACHE_MAX_BYTES);
    expect(Number.isSafeInteger(cls.maxBytes)).toBe(true);
    expect(cls.maxBytes).toBeGreaterThan(0);
    expect(validatePolicy(RETENTION_POLICY)).toEqual([]);
  });

  it('uses manager-owned cache roots and pins native cleanup to those exact paths', () => {
    const resolved = resolvePackageCacheTargets({
      homeDir: '/home/agent',
      cwd: '/repo',
      platform: 'linux',
      env: {
        NPM_CONFIG_CACHE: '~/npm-cache',
        BUN_INSTALL_CACHE_DIR: '/mnt/bun-cache',
        XDG_DATA_HOME: '/mnt/xdg',
        PAPERCUSP_NPM_BIN: '/bin/npm-x',
      },
    });

    expect(resolved).toEqual([
      {
        manager: 'npm',
        path: '/home/agent/npm-cache',
        command: '/bin/npm-x',
        args: ['--cache', '/home/agent/npm-cache', 'cache', 'clean', '--force'],
      },
      {
        manager: 'bun',
        path: '/mnt/bun-cache',
        command: 'bun',
        args: ['pm', 'cache', 'rm'],
        env: { BUN_INSTALL_CACHE_DIR: '/mnt/bun-cache' },
      },
      {
        manager: 'pnpm',
        path: '/mnt/xdg/pnpm/store',
        command: 'pnpm',
        args: ['--store-dir', '/mnt/xdg/pnpm/store', 'store', 'prune'],
      },
    ]);
  });
});

describe('measurePackageCache allocated no-follow census', () => {
  it('counts sparse files and cross-directory hardlinks by their physical allocation once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'package-cache-allocation-'));
    try {
      const a = join(root, 'a'), b = join(root, 'b');
      mkdirSync(a); mkdirSync(b);
      const sparse = join(a, 'sparse'), shared = join(a, 'shared');
      writeFileSync(sparse, ''); truncateSync(sparse, 8 * 1024 ** 2);
      writeFileSync(shared, Buffer.alloc(64 * 1024, 1));
      linkSync(shared, join(b, 'alias'));
      const measured = await measurePackageCache(root);
      const expected = [root, a, b, sparse, shared].reduce((sum, path) => sum + lstatSync(path).blocks * 512, 0);
      expect(measured).toEqual({ bytes: expected, truncated: false });
      expect(measured.bytes).toBeLessThan(8 * 1024 ** 2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('counts only a child symlink allocation and refuses a symlink cache root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'package-cache-no-follow-'));
    try {
      const cache = join(root, 'cache'), outside = join(root, 'outside');
      mkdirSync(cache); mkdirSync(outside);
      writeFileSync(join(outside, 'owner-data'), Buffer.alloc(1024 ** 2, 1));
      const link = join(cache, 'link'); symlinkSync(outside, link);
      expect(await measurePackageCache(cache)).toEqual({ bytes: (lstatSync(cache).blocks + lstatSync(link).blocks) * 512, truncated: false });
      const alias = join(root, 'alias'); symlinkSync(cache, alias);
      expect((await measurePackageCache(alias)).truncated).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('distinguishes absent caches from an invalid regular-file root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'package-cache-root-'));
    try {
      expect(await measurePackageCache(join(root, 'absent'))).toEqual({ bytes: 0, truncated: false });
      const file = join(root, 'file'); writeFileSync(file, 'invalid root');
      expect((await measurePackageCache(file)).truncated).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('runPackageCacheRetention', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'package-cache-pins-'));
    vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', join(sandbox, 'leases'));
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(sandbox, 'mutexes'));
    // Cache fixtures use synthetic paths. Ordinary retention now probes their
    // filesystem too, so model that boundary instead of reading the real host.
    vi.spyOn(diskSpaceAlarm, 'sampleDiskSnapshots').mockResolvedValue([diskSnapshot(3 * GIB)]);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(sandbox, { recursive: true, force: true }); });

  it('enforces the canonical default cap through native cleanup and final measurement', async () => {
    const cap = RETENTION_POLICY.find(cls => cls.id === 'package-caches')!.maxBytes!;
    const sizes = [measurement(cap + 1), measurement(cap + 1), measurement(cap)];
    const runCommand = vi.fn(async () => ({ ok: true, exitCode: 0, timedOut: false, output: '' }));
    const out = await runPackageCacheRetention({ targets: [targets[0]!],
      measure: async () => sizes.shift()!, runCommand, withMutex: async (_name, run) => run() });
    expect(runCommand).toHaveBeenCalledExactlyOnceWith(targets[0], process.cwd());
    expect(out[0]).toMatchObject({ status: 'pruned', maxBytes: cap,
      beforeBytes: cap + 1, afterBytes: cap, reclaimedBytes: 1 });
  });

  it.each([false, true])('protects pinned descendants and releases expired pins (expired=%s)', async (expired) => {
    const cache = join(sandbox, 'cache'); const descendant = join(cache, 'needed');
    mkdirSync(descendant, { recursive: true });
    createRetentionPin({ path: descendant, owner: 'test', reason: 'review',
      expiresAt: new Date(Date.now() + (expired ? -1000 : 60_000)).toISOString() },
    { nowMs: Date.now() - 2000 });
    const runCommand = vi.fn(async () => ({ ok: true, exitCode: 0, timedOut: false, output: '' }));
    const sizes = [measurement(9), measurement(9), { ...measurement(2), pinnedBytes: 2 }];
    const out = await runPackageCacheRetention({ targets: [{ ...targets[0]!, path: cache }], maxBytes: 8,
      measure: async () => sizes.shift()!, runCommand, withMutex: async (_name, run) => run() });
    expect(out[0]?.status).toBe(expired ? 'pruned' : 'pinned');
    expect(runCommand).toHaveBeenCalledTimes(expired ? 1 : 0);
  });

  it.each(['root', 'child', 'alias'] as const)('accounts only the exact %s pin allocation and exposes unrelated excess', async (scope) => {
    const cache = join(sandbox, 'cache'), needed = join(cache, 'needed');
    mkdirSync(needed, { recursive: true });
    const proof = join(needed, 'proof'), bulk = join(cache, 'bulk');
    writeFileSync(proof, Buffer.alloc(64 * 1024, 1));
    writeFileSync(bulk, Buffer.alloc(128 * 1024, 1));
    linkSync(proof, join(cache, 'shared-proof'));
    const alias = join(sandbox, 'cache-alias'); symlinkSync(cache, alias);
    createRetentionPin({ path: scope === 'root' ? cache : scope === 'alias' ? join(alias, 'needed') : needed,
      owner: 'test', reason: 'review', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const runCommand = vi.fn();
    const out = await runPackageCacheRetention({ targets: [{ ...targets[0]!, path: cache }], maxBytes: 1,
      runCommand, withMutex: async (_name, run) => run() });
    const total = [cache, needed, proof, bulk].reduce((sum, path) => sum + lstatSync(path).blocks * 512, 0);
    const pinned = scope === 'root' ? total : [needed, proof].reduce((sum, path) => sum + lstatSync(path).blocks * 512, 0);
    expect(runCommand).not.toHaveBeenCalled();
    expect(out[0]).toMatchObject({ status: scope === 'root' ? 'pinned' : 'prune-failed',
      beforeBytes: total, afterBytes: total, pinnedBytes: pinned, pinnedOverageBytes: pinned - 1,
      unprotectedOverageBytes: total - Math.max(1, pinned), measurementTruncated: false });
    expect(lstatSync(bulk).isFile()).toBe(true);
    if (scope !== 'root') expect(out[0]?.note).toMatch(/non-pin.*excess/);
  });

  it.each([
    { final: { ...measurement(9), pinnedBytes: 9 }, status: 'pinned', truncated: false },
    { final: { ...measurement(9), pinnedBytes: 2 }, status: 'prune-failed', truncated: false },
    { final: { ...measurement(9, true), pinnedBytes: 9 }, status: 'prune-failed', truncated: true },
    { final: measurement(9), status: 'prune-failed', truncated: true },
    { final: { ...measurement(9), pinnedBytes: 10 }, status: 'prune-failed', truncated: true },
  ])('requires complete exact allocation before exempting pinned excess: $final', async ({ final, status, truncated }) => {
    const cache = join(sandbox, 'cache'); mkdirSync(cache);
    createRetentionPin({ path: cache, owner: 'test', reason: 'review', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const sizes = [measurement(9), measurement(9), final];
    const runCommand = vi.fn();
    const out = await runPackageCacheRetention({ targets: [{ ...targets[0]!, path: cache }], maxBytes: 8,
      measure: async () => sizes.shift()!, runCommand, withMutex: async (_name, run) => run() });
    expect(runCommand).not.toHaveBeenCalled();
    expect(out[0]).toMatchObject({ status, measurementTruncated: truncated });
    if (status === 'prune-failed') expect(out[0]?.note).toMatch(/unmeasured|non-pin/);
  });

  it('refuses native cleanup when the pin store cannot be decoded', async () => {
    const dir = join(sandbox, 'leases'); mkdirSync(dir);
    writeFileSync(join(dir, 'lease-agent-pin-corrupt.tsv'), 'broken');
    const runCommand = vi.fn();
    const out = await runPackageCacheRetention({ targets: [targets[0]!], maxBytes: 8,
      measure: async () => measurement(9), runCommand, withMutex: async (_name, run) => run() });
    expect(runCommand).not.toHaveBeenCalled();
    expect(out[0]?.note).toContain('retention pins unreadable');
  });

  it('refuses native cleanup of an invalid cache root instead of following its symlink', async () => {
    const outside = join(sandbox, 'outside'), alias = join(sandbox, 'alias');
    mkdirSync(outside); writeFileSync(join(outside, 'owner-data'), Buffer.alloc(64 * 1024, 1));
    symlinkSync(outside, alias);
    const runCommand = vi.fn(async () => ({ ok: true, exitCode: 0, timedOut: false, output: '' }));
    const out = await runPackageCacheRetention({ targets: [{ ...targets[0]!, path: alias }], maxBytes: 1,
      runCommand, withMutex: async (_name, run) => run() });
    expect(runCommand).not.toHaveBeenCalled();
    expect(out[0]?.status).toBe('prune-failed');
    expect(out[0]?.note).toContain('measurement');
  });

  it('detects pressure on each cache filesystem for the ordinary janitor without a pressurePath', async () => {
    const sampleDisk = vi.fn(async (paths: string[] = []) => [
      { ...diskSnapshot(paths[0] === '/cache/npm' ? GIB : 3 * GIB), path: paths[0]! },
    ]);
    const runCommand = vi.fn();
    const out = await runPackageCacheRetention({
      dryRun: true,
      targets: targets.slice(0, 2),
      sampleDisk,
      measure: async () => measurement(3 * GIB),
      runCommand,
    });
    expect(out.map((row) => row.status)).toEqual(['would-prune', 'below-threshold']);
    expect(out[0]?.maxBytes).toBe(PRESSURE_PACKAGE_CACHE_MAX_BYTES);
    expect(out[1]?.maxBytes).toBe(8 * GIB);
    expect(sampleDisk.mock.calls.map(([paths]) => paths)).toEqual([['/cache/npm'], ['/cache/bun']]);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('retains the ordinary high-water policy when automatic pressure measurement fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await runPackageCacheRetention({
      dryRun: true,
      targets: [targets[0]!],
      sampleDisk: async () => { throw new Error('statfs unavailable'); },
      measure: async () => measurement(3 * GIB),
    });
    expect(out[0]).toMatchObject({ status: 'below-threshold', maxBytes: 8 * GIB });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('statfs unavailable'));
  });

  it('previews a sub-high-water cache only on the critically pressured filesystem', async () => {
    const withMutex = vi.fn();
    const runCommand = vi.fn();
    const sampleDisk = vi.fn(async () => [diskSnapshot(2 * GIB)]);
    const out = await runPackageCacheRetention({
      targets, pressurePath: '/objects', dryRun: true,
      sameFilesystem: async (_path, cache) => cache !== '/cache/bun',
      sampleDisk,
      measure: async (cache) => measurement(cache === '/cache/pnpm' ? GIB / 2 : cache === '/cache/bun' ? 9 * GIB : 3 * GIB),
      withMutex, runCommand,
    });
    expect(out.map((row) => row.status)).toEqual(['would-prune', 'pressure-ineligible', 'below-threshold']);
    expect(out[0]?.maxBytes).toBe(PRESSURE_PACKAGE_CACHE_MAX_BYTES);
    expect(out[1]?.maxBytes).toBe(8 * GIB);
    expect(sampleDisk).toHaveBeenCalledWith(['/objects']);
    expect(withMutex).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('rechecks pressure under the writer lease and skips cleanup after peer recovery', async () => {
    const sampleDisk = vi.fn().mockResolvedValueOnce([diskSnapshot(GIB)])
      .mockResolvedValue([diskSnapshot(3 * GIB)]);
    const runCommand = vi.fn();
    const out = await runPackageCacheRetention({
      targets: [targets[0]!], pressurePath: '/objects', sampleDisk,
      sameFilesystem: async () => true,
      measure: async () => measurement(3 * GIB), runCommand,
      withMutex: async (name, run) => {
        expect(name).toBe(PACKAGE_CACHE_MUTEX_NAME);
        return run();
      },
    });
    expect(out[0]).toMatchObject({ status: 'below-threshold', maxBytes: 8 * GIB });
    expect(sampleDisk).toHaveBeenCalledTimes(2);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('stops pressure cleanup when the first native manager restores the reserve', async () => {
    const sampleDisk = vi.fn().mockResolvedValueOnce([diskSnapshot(GIB)])
      .mockResolvedValueOnce([diskSnapshot(GIB)])
      .mockResolvedValueOnce([diskSnapshot(GIB)])
      .mockResolvedValue([diskSnapshot(3 * GIB)]);
    const sizes = new Map([
      ['/cache/npm', [measurement(3 * GIB), measurement(3 * GIB), measurement(GIB / 2)]],
      ['/cache/bun', [measurement(3 * GIB), measurement(3 * GIB)]],
    ]);
    const runCommand = vi.fn(async () => ({ ok: true, exitCode: 0, timedOut: false, output: '' }));
    const out = await runPackageCacheRetention({
      targets: targets.slice(0, 2), pressurePath: '/objects', sampleDisk,
      sameFilesystem: async () => true,
      measure: async (cache) => sizes.get(cache)!.shift()!, runCommand,
      withMutex: async (_name, run) => run(),
    });
    expect(out.map((row) => row.status)).toEqual(['pruned', 'below-threshold']);
    expect(out[0]?.reclaimedBytes).toBe(2.5 * GIB);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(targets[0], expect.any(String));
  });

  it.each([
    { snapshots: [] },
    { snapshots: [diskSnapshot(3 * GIB)] },
    { snapshots: [{ ...diskSnapshot(GIB), totalBytes: 0 }] },
    { snapshots: [{ ...diskSnapshot(GIB), freeBytes: Number.NaN }] },
    { snapshots: [{ ...diskSnapshot(GIB), freeBytes: -1 }] },
  ])('does not lower the cache floor for healthy or unmeasured pressure: $snapshots', async ({ snapshots }) => {
    const runCommand = vi.fn();
    const withMutex = vi.fn();
    const out = await runPackageCacheRetention({
      targets: [targets[0]!], pressurePath: '/objects',
      sampleDisk: async () => snapshots, sameFilesystem: async () => true,
      measure: async () => measurement(3 * GIB), runCommand, withMutex,
    });
    expect(out[0]).toMatchObject({ status: 'below-threshold', maxBytes: 8 * GIB });
    expect(withMutex).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('does not lower the floor when filesystem identity cannot be measured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const runCommand = vi.fn();
      const out = await runPackageCacheRetention({
        targets: [targets[0]!], pressurePath: '/objects',
        sameFilesystem: async () => { throw new Error('stat denied'); },
        measure: async () => measurement(3 * GIB), runCommand,
      });
      expect(out[0]).toMatchObject({ status: 'pressure-ineligible', maxBytes: 8 * GIB });
      expect(runCommand).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('stat denied'));
    } finally {
      warn.mockRestore();
    }
  });

  it('does not acquire the cleanup writer when every cache is below the high-water mark', async () => {
    const withMutex = vi.fn();
    const runCommand = vi.fn();
    const out = await runPackageCacheRetention({
      targets,
      maxBytes: 8,
      measure: async () => measurement(7),
      runCommand,
      withMutex,
    });

    expect(out.map((row) => row.status)).toEqual(['below-threshold', 'below-threshold', 'below-threshold']);
    expect(withMutex).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('dry-runs oversized or truncated caches without locking or executing cleanup', async () => {
    const withMutex = vi.fn();
    const runCommand = vi.fn();
    const sizes = new Map([
      ['/cache/npm', measurement(9)],
      ['/cache/bun', measurement(1, true)],
      ['/cache/pnpm', measurement(2)],
    ]);
    const out = await runPackageCacheRetention({
      targets,
      maxBytes: 8,
      dryRun: true,
      measure: async (path) => sizes.get(path)!,
      runCommand,
      withMutex,
    });

    expect(out.map((row) => row.status)).toEqual(['would-prune', 'would-prune', 'below-threshold']);
    expect(out[1]?.note).toMatch(/truncated/);
    expect(withMutex).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('re-measures under the shared install/cache mutex and runs each native manager command', async () => {
    const queues = new Map<string, PackageCacheMeasurement[]>([
      ['/cache/npm', [measurement(9), measurement(9), measurement(2)]],
      ['/cache/bun', [measurement(1)]],
      ['/cache/pnpm', [measurement(10), measurement(10), measurement(7)]],
    ]);
    const measure = vi.fn(async (path: string) => queues.get(path)!.shift()!);
    const runCommand = vi.fn(async () => ({ ok: true, exitCode: 0, timedOut: false, output: 'ok' }));
    const mutexCalls: Array<[string, Record<string, unknown> | undefined]> = [];
    const withMutex = async <T>(name: string, run: () => Promise<T>, options?: Record<string, unknown>): Promise<T> => {
      mutexCalls.push([name, options]);
      return run();
    };

    const out = await runPackageCacheRetention({
      targets,
      maxBytes: 8,
      repoRoot: '/repo',
      measure,
      runCommand,
      withMutex,
    });

    expect(mutexCalls).toHaveLength(1);
    expect(mutexCalls[0]?.[0]).toBe(PACKAGE_CACHE_MUTEX_NAME);
    expect(mutexCalls[0]?.[1]).toMatchObject({
      intent: { operation: 'package-cache-retention', managers: 'npm,pnpm' },
    });
    expect(runCommand.mock.calls).toEqual([
      [targets[0], '/repo'],
      [targets[2], '/repo'],
    ]);
    expect(out.map((row) => row.status)).toEqual(['pruned', 'below-threshold', 'pruned']);
    expect(out.map((row) => row.reclaimedBytes)).toEqual([7, 0, 3]);
  });

  it.each([
    { after: measurement(8), status: 'pruned', note: undefined },
    { after: measurement(9), status: 'prune-failed', note: /still measures above the high-water mark/ },
    { after: measurement(1, true), status: 'prune-failed', note: /final measurement was truncated/ },
  ])('verifies the cap after native cleanup: $status, $after', async ({ after, status, note }) => {
    const sizes = [measurement(10), measurement(10), after];
    const runCommand = vi.fn(async () => ({ ok: true, exitCode: 0, timedOut: false, output: 'ok' }));
    const out = await runPackageCacheRetention({
      targets: [targets[0]!], maxBytes: 8,
      measure: async () => sizes.shift()!, runCommand,
      withMutex: async (_name, run) => run(),
    });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(out[0]).toMatchObject({ status, maxBytes: 8, afterBytes: after.bytes,
      reclaimedBytes: 10 - after.bytes, measurementTruncated: after.truncated });
    if (note) expect(out[0]?.note).toMatch(note);
    else expect(out[0]?.note).toBeUndefined();
  });

  it('does not run a stale cleanup when the cache fell below the threshold while waiting', async () => {
    const values = [measurement(9), measurement(4)];
    const runCommand = vi.fn();
    const out = await runPackageCacheRetention({
      targets: [targets[0]!],
      maxBytes: 8,
      measure: async () => values.shift()!,
      runCommand,
      withMutex: async (_name, run) => run(),
    });

    expect(out[0]).toMatchObject({ status: 'below-threshold', beforeBytes: 4 });
    expect(out[0]?.note).toMatch(/while waiting/);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('contains command and mutex failures so one janitor tick cannot sink telemetry retention', async () => {
    const commandFailure = await runPackageCacheRetention({
      targets: [targets[0]!],
      maxBytes: 8,
      measure: async () => measurement(9),
      runCommand: async () => ({ ok: false, exitCode: 127, timedOut: false, output: 'missing' }),
      withMutex: async (_name, run) => run(),
    });
    expect(commandFailure[0]).toMatchObject({ status: 'prune-failed' });
    expect(commandFailure[0]?.note).toMatch(/127.*missing/);

    const mutexFailure = await runPackageCacheRetention({
      targets: [targets[0]!],
      maxBytes: 8,
      measure: async () => measurement(9),
      withMutex: async () => {
        throw new Error('install still active');
      },
    });
    expect(mutexFailure[0]).toMatchObject({ status: 'mutex-unavailable' });
    expect(mutexFailure[0]?.note).toContain('install still active');
  });

  it('keeps the maintenance wait default but honors a shorter caller budget', async () => {
    const observedTimeouts: number[] = [];
    const withMutex = async <T>(
      _name: string,
      _run: () => Promise<T>,
      options?: Record<string, unknown>,
    ): Promise<T> => {
      observedTimeouts.push(Number(options?.timeoutMs));
      throw new Error(`Timed out after ${String(options?.timeoutMs)}ms waiting for test mutex`);
    };
    const base = {
      targets: [targets[0]!],
      maxBytes: 8,
      measure: async () => measurement(9),
      withMutex,
    };

    expect((await runPackageCacheRetention(base))[0]).toMatchObject({ status: 'mutex-unavailable' });
    expect((await runPackageCacheRetention({ ...base, mutexTimeoutMs: 5_000 }))[0])
      .toMatchObject({ status: 'mutex-unavailable', note: expect.stringContaining('5000ms') });
    expect(observedTimeouts).toEqual([300_000, 5_000]);
  });
});
