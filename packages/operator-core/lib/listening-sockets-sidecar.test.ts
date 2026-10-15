import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WI-10005424: `listListeningSockets` forks `ss` in the spawner sidecar, not in the
 * calling process. service-health probes call it from the bg-host main thread, where a
 * local fork measured 128-256 ms at 8 GB RSS (bpftrace, 2026-10-02 10:25Z).
 */
const execFileViaSidecar = vi.fn();
vi.mock('./fleet/git-via-sidecar', () => ({
  execFileViaSidecar: (...args: unknown[]) => execFileViaSidecar(...args),
}));

const { listListeningSockets, ListeningSocketsError, SS_ARGV } = await import('./listening-sockets');

const SS_OUTPUT = [
  'LISTEN 0      5                          0.0.0.0:2022       0.0.0.0:*    users:(("whisper-server",pid=2027115,fd=3))  ',
  'LISTEN 0      511                      127.0.0.1:17521      0.0.0.0:*    users:(("code",pid=2820286,fd=48))           ',
].join('\n');

beforeEach(() => {
  execFileViaSidecar.mockReset();
});

describe('listListeningSockets reads the listen table through the spawner sidecar (WI-10005424)', () => {
  it('runs ss via execFileViaSidecar with a named subsystem and parses its output', async () => {
    execFileViaSidecar.mockResolvedValue({ stdout: SS_OUTPUT, stderr: '' });
    const result = await listListeningSockets({ port: 2022 });
    expect(execFileViaSidecar).toHaveBeenCalledTimes(1);
    const [file, args, opts] = execFileViaSidecar.mock.calls[0]!;
    expect(file).toBe('ss');
    expect(args).toEqual([...SS_ARGV]);
    expect(opts).toMatchObject({ timeoutMs: 5000, subsystem: 'listening-sockets' });
    expect(result.totalListening).toBe(2);
    expect(result.matched).toBe(1);
    expect(result.sockets[0]).toMatchObject({ port: 2022 });
  });

  it('a failed read still surfaces as ListeningSocketsError, never an empty table', async () => {
    execFileViaSidecar.mockRejectedValue(Object.assign(new Error('Command failed: ss exited 1'), { code: 1 }));
    await expect(listListeningSockets()).rejects.toBeInstanceOf(ListeningSocketsError);
    const enoent = Object.assign(new Error('spawn ss ENOENT'), { code: 'ENOENT' });
    execFileViaSidecar.mockRejectedValue(enoent);
    await expect(listListeningSockets()).rejects.toThrow(/`ss` is not available/);
  });
});
