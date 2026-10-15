import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SNAP_CACHE_DIR,
  DEFAULT_SNAP_CACHE_MAX_BYTES,
  PACKAGE_CACHE_MUTEX_NAME,
  parseSnapCacheMeasurement,
  resolveSnapCacheTarget,
  runSnapCacheRetention,
  type SnapCacheMeasurement,
  type SnapCacheTarget,
} from './snap-cache-retention';

const target: SnapCacheTarget = {
  path: '/var/lib/snapd/cache',
  command: 'snap',
  probeArgs: ['debug', 'snap-downloads-cache', '--cache', '/var/lib/snapd/cache'],
  cleanupArgs: ['debug', 'ensure-state-soon'],
};

const measurement = (bytes: number): SnapCacheMeasurement => ({ bytes });

describe('resolveSnapCacheTarget', () => {
  it('keeps the probe and cleanup on Snapd-owned commands and the configured cache path', () => {
    expect(resolveSnapCacheTarget()).toEqual({
      path: DEFAULT_SNAP_CACHE_DIR,
      command: 'snap',
      probeArgs: ['debug', 'snap-downloads-cache', '--cache', DEFAULT_SNAP_CACHE_DIR],
      cleanupArgs: ['debug', 'ensure-state-soon'],
    });
    expect(
      resolveSnapCacheTarget({
        env: { PAPERCUSP_SNAP_CACHE_DIR: '/test/snap-cache', PAPERCUSP_SNAP_BIN: '/bin/snap' },
      }),
    ).toMatchObject({
      path: '/test/snap-cache',
      command: '/bin/snap',
      probeArgs: ['debug', 'snap-downloads-cache', '--cache', '/test/snap-cache'],
      cleanupArgs: ['debug', 'ensure-state-soon'],
    });
  });
});

describe('parseSnapCacheMeasurement', () => {
  it('parses Snapd quantity output without relying on a direct filesystem walk', () => {
    const parsed = parseSnapCacheMeasurement(`
Cache location: /var/lib/snapd/cache
Cache entries: 12
Total size: 8.29GB
Total candidates size: 7.50 GB
Remaining size: 6.25GiB
`);

    expect(parsed.bytes).toBe(Math.round(8.29 * 1000 ** 3));
    expect(parsed.entries).toBe(12);
    expect(parsed.candidatesBytes).toBe(Math.round(7.5 * 1000 ** 3));
    expect(parsed.remainingBytes).toBe(Math.round(6.25 * 1024 ** 3));
  });

  it('parses the native Snapd aggregate with bare SI suffixes', () => {
    expect(parseSnapCacheMeasurement(`
Cache location: /var/lib/snapd/cache
Max cache-unique items: 5
Max total size of cache-unique items:     0
Max age of cache-unique items: 720h0m0s
Cache entries: 37
Total size: 11.3G
Total removed size:     0
Total candidates size: 1.11G
Remaining size: 1.11G
`)).toMatchObject({
      bytes: 11_300_000_000,
      entries: 37,
      removedBytes: 0,
      candidatesBytes: 1_110_000_000,
      remainingBytes: 1_110_000_000,
    });
  });

  it.each([
    ['555M', 555_000_000],
    ['2k', 2_000],
    ['1.5T', 1_500_000_000_000],
    ['1 MiB', 1_048_576],
    ['123 B', 123],
    ['0', 0],
  ])('interprets %s with its declared unit', (amount, bytes) => {
    expect(parseSnapCacheMeasurement(`Total size: ${amount}`).bytes).toBe(bytes);
  });

  it.each(['', '-1G', 'NaN', 'Infinity', '11.3GX', '1e309'])('rejects invalid amount %s', (amount) => {
    expect(() => parseSnapCacheMeasurement(`Total size: ${amount}`)).toThrow(/not measurable/);
  });

  it('rejects permission/error output instead of treating it as an empty cache', () => {
    expect(() => parseSnapCacheMeasurement('error: cannot obtain cache stats: permission denied')).toThrow(
      /not measurable/,
    );
  });
});

