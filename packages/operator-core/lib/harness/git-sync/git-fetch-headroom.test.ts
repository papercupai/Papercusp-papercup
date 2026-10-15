import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GIT_FETCH_CACHE_RECOVERY_COOLDOWN_MS,
  GIT_FETCH_CACHE_RECOVERY_MUTEX_TIMEOUT_MS,
  resetGitFetchCacheRecoveryCooldown,
  withGitFetchHeadroom,
} from './git-fetch-headroom';
import { DEFAULT_DISK_POLICY, type DiskSnapshot } from '../../storage/disk-space-alarm';

const cacheRetention = vi.hoisted(() => vi.fn(async (_options?: unknown) => []));
vi.mock('../../storage/package-cache-retention', () => ({ runPackageCacheRetention: cacheRetention }));

const GIB = 1024 ** 3;
const path = '/repository-metadata/objects';
const snapshot = (freeBytes: number): DiskSnapshot => ({
  path, freeBytes, totalBytes: 20 * GIB, freePct: freeBytes / (20 * GIB),
  totalInodes: 0, freeInodes: 0, freeInodesPct: 0,
});
const ok = { code: 0, stdout: '', stderr: '' };
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs(); cacheRetention.mockClear();
  resetGitFetchCacheRecoveryCooldown();
});

