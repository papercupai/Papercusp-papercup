import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: (...args: unknown[]) => Promise.resolve(execFile(...args)),
  });
  return { execFile, loadedSha: 'a'.repeat(10) };
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: fixture.execFile,
}));
vi.mock('../build-info', () => ({
  getBuildInfo: () => ({ sha: fixture.loadedSha, version: 'fixture' }),
}));
vi.mock('../fleet/git-via-sidecar', () => ({ execFileViaSidecar: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  fixture.loadedSha = 'a'.repeat(10);
  fixture.execFile.mockReset();
  fixture.execFile.mockImplementation((_command, args) => ({
    stdout: `${args[2].startsWith('a') ? 'a'.repeat(40) : 'b'.repeat(40)}\n`,
  }));
});

describe('boot identity import with a production build pin', () => {
  it('captures a nonempty loaded pin without forking during module import', async () => {
    await import('./process-boot-identity');
    expect(fixture.execFile).not.toHaveBeenCalled();
  });

  it('expands the captured pin once even when the later build identity changes', async () => {
    const { processBootCommitSha } = await import('./process-boot-identity');
    fixture.loadedSha = 'b'.repeat(10);
    await expect(processBootCommitSha()).resolves.toBe('a'.repeat(40));
    await expect(processBootCommitSha()).resolves.toBe('a'.repeat(40));
    expect(fixture.execFile).toHaveBeenCalledTimes(1);
    expect(fixture.execFile.mock.calls[0]).toEqual([
      'git', ['rev-parse', '--verify', `${'a'.repeat(10)}^{commit}`], { timeout: 5_000 },
    ]);
  });

  it('preserves the explicit resolver eager contract without ambient Git reads', async () => {
    const { captureProcessBootIdentity } = await import('./process-boot-identity');
    const resolveCommit = vi.fn(async () => 'b'.repeat(40));
    const identity = captureProcessBootIdentity({ nowMs: 5_000, uptimeSec: 2, resolveCommit });
    expect(resolveCommit).toHaveBeenCalledTimes(1);
    expect(identity.bootTimeMs).toBe(3_000);
    await expect(identity.bootCommit).resolves.toBe('b'.repeat(40));
    expect(fixture.execFile).not.toHaveBeenCalled();
  });
});
