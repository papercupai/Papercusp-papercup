/**
 * Size-triggered package-manager cache retention (WI-6968).
 *
 * Package caches are disposable, but their layouts are manager-owned. Never
 * unlink internal npm/pnpm/bun files ourselves: measure the configured roots,
 * then use each manager's native cleanup command only after a high-water mark
 * is crossed. The cleanup holds PACKAGE_CACHE_MUTEX_NAME exclusively while
 * install:safe holds the same mutex as a reader, so cache deletion cannot race
 * a safe install in any checkout on this host.
 */
import { spawn } from 'node:child_process';
import { lstat, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { inspectRetentionTrees, RetentionAllocationCounter } from './disk-consumer-census';
import { criticalWriteHeadroomBytes, diskPolicyFromEnv, sampleDiskSnapshots } from './disk-space-alarm';
import { withRetentionPinProtection } from './retention-pins';
import { PACKAGE_CACHE_ROOT_MAX_BYTES } from './retention-policy';

import { PACKAGE_CACHE_MUTEX_NAME, withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';

export { PACKAGE_CACHE_MUTEX_NAME };

export const DEFAULT_PACKAGE_CACHE_MAX_BYTES = PACKAGE_CACHE_ROOT_MAX_BYTES;
/** Keep small working caches; pressure recovery is not a purge on every fetch. */
export const PRESSURE_PACKAGE_CACHE_MAX_BYTES = 1024 ** 3;
const DEFAULT_MEASURE_BUDGET_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_MUTEX_TIMEOUT_MS = 300_000;
const COMMAND_OUTPUT_CHARS = 4_000;

export type PackageCacheManager = 'npm' | 'bun' | 'pnpm';

export interface PackageCacheTarget {
  manager: PackageCacheManager;
  path: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface PackageCacheMeasurement {
  bytes: number;
  /** Exact physical allocation under validated live pin scopes, when requested. */
  pinnedBytes?: number;
  /** A bounded walk stopped before exhausting the tree. Actual bytes are >= bytes. */
  truncated: boolean;
}

export interface PackageCacheCommandResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

export type PackageCacheOutcomeStatus =
  | 'below-threshold'
  | 'would-prune'
  | 'pruned'
  | 'prune-failed'
  | 'pressure-ineligible'
  | 'pinned'
  | 'mutex-unavailable';

export interface PackageCacheOutcome {
  manager: PackageCacheManager;
  path: string;
  maxBytes: number;
  beforeBytes: number;
  afterBytes: number;
  reclaimedBytes: number;
  measurementTruncated: boolean;
  pinnedBytes?: number;
  pinnedOverageBytes?: number;
  unprotectedOverageBytes?: number;
  status: PackageCacheOutcomeStatus;
  note?: string;
}

interface PackageCacheTargetOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
}

interface PackageCacheRetentionOptions {
  dryRun?: boolean;
  maxBytes?: number;
  targets?: readonly PackageCacheTarget[];
  repoRoot?: string;
  /** Restrict pressure recovery to this filesystem. Omit to probe each cache's own filesystem. */
  pressurePath?: string;
  /** Bound the shared cache-writer lease wait; defaults to the maintenance budget. */
  mutexTimeoutMs?: number;
  sampleDisk?: typeof sampleDiskSnapshots;
  sameFilesystem?: (a: string, b: string) => Promise<boolean>;
  measure?: (path: string, coversPinnedPath?: (path: string) => boolean) => Promise<PackageCacheMeasurement>;
  runCommand?: (target: PackageCacheTarget, cwd: string) => Promise<PackageCacheCommandResult>;
  withMutex?: <T>(name: string, run: () => Promise<T>, options?: Record<string, unknown>) => Promise<T>;
}

async function sameFilesystem(a: string, b: string): Promise<boolean> {
  const [first, second] = await Promise.all([stat(a), stat(b)]);
  return first.dev === second.dev;
}

function configuredPath(raw: string | undefined, fallback: string, homeDir: string, cwd: string): string {
  if (!raw) return fallback;
  if (raw === '~') return homeDir;
  if (raw.startsWith('~/')) return join(homeDir, raw.slice(2));
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

/** Resolve manager-owned cache roots without invoking a package manager. */
export function resolvePackageCacheTargets(options: PackageCacheTargetOptions = {}): PackageCacheTarget[] {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;

  const npmPath = configuredPath(env.NPM_CONFIG_CACHE, join(homeDir, '.npm'), homeDir, cwd);
  const bunPath = configuredPath(
    env.BUN_INSTALL_CACHE_DIR,
    join(configuredPath(env.BUN_INSTALL, join(homeDir, '.bun'), homeDir, cwd), 'install', 'cache'),
    homeDir,
    cwd,
  );
  const pnpmDefault =
    platform === 'darwin'
      ? join(homeDir, 'Library', 'pnpm', 'store')
      : platform === 'win32'
        ? join(env.LOCALAPPDATA ?? homeDir, 'pnpm', 'store')
        : join(configuredPath(env.XDG_DATA_HOME, join(homeDir, '.local', 'share'), homeDir, cwd), 'pnpm', 'store');
  const pnpmPath = configuredPath(env.PNPM_STORE_DIR, pnpmDefault, homeDir, cwd);

  return [
    {
      manager: 'npm',
      path: npmPath,
      command: env.PAPERCUSP_NPM_BIN ?? 'npm',
      // npm's cache is opaque/cacache-owned. `clean --force` is its supported
      // disk-reclaim command; the explicit path keeps measurement and cleanup
      // on the same configured cache.
      args: ['--cache', npmPath, 'cache', 'clean', '--force'],
    },
    {
      manager: 'bun',
      path: bunPath,
      command: env.PAPERCUSP_BUN_BIN ?? 'bun',
      args: ['pm', 'cache', 'rm'],
      env: { BUN_INSTALL_CACHE_DIR: bunPath },
    },
    {
      manager: 'pnpm',
      path: pnpmPath,
      command: env.PAPERCUSP_PNPM_BIN ?? 'pnpm',
      // `store prune` removes only packages unreferenced by any registered
      // project; unlike deleting the store, it preserves live hardlink users.
      args: ['--store-dir', pnpmPath, 'store', 'prune'],
    },
  ];
}

export async function measurePackageCache(path: string, coversPinnedPath?: (path: string) => boolean): Promise<PackageCacheMeasurement> {
  path = resolve(path);
  const allocation = new RetentionAllocationCounter();
  try {
    let root;
    try { root = await lstat(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: 0, truncated: false,
        ...(coversPinnedPath ? { pinnedBytes: 0 } : {}) };
      throw error;
    }
    if (!root.isDirectory() || root.isSymbolicLink()) return { bytes: 0, truncated: true };
    const add = (entry: { path: string; bytes: number; hardlinks?: Array<{ dev: number; ino: number; bytes: number; paths: string[] }> }) => {
      const shared = entry.hardlinks ?? [];
      const exclusive = entry.bytes - shared.reduce((sum, link) => sum + link.bytes, 0);
      if (!Number.isSafeInteger(exclusive) || exclusive < 0) throw new Error('invalid cache allocation census');
      allocation.bytes += exclusive;
      for (const link of shared) {
        if (!Number.isSafeInteger(link.bytes) || link.bytes < 0 || !link.paths.length) throw new Error('invalid cache hardlink census');
        allocation.add(link.paths[0]!, { dev: link.dev, ino: link.ino, blocks: link.bytes / 512, nlink: 2 }, true);
      }
    };
    // Reuse the bounded native no-follow worker, including its per-child inode
    // metadata. One union counter spans every child of the configured root.
    allocation.add(path, root, false);
    const census = await inspectRetentionTrees(path, { retainAfterMs: 0, includeRecent: true,
      sudo: null, timeoutMs: DEFAULT_MEASURE_BUDGET_MS, coversPinnedPath });
    for (const entry of census.entries) add(entry);
    for (const retained of census.retained) if (retained.entry) add(retained.entry);
    const incomplete = census.retained.some(entry => !entry.entry ||
      ['filesystem boundary', 'foreign ownership boundary'].includes(entry.reason));
    const after = await lstat(path);
    const changed = !after.isDirectory() || after.dev !== root.dev || after.ino !== root.ino || after.ctimeMs !== root.ctimeMs;
    if (!Number.isSafeInteger(allocation.bytes) || allocation.bytes < 0) throw new Error('cache allocation overflow');
    let pinnedBytes: number | undefined;
    if (coversPinnedPath) {
      if (census.pinnedBytes === undefined) throw new Error('cache pin allocation is unmeasured');
      pinnedBytes = census.pinnedBytes + (coversPinnedPath(path) ? root.blocks * 512 : 0);
      if (!Number.isSafeInteger(pinnedBytes) || pinnedBytes < 0 || pinnedBytes > allocation.bytes) {
        throw new Error('inconsistent cache pin allocation');
      }
    }
    return { bytes: allocation.bytes, truncated: !!census.error || incomplete || changed,
      ...(pinnedBytes === undefined ? {} : { pinnedBytes }) };
  } catch {
    return { bytes: allocation.bytes, truncated: true };
  }
}

function appendBounded(current: string, chunk: unknown): string {
  const combined = current + String(chunk);
  return combined.length <= COMMAND_OUTPUT_CHARS ? combined : combined.slice(-COMMAND_OUTPUT_CHARS);
}

/** Run one manager-native cleanup with bounded output and a hard timeout. */
export function runPackageCacheCommand(
  target: PackageCacheTarget,
  cwd = process.cwd(),
): Promise<PackageCacheCommandResult> {
  return new Promise((resolveResult) => {
    let output = '';
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(target.command, target.args, {
      cwd,
      env: { ...process.env, ...(target.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (result: PackageCacheCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolveResult(result);
    };
    child.stdout?.on('data', (chunk) => {
      output = appendBounded(output, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      output = appendBounded(output, chunk);
    });
    child.once('error', (error) => {
      finish({ ok: false, exitCode: null, timedOut, output: appendBounded(output, error.message) });
    });
    child.once('close', (code) => {
      finish({ ok: code === 0 && !timedOut, exitCode: code, timedOut, output });
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      killTimer.unref?.();
    }, DEFAULT_COMMAND_TIMEOUT_MS);
    timeout.unref?.();
  });
}

function overHighWater(measurement: PackageCacheMeasurement, maxBytes: number): boolean {
  // A partial size needs attention and cannot bless a cache as below threshold.
  // The writer must establish complete measurement before native mutation.
  return measurement.truncated || measurement.bytes > maxBytes;
}

function belowOutcome(
  target: PackageCacheTarget,
  measurement: PackageCacheMeasurement,
  maxBytes: number,
): PackageCacheOutcome {
  return {
    manager: target.manager,
    path: target.path,
    maxBytes,
    beforeBytes: measurement.bytes,
    afterBytes: measurement.bytes,
    reclaimedBytes: 0,
    measurementTruncated: measurement.truncated,
    status: 'below-threshold',
  };
}

/**
 * Measure every known cache and prune above its high-water mark. Critical
 * pressure lowers the floor only for caches on the affected filesystem.
 * Re-checks pressure and cache size under the writer lease so peer recovery
 * while we waited cannot trigger a stale destructive command.
 */
export async function runPackageCacheRetention(
  options: PackageCacheRetentionOptions = {},
): Promise<PackageCacheOutcome[]> {
  const dryRun = options.dryRun === true;
  const maxBytes =
    Number.isFinite(options.maxBytes) && Number(options.maxBytes) > 0
      ? Math.floor(Number(options.maxBytes))
      : DEFAULT_PACKAGE_CACHE_MAX_BYTES;
  const targets = [...(options.targets ?? resolvePackageCacheTargets())];
  const repoRoot = options.repoRoot ?? process.cwd();
  const measure = options.measure ?? measurePackageCache;
  const runCommand = options.runCommand ?? runPackageCacheCommand;
  const withMutex = options.withMutex ?? withFsMutex;
  const sampleDisk = options.sampleDisk ?? sampleDiskSnapshots;
  const sharesFilesystem = options.sameFilesystem ?? sameFilesystem;
  async function threshold(target: PackageCacheTarget): Promise<number | null> {
    // The ordinary telemetry janitor has no pressurePath. It must still notice
    // a critically full cache filesystem, rather than wait for an 8 GiB cache
    // on a disk that has already exhausted its write reserve.
    const pressurePath = options.pressurePath ?? target.path;
    try {
      if (options.pressurePath && !(await sharesFilesystem(pressurePath, target.path))) return null;
      const snapshot = (await sampleDisk([pressurePath]))[0];
      if (snapshot && Number.isFinite(snapshot.totalBytes) && snapshot.totalBytes > 0 &&
          Number.isFinite(snapshot.freeBytes) && snapshot.freeBytes >= 0 &&
          snapshot.freeBytes <= criticalWriteHeadroomBytes(snapshot.totalBytes, diskPolicyFromEnv())) {
        return Math.min(maxBytes, PRESSURE_PACKAGE_CACHE_MAX_BYTES);
      }
    } catch (error) {
      console.warn(`[package-cache-retention] pressure eligibility unmeasured: ${String(error)}`);
      // A targeted recovery cannot prove eligibility. An ordinary janitor
      // keeps its existing high-water policy, never an unmeasured lower floor.
      return options.pressurePath ? null : maxBytes;
    }
    // Unknown pressure never authorizes a more aggressive cleanup.
    return maxBytes;
  }
  function unchanged(target: PackageCacheTarget, measurement: PackageCacheMeasurement, limit: number | null): PackageCacheOutcome {
    return limit === null
      ? { ...belowOutcome(target, measurement, maxBytes), status: 'pressure-ineligible',
        note: 'cache filesystem differs from the pressure path or its identity is unmeasured' }
      : belowOutcome(target, measurement, limit);
  }

  const initial = new Map<PackageCacheManager, PackageCacheMeasurement>();
  const thresholds = new Map<PackageCacheManager, number | null>();
  for (const target of targets) {
    initial.set(target.manager, await measure(target.path));
    thresholds.set(target.manager, await threshold(target));
  }

  const eligible = targets.filter((target) => {
    const limit = thresholds.get(target.manager)!;
    return limit !== null && overHighWater(initial.get(target.manager)!, limit);
  });
  if (dryRun) {
    return targets.map((target) => {
      const measurement = initial.get(target.manager)!;
      const limit = thresholds.get(target.manager)!;
      if (limit === null || !overHighWater(measurement, limit)) return unchanged(target, measurement, limit);
      return {
        ...belowOutcome(target, measurement, limit),
        status: 'would-prune',
        note: measurement.truncated
          ? 'size scan truncated; actual bytes are at least the measured lower bound'
          : undefined,
      };
    });
  }
  if (eligible.length === 0) {
    return targets.map((target) => unchanged(target, initial.get(target.manager)!, thresholds.get(target.manager)!));
  }

  try {
    const changed = await withMutex(
      PACKAGE_CACHE_MUTEX_NAME,
      async () => {
        const outcomes = new Map<PackageCacheManager, PackageCacheOutcome>();
        for (const target of eligible) {
          const limit = await threshold(target);
          const before = await measure(target.path);
          if (limit !== null && before.truncated) {
            outcomes.set(target.manager, { ...belowOutcome(target, before, limit), status: 'prune-failed',
              note: 'cache measurement is incomplete or its root is unsafe; native cleanup was not admitted' });
            continue;
          }
          if (limit === null || !overHighWater(before, limit)) {
            outcomes.set(target.manager, {
              ...unchanged(target, before, limit),
              note: limit === null ? 'cache filesystem eligibility changed while waiting for the cache mutex'
                : 'fell below the high-water mark while waiting for the cache mutex',
            });
            continue;
          }

          // Native managers can remove arbitrary descendants. Hold the common
          // pin mutex through the command and retain the whole cache on overlap.
          // notify-classification: {"id":"packages/operator-core/lib/storage/package-cache-retention.ts#<module>/runPackageCacheRetention/<callback>:a14f201ca0655a70eeba:1","classification":"durable","reason":"The pin-protected cache wrapper can reach alarm paths through measurement; no safe-to-lose proof is recorded.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
          const command = await withRetentionPinProtection(async (isPinned) => {
            if (!isPinned(target.path)) return runCommand(target, repoRoot);
            // Symmetric overlap protects this entire opaque store from native
            // deletion. Only the same snapshot's descendant coverage can
            // explain cap overage; unrelated siblings never inherit the pin.
            const after = await measure(target.path, isPinned.coversPath);
            const exact = !after.truncated && Number.isSafeInteger(after.bytes) && after.bytes >= 0 &&
              Number.isSafeInteger(after.pinnedBytes) && after.pinnedBytes! >= 0 && after.pinnedBytes! <= after.bytes;
            const unprotectedOverageBytes = exact ? Math.max(0, after.bytes - Math.max(limit, after.pinnedBytes!)) : undefined;
            outcomes.set(target.manager, {
              ...belowOutcome(target, before, limit),
              afterBytes: after.bytes, reclaimedBytes: Math.max(0, before.bytes - after.bytes),
              measurementTruncated: !exact,
              ...(exact ? { pinnedBytes: after.pinnedBytes, pinnedOverageBytes: Math.max(0, after.pinnedBytes! - limit),
                unprotectedOverageBytes } : {}),
              status: !exact || unprotectedOverageBytes! > 0 ? 'prune-failed' : 'pinned',
              note: !exact ? 'live pin prevents native cleanup; exact pinned allocation is unmeasured'
                : unprotectedOverageBytes! > 0 ? `live pin prevents native cleanup; non-pin cap excess ${unprotectedOverageBytes} bytes remains`
                : 'live retention pin protects this cache; remaining overage is fully explained by exact pinned allocation',
            });
            return null;
          });
          if (command === null) continue;
          if (!command.ok) {
            outcomes.set(target.manager, {
              ...belowOutcome(target, before, limit),
              status: 'prune-failed',
              note: command.timedOut
                ? `native cleanup timed out: ${command.output}`
                : `native cleanup exited ${command.exitCode ?? 'without a status'}: ${command.output}`,
            });
            continue;
          }

          const after = await measure(target.path);
          outcomes.set(target.manager, {
            manager: target.manager,
            path: target.path,
            maxBytes: limit,
            beforeBytes: before.bytes,
            afterBytes: after.bytes,
            reclaimedBytes: Math.max(0, before.bytes - after.bytes),
            measurementTruncated: before.truncated || after.truncated,
            // A zero exit code proves the native command ran, not that its
            // retention objective was met. Keep unmet/unknown caps visible to
            // the existing telemetry-retention warning path.
            status: overHighWater(after, limit) ? 'prune-failed' : 'pruned',
            note: after.truncated
              ? 'native cleanup completed, but its final measurement was truncated; the high-water bound is unverified'
              : after.bytes > limit
                ? 'native cleanup completed, but the cache still measures above the high-water mark'
                : undefined,
          });
        }
        return outcomes;
      },
      {
        timeoutMs: options.mutexTimeoutMs ?? DEFAULT_MUTEX_TIMEOUT_MS,
        staleMs: 10 * 60_000,
        retryMs: 250,
        waitingNoticeIntervalMs: 60_000,
        intent: { operation: 'package-cache-retention', managers: eligible.map((t) => t.manager).join(',') },
      },
    );

    return targets.map(
      (target) => changed.get(target.manager) ?? unchanged(target, initial.get(target.manager)!, thresholds.get(target.manager)!),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const eligibleManagers = new Set(eligible.map((target) => target.manager));
    return targets.map((target) => {
      const measurement = initial.get(target.manager)!;
      const limit = thresholds.get(target.manager)!;
      if (!eligibleManagers.has(target.manager)) return unchanged(target, measurement, limit);
      return {
        ...unchanged(target, measurement, limit),
        status: 'mutex-unavailable',
        note: message,
      };
    });
  }
}