describe('runSnapCacheRetention', () => {
  it('reaches manager-owned recovery when the actual Snapd aggregate reports pressure', async () => {
    const outputs = ['11.3G', '11.3G', '10.2G'];
    const runCommand = vi.fn(async () => ({ ok: true, exitCode: 0, timedOut: false, output: '' }));
    const result = await runSnapCacheRetention({
      target,
      measure: async () => parseSnapCacheMeasurement(`Total size: ${outputs.shift()}`),
      runCommand,
      withMutex: async (_name, run) => run(),
    });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'cleaned', reclaimedBytes: 1_100_000_000 });
  });

  it('does not request Snapd cleanup while measured pressure is below the threshold', async () => {
    const runCommand = vi.fn();
    const withMutex = vi.fn();
    const result = await runSnapCacheRetention({
      target,
      maxBytes: DEFAULT_SNAP_CACHE_MAX_BYTES,
      measure: async () => measurement(DEFAULT_SNAP_CACHE_MAX_BYTES - 1),
      runCommand,
      withMutex,
    });

    expect(result).toMatchObject({ status: 'below-threshold', beforeBytes: DEFAULT_SNAP_CACHE_MAX_BYTES - 1 });
    expect(runCommand).not.toHaveBeenCalled();
    expect(withMutex).not.toHaveBeenCalled();
  });

  it('asks Snapd under the shared cache mutex and verifies reclaimed bytes', async () => {
    const samples = [measurement(9 * 1024 ** 3), measurement(9 * 1024 ** 3), measurement(1 * 1024 ** 3)];
    const measure = vi.fn(async () => samples.shift()!);
    const runCommand = vi.fn(async (actualTarget: SnapCacheTarget) => {
      expect(actualTarget.cleanupArgs).toEqual(['debug', 'ensure-state-soon']);
      return { ok: true, exitCode: 0, timedOut: false, output: '' };
    });
    const mutexCalls: Array<[string, Record<string, unknown> | undefined]> = [];
    const withMutex = async <T>(
      name: string,
      run: () => Promise<T>,
      options?: Record<string, unknown>,
    ): Promise<T> => {
      mutexCalls.push([name, options]);
      return run();
    };

    const result = await runSnapCacheRetention({ target, maxBytes: 2 * 1024 ** 3, measure, runCommand, withMutex });

    expect(result).toMatchObject({ status: 'cleaned', beforeBytes: 9 * 1024 ** 3, afterBytes: 1 * 1024 ** 3 });
    expect(result.reclaimedBytes).toBe(8 * 1024 ** 3);
    expect(mutexCalls).toHaveLength(1);
    expect(mutexCalls[0]?.[0]).toBe(PACKAGE_CACHE_MUTEX_NAME);
    expect(mutexCalls[0]?.[1]).toMatchObject({ intent: { operation: 'snap-cache-retention' } });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('reports the 24-hour ensure guard no-op and never claims cleanup', async () => {
    const samples = [measurement(9 * 1024 ** 3), measurement(9 * 1024 ** 3), measurement(9 * 1024 ** 3)];
    const result = await runSnapCacheRetention({
      target,
      maxBytes: 2 * 1024 ** 3,
      measure: async () => samples.shift()!,
      runCommand: async () => ({ ok: true, exitCode: 0, timedOut: false, output: '' }),
      withMutex: async (_name, run) => run(),
    });

    expect(result.status).toBe('cleanup-noop');
    expect(result.reclaimedBytes).toBe(0);
    expect(result.note).toMatch(/coalesced|cadence/i);
  });

  it('fails closed on an unreadable probe and never invokes cleanup', async () => {
    const runCommand = vi.fn();
    const result = await runSnapCacheRetention({
      target,
      measure: async () => {
        throw new Error('permission denied');
      },
      runCommand,
    });

    expect(result.status).toBe('unmeasurable');
    expect(result.note).toContain('permission denied');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('contains a failed ensure request without touching the cache directly', async () => {
    const runCommand = vi.fn(async () => ({ ok: false, exitCode: 1, timedOut: false, output: 'permission denied' }));
    const result = await runSnapCacheRetention({
      target,
      maxBytes: 2 * 1024 ** 3,
      measure: async () => measurement(9 * 1024 ** 3),
      runCommand,
      withMutex: async (_name, run) => run(),
    });

    expect(result.status).toBe('cleanup-failed');
    expect(result.note).toContain('permission denied');
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});