describe('Git fetch disk headroom', () => {
  it('refuses a bulk fetch below the reserve on the object-store filesystem', async () => {
    const run = vi.fn(async () => ({ ...ok, stdout: `${path}\n` }));
    const sample = vi.fn(async () => [snapshot(GIB)]);
    const result = await withGitFetchHeadroom(['-C', '/worktree', 'fetch', 'origin'], run, undefined, sample);
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain('critical reserve');
    expect(sample).toHaveBeenCalledWith([path]);
    expect(run.mock.calls).toHaveLength(1);
    expect(run.mock.calls[0]).toEqual([
      ['-C', '/worktree', 'rev-parse', '--path-format=absolute', '--git-path', 'objects'], undefined,
    ]);
    expect(cacheRetention).toHaveBeenCalledExactlyOnceWith({
      pressurePath: path,
      mutexTimeoutMs: GIT_FETCH_CACHE_RECOVERY_MUTEX_TIMEOUT_MS,
    });
    expect(GIT_FETCH_CACHE_RECOVERY_MUTEX_TIMEOUT_MS).toBe(5_000);
    expect(sample).toHaveBeenCalledTimes(2);
  });

  it('admits a fetch only after one recovery and a fresh sample above the unchanged reserve', async () => {
    const sample = vi.fn().mockResolvedValueOnce([snapshot(GIB)])
      .mockResolvedValue([snapshot(3 * GIB)]);
    const recover = vi.fn(async () => {});
    const run = vi.fn(async (args: string[]) => args[0] === 'rev-parse'
      ? { ...ok, stdout: path } : { ...ok, stdout: 'fetched' });
    expect(await withGitFetchHeadroom(['fetch'], run, undefined, sample, recover))
      .toEqual({ ...ok, stdout: 'fetched' });
    expect(recover).toHaveBeenCalledExactlyOnceWith(path);
    expect(sample).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('retains the refusal after one insufficient recovery, with no fetch or recovery loop', async () => {
    const recover = vi.fn(async () => {});
    const run = vi.fn(async () => ({ ...ok, stdout: path }));
    const sample = vi.fn(async () => [snapshot(2 * GIB)]);
    expect(await withGitFetchHeadroom(['pull'], run, undefined, sample, recover))
      .toMatchObject({ code: -1, stderr: expect.stringContaining('critical reserve') });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(sample).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not infer successful recovery when the post-cleanup sample is unmeasured', async () => {
    const recover = vi.fn(async () => {});
    const run = vi.fn(async () => ({ ...ok, stdout: path }));
    const sample = vi.fn().mockResolvedValueOnce([snapshot(GIB)]).mockResolvedValue([]);
    expect(await withGitFetchHeadroom(['fetch'], run, undefined, sample, recover))
      .toMatchObject({ code: -1, stderr: expect.stringContaining('unmeasured') });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports recovery failure and continues to refuse persistent pressure', async () => {
    const recover = vi.fn(async () => { throw new Error('cache writer unavailable'); });
    const run = vi.fn(async () => ({ ...ok, stdout: path }));
    expect(await withGitFetchHeadroom(['fetch'], run, undefined,
      async () => [snapshot(GIB)], recover))
      .toMatchObject({ code: -1, stderr: expect.stringContaining('cache writer unavailable') });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not fetch after caller cancellation during recovery', async () => {
    const controller = new AbortController();
    const recover = vi.fn(async () => { controller.abort(); });
    const run = vi.fn(async () => ({ ...ok, stdout: path }));
    expect(await withGitFetchHeadroom(['fetch'], run, controller.signal,
      async () => [snapshot(GIB)], recover))
      .toMatchObject({ code: -1, stderr: expect.stringContaining('aborted during') });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not mistake an unreadable filesystem for available capacity', async () => {
    const run = vi.fn(async () => ({ ...ok, stdout: `${path}\n` }));
    const result = await withGitFetchHeadroom(['fetch'], run, undefined, async () => []);
    expect(result).toMatchObject({ code: -1, stderr: expect.stringContaining('unmeasured') });
    expect(run).toHaveBeenCalledTimes(1);
    expect(cacheRetention).not.toHaveBeenCalled();
  });

  it('requires a resolved absolute object store before admitting the transfer', async () => {
    const run = vi.fn(async () => ({ code: 128, stdout: '', stderr: 'not a git repository' }));
    const sample = vi.fn(async () => [snapshot(10 * GIB)]);
    expect((await withGitFetchHeadroom(['fetch'], run, undefined, sample)).code).toBe(-1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(sample).not.toHaveBeenCalled();
  });

  it('cancels a transfer when capacity falls and waits for its exit receipt', async () => {
    vi.useFakeTimers();
    const sample = vi.fn().mockResolvedValueOnce([snapshot(10 * GIB)])
      .mockResolvedValue([snapshot(DEFAULT_DISK_POLICY.criticalFreeBytesMin)]);
    let transferSignal: AbortSignal | undefined;
    let exit!: (value: typeof ok) => void;
    const run = vi.fn(async (args: string[], signal?: AbortSignal) => {
      if (args[0] === 'rev-parse') return { ...ok, stdout: path };
      transferSignal = signal;
      return new Promise<typeof ok>((resolve) => { exit = resolve; });
    });
    let settled = false;
    const result = withGitFetchHeadroom(['fetch'], run, undefined, sample)
      .then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(transferSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(transferSignal?.aborted).toBe(true);
    expect(settled).toBe(false);
    exit(ok);
    expect(await result).toMatchObject({ code: -1, stderr: expect.stringContaining('critical reserve') });
    const samples = sample.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(sample).toHaveBeenCalledTimes(samples);
  });

  it('preserves caller cancellation while the disk remains healthy', async () => {
    const controller = new AbortController();
    const run = vi.fn(async (args: string[], signal?: AbortSignal) => {
      if (args[0] === 'rev-parse') return { ...ok, stdout: path };
      controller.abort();
      expect(signal?.aborted).toBe(true);
      return { ...ok, code: -1, stderr: 'cancelled' };
    });
    expect(await withGitFetchHeadroom(['fetch'], run, controller.signal,
      async () => [snapshot(10 * GIB)])).toMatchObject({ code: -1, stderr: 'cancelled' });
  });

  it('leaves successful fetch output intact and removes its monitor', async () => {
    vi.useFakeTimers();
    const sample = vi.fn(async () => [snapshot(10 * GIB)]);
    const run = vi.fn(async (args: string[]) => args[0] === 'rev-parse'
      ? { ...ok, stdout: path } : { ...ok, stdout: 'fetched', stderr: 'progress' });
    expect(await withGitFetchHeadroom(['fetch'], run, undefined, sample))
      .toEqual({ ...ok, stdout: 'fetched', stderr: 'progress' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sample).toHaveBeenCalledTimes(1);
  });

  it('does not prevent read-only diagnostics or other commands on a full disk', async () => {
    const run = vi.fn(async () => ok);
    const sample = vi.fn(async () => [snapshot(0)]);
    expect(await withGitFetchHeadroom(['rev-parse', 'HEAD'], run, undefined, sample)).toEqual(ok);
    expect(sample).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(['rev-parse', 'HEAD'], undefined);
  });

  // WI-10007596: one git-sync tick refuses a fetch in every submodule (41 measured).
  // Re-running cache recovery for each one held the git-sync barrier for minutes.
  describe('failed-recovery cooldown per filesystem', () => {
    const refusingRun = () => vi.fn(async () => ({ ...ok, stdout: path }));

    it('skips recovery for later refused fetches on the same filesystem after a failed attempt', async () => {
      const recover = vi.fn(async () => {});
      const sample = vi.fn(async () => [snapshot(GIB)]);
      for (let i = 0; i < 5; i++) {
        expect(await withGitFetchHeadroom(['fetch'], refusingRun(), undefined, sample, recover))
          .toMatchObject({ code: -1, stderr: expect.stringContaining('critical reserve') });
      }
      expect(recover).toHaveBeenCalledTimes(1);
      // 2 samples around the one recovery, then exactly 1 per skipped fetch: the
      // reserve is still MEASURED every time, only the cleanup is skipped.
      expect(sample).toHaveBeenCalledTimes(2 + 4);
      const last = await withGitFetchHeadroom(['fetch'], refusingRun(), undefined, sample, recover);
      expect(last.stderr).toMatch(/cache recovery skipped: an attempt on this filesystem \d+s ago did not restore the reserve/);
    });

    it('still admits a fetch inside the window once the reserve is measured as restored', async () => {
      const recover = vi.fn(async () => {});
      const sample = vi.fn().mockResolvedValueOnce([snapshot(GIB)]).mockResolvedValueOnce([snapshot(GIB)])
        .mockResolvedValue([snapshot(10 * GIB)]);
      await withGitFetchHeadroom(['fetch'], refusingRun(), undefined, sample, recover);
      const run = vi.fn(async (args: string[]) => args[0] === 'rev-parse'
        ? { ...ok, stdout: path } : { ...ok, stdout: 'fetched' });
      expect(await withGitFetchHeadroom(['fetch'], run, undefined, sample, recover))
        .toEqual({ ...ok, stdout: 'fetched' });
      expect(recover).toHaveBeenCalledTimes(1);
    });

    it('attempts recovery again once the window has elapsed', async () => {
      const recover = vi.fn(async () => {});
      const sample = vi.fn(async () => [snapshot(GIB)]);
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      await withGitFetchHeadroom(['fetch'], refusingRun(), undefined, sample, recover);
      now.mockReturnValue(1_000_000 + GIT_FETCH_CACHE_RECOVERY_COOLDOWN_MS - 1);
      await withGitFetchHeadroom(['fetch'], refusingRun(), undefined, sample, recover);
      expect(recover).toHaveBeenCalledTimes(1);
      now.mockReturnValue(1_000_000 + GIT_FETCH_CACHE_RECOVERY_COOLDOWN_MS);
      await withGitFetchHeadroom(['fetch'], refusingRun(), undefined, sample, recover);
      expect(recover).toHaveBeenCalledTimes(2);
      now.mockRestore();
    });

    it('does not start a window when recovery restored the reserve or the sample was unmeasured', async () => {
      const recover = vi.fn(async () => {});
      // Recovery works: refused -> restored -> fetched. The next breach must recover again.
      const sample = vi.fn().mockResolvedValueOnce([snapshot(GIB)]).mockResolvedValueOnce([snapshot(10 * GIB)])
        .mockResolvedValueOnce([snapshot(GIB)]).mockResolvedValueOnce([]) // unmeasured after cleanup
        .mockResolvedValue([snapshot(GIB)]);
      const run = vi.fn(async (args: string[]) => args[0] === 'rev-parse'
        ? { ...ok, stdout: path } : { ...ok, stdout: 'fetched' });
      expect(await withGitFetchHeadroom(['fetch'], run, undefined, sample, recover))
        .toEqual({ ...ok, stdout: 'fetched' });
      expect(await withGitFetchHeadroom(['fetch'], refusingRun(), undefined, sample, recover))
        .toMatchObject({ code: -1, stderr: expect.stringContaining('unmeasured') });
      await withGitFetchHeadroom(['fetch'], refusingRun(), undefined, sample, recover);
      expect(recover).toHaveBeenCalledTimes(3);
    });
  });

  it('skips duplicate same-filesystem recovery while the first attempt is in flight', async () => {
    let markStarted!: () => void;
    let finishRecovery!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const recover = vi.fn(() => {
      markStarted();
      return recovery;
    });
    const sample = vi.fn(async () => [snapshot(GIB)]);
    const refusingRun = () => vi.fn(async () => ({ ...ok, stdout: path }));

    const first = withGitFetchHeadroom(['fetch'], refusingRun(), undefined, sample, recover);
    await started;
    const second = await withGitFetchHeadroom(['fetch'], refusingRun(), undefined, sample, recover);

    expect(second).toMatchObject({
      code: -1,
      stderr: expect.stringContaining('cache recovery skipped: an attempt on this filesystem is already in progress'),
    });
    expect(recover).toHaveBeenCalledTimes(1);

    finishRecovery();
    expect(await first).toMatchObject({ code: -1, stderr: expect.stringContaining('critical reserve') });
  });
});
