import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawnSync: vi.fn(),
}));

const sidecarMocks = vi.hoisted(() => ({
  enabled: vi.fn(() => false),
  run: vi.fn(),
  noteFallback: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: childProcessMocks.execFile,
    spawnSync: childProcessMocks.spawnSync,
  };
});

vi.mock('./fleet/git-via-sidecar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fleet/git-via-sidecar')>();
  return {
    ...actual,
    gitSidecarEnabled: sidecarMocks.enabled,
    runGitViaSpawnerSidecar: sidecarMocks.run,
    noteSidecarFallback: sidecarMocks.noteFallback,
  };
});

import {
  GIT_PIPELINE_POSITION_SUBPROCESS_TIMEOUT_MS,
  realGit,
  realResolveGateCandidates,
  withGitReadBudget,
} from './git-pipeline-position';

describe('git-pipeline-position subprocess bounds (EI-20262192515275987)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sidecarMocks.enabled.mockReturnValue(false);
  });

  it('bounds realGit and preserves its fail-soft null on a timed-out child', async () => {
    childProcessMocks.execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    });

    await expect(realGit('/repo', ['rev-parse', 'HEAD'])).resolves.toBeNull();
    expect(childProcessMocks.execFile).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo', 'rev-parse', 'HEAD'],
      expect.objectContaining({
        timeout: GIT_PIPELINE_POSITION_SUBPROCESS_TIMEOUT_MS,
      }),
      expect.any(Function),
    );
  });

  it('EI-22737582656157929: routes git through the small spawner sidecar when enabled', async () => {
    sidecarMocks.enabled.mockReturnValue(true);
    sidecarMocks.run.mockResolvedValue({ code: 0, stdout: 'abc123\n', stderr: '' });

    await expect(realGit('/repo', ['rev-parse', 'HEAD'])).resolves.toBe('abc123');
    expect(sidecarMocks.run).toHaveBeenCalledWith(
      ['-C', '/repo', 'rev-parse', 'HEAD'],
      process.cwd(),
      GIT_PIPELINE_POSITION_SUBPROCESS_TIMEOUT_MS,
      process.env,
    );
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('disables optional index locking for status reads in both runner paths', async () => {
    childProcessMocks.execFile.mockImplementation((_command, _args, _options, callback) => {
      // The generic promisified mock resolves its first value as execFile's
      // `{ stdout, stderr }` result object.
      callback(null, { stdout: ' M tracked.ts\n', stderr: '' });
    });

    await expect(realGit('/repo', ['status', '--porcelain'])).resolves.toBe('M tracked.ts');
    expect(childProcessMocks.execFile).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo', 'status', '--porcelain'],
      expect.objectContaining({
        env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }),
      }),
      expect.any(Function),
    );

    childProcessMocks.execFile.mockClear();
    sidecarMocks.enabled.mockReturnValue(true);
    sidecarMocks.run.mockResolvedValue({ code: 0, stdout: ' M tracked.ts\n', stderr: '' });
    await expect(realGit('/repo', ['status', '--porcelain'])).resolves.toBe('M tracked.ts');
    expect(sidecarMocks.run).toHaveBeenCalledWith(
      ['-C', '/repo', 'status', '--porcelain'],
      process.cwd(),
      GIT_PIPELINE_POSITION_SUBPROCESS_TIMEOUT_MS,
      expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }),
    );
  });

  it('treats a real non-zero sidecar git result as null without spawning the same command locally', async () => {
    sidecarMocks.enabled.mockReturnValue(true);
    sidecarMocks.run.mockResolvedValue({ code: 128, stdout: '', stderr: 'bad revision' });

    await expect(realGit('/repo', ['rev-parse', 'missing'])).resolves.toBeNull();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
    expect(sidecarMocks.noteFallback).not.toHaveBeenCalled();
  });

  it('bounds every gate-candidate probe and degrades a failed probe to null candidates', async () => {
    childProcessMocks.execFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        cb(Object.assign(new Error('timed out'), { code: 1 }), '', 'timed out');
      },
    );

    await expect(realResolveGateCandidates('/repo')).resolves.toEqual({
      judgingSha: null,
      nextCandidateSha: null,
    });
    // WI-10005261: the probes run through async execFile; spawnSync here blocked the
    // operator main thread (98.6% of a measured sentinel stall).
    expect(childProcessMocks.spawnSync).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).toHaveBeenCalled();
    for (const call of childProcessMocks.execFile.mock.calls) {
      expect(call[2]).toEqual(
        expect.objectContaining({
          timeout: GIT_PIPELINE_POSITION_SUBPROCESS_TIMEOUT_MS,
        }),
      );
    }
  });

  it('cancels an in-flight local git child and preserves UNKNOWN when its caller aborts', async () => {
    const controller = new AbortController();
    childProcessMocks.execFile.mockImplementation((_command, _args, options, callback) => {
      const signal = (options as { signal?: AbortSignal }).signal;
      signal?.addEventListener('abort', () => {
        callback(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
      }, { once: true });
    });

    const pending = realGit('/repo', ['rev-parse', 'HEAD'], controller.signal);
    controller.abort();

    await expect(pending).resolves.toBeNull();
    expect(childProcessMocks.execFile).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo', 'rev-parse', 'HEAD'],
      expect.objectContaining({ signal: controller.signal }),
      expect.any(Function),
    );
  });

  it('does not launch later reads after the shared git budget signal aborts', async () => {
    const controller = new AbortController();
    const base = vi.fn(async (_repo: string, _args: string[], signal?: AbortSignal) =>
      signal?.aborted ? null : 'ok');
    const { git } = withGitReadBudget(base, { signal: controller.signal });

    await expect(git('/repo', ['rev-parse', 'HEAD'])).resolves.toBe('ok');
    controller.abort();
    await expect(git('/repo', ['log', '-1'])).resolves.toBeNull();
    expect(base).toHaveBeenCalledTimes(1);
    expect(base).toHaveBeenCalledWith('/repo', ['rev-parse', 'HEAD'], controller.signal);
  });

  it('does not retry locally when an in-flight sidecar git call is cancelled', async () => {
    sidecarMocks.enabled.mockReturnValue(true);
    const controller = new AbortController();
    sidecarMocks.run.mockImplementation((_args, _cwd, _timeout, _env, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    }));

    const pending = realGit('/repo', ['rev-parse', 'HEAD'], controller.signal);
    controller.abort();

    await expect(pending).resolves.toBeNull();
    expect(sidecarMocks.run).toHaveBeenCalledWith(
      ['-C', '/repo', 'rev-parse', 'HEAD'],
      process.cwd(),
      GIT_PIPELINE_POSITION_SUBPROCESS_TIMEOUT_MS,
      process.env,
      { signal: controller.signal },
    );
    expect(sidecarMocks.noteFallback).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });
});
