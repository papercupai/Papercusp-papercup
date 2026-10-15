import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WI-10005424 — `gitGrepFiles`' DEFAULT runner forks `git grep` in the spawner sidecar,
 * not in the calling process. Measured 2026-10-02 09:26Z on the tower: each bg-host
 * main-thread fork took 256–512 ms at 11.7 GB RSS, and `probeCodeExistence`'s grep was
 * one of them. These tests pin the routing AND that the sidecar's rejection shape keeps
 * the miss/failure distinction `probeCodeExistence` depends on.
 */
const execFileViaSidecar = vi.fn();
vi.mock('../fleet/git-via-sidecar', () => ({
  execFileViaSidecar: (...args: unknown[]) => execFileViaSidecar(...args),
}));

const { gitGrepFiles, execOutcomeFromError } = await import('./code-search-deps');

function execError(code: unknown, stdout = ''): Error {
  return Object.assign(new Error(`Command failed (exit ${String(code)})`), { code, stdout, stderr: '' });
}

beforeEach(() => {
  execFileViaSidecar.mockReset();
});

describe('gitGrepFiles default runner goes through the spawner sidecar (WI-10005424)', () => {
  it('runs git grep via execFileViaSidecar with the caller cwd, timeout and a named subsystem', async () => {
    execFileViaSidecar.mockResolvedValue({ stdout: 'a.ts\nb.ts\n', stderr: '' });
    await expect(gitGrepFiles('needle', { cwd: '/repo', timeoutMs: 1234 })).resolves.toEqual(['a.ts', 'b.ts']);
    expect(execFileViaSidecar).toHaveBeenCalledTimes(1);
    const [file, args, opts] = execFileViaSidecar.mock.calls[0]!;
    expect(file).toBe('git');
    expect(args).toEqual(['grep', '--no-color', '-l', '-F', '-I', '-e', 'needle', '--']);
    expect(opts).toMatchObject({ cwd: '/repo', timeoutMs: 1234, subsystem: 'scout-code-search' });
  });

  it('exit 1 rejected by the sidecar seam is still an honest MISS', async () => {
    execFileViaSidecar.mockRejectedValue(execError(1));
    await expect(gitGrepFiles('nothing', { cwd: '/repo' })).resolves.toEqual([]);
  });

  it('exit 2 is still a real FAILURE', async () => {
    execFileViaSidecar.mockRejectedValue(execError(2));
    await expect(gitGrepFiles('x', { cwd: '/repo' })).rejects.toThrow(/exit 2/);
  });

  it('a killed / timed-out process (signal or negative code) rejects, never reads as a miss', async () => {
    execFileViaSidecar.mockRejectedValue(execError('ETIMEDOUT'));
    await expect(gitGrepFiles('x', { cwd: '/repo' })).rejects.toThrow(/ETIMEDOUT/);
    execFileViaSidecar.mockRejectedValue(execError(-1));
    await expect(gitGrepFiles('x', { cwd: '/repo' })).rejects.toThrow(/exit -1/);
  });
});

describe('execOutcomeFromError', () => {
  it('resolves a non-negative numeric exit with its stdout, rejects everything else', () => {
    expect(execOutcomeFromError(execError(1, 'partial'))).toEqual({ stdout: 'partial', code: 1 });
    expect(() => execOutcomeFromError(execError(null))).toThrow();
    expect(() => execOutcomeFromError(execError(-1))).toThrow();
    expect(() => execOutcomeFromError('not an error')).toThrow('not an error');
  });
});
