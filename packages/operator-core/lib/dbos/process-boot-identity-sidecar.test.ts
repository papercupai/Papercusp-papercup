import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WI-10005424: the watchdog sweeps' git reads fork in the spawner sidecar, not in
 * the calling process. Measured 2026-10-02 09:26Z on the tower: each bg-host
 * main-thread fork took 256-512 ms at 11.7 GB RSS, and `staleRoutineExecutorSweep`
 * and `hostCodeStalenessFromLedgerSweep` each paid one for `git rev-parse HEAD`
 * through `resolveCurrentHeadCommit`.
 *
 * Expanding the captured boot pin is the deliberate exception: it must work
 * before a spawner sidecar exists, while module import itself performs no fork.
 */
const execFileViaSidecar = vi.fn();
vi.mock('../fleet/git-via-sidecar', () => ({
  execFileViaSidecar: (...args: unknown[]) => execFileViaSidecar(...args),
}));

const {
  ROUTINE_SOURCE_PREFIX,
  captureProcessBootIdentity,
  processBootCommitSha,
  resolveCommitsBehind,
  resolveCurrentHeadCommit,
  resolveRoutineCodeDrift,
} = await import('./process-boot-identity');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

// Consume the eagerly captured module identity before any sidecar mock reset.
describe('the boot sample stays a local fork', () => {
  it('expands the module boot pin without touching the sidecar', async () => {
    await processBootCommitSha();
    expect(execFileViaSidecar).not.toHaveBeenCalled();
  });

  it("captureProcessBootIdentity's default resolver does not use the sidecar", async () => {
    await captureProcessBootIdentity({ nowMs: 10_000, uptimeSec: 1 }).bootCommit;
    expect(execFileViaSidecar).not.toHaveBeenCalled();
  });
});

describe('sweep reads go through the spawner sidecar (WI-10005424)', () => {
  beforeEach(() => {
    execFileViaSidecar.mockReset();
  });

  it('resolveCurrentHeadCommit runs git rev-parse HEAD via the sidecar in this process cwd', async () => {
    execFileViaSidecar.mockResolvedValue({ stdout: `${A}\n`, stderr: '' });
    await expect(resolveCurrentHeadCommit()).resolves.toBe(A);
    expect(execFileViaSidecar).toHaveBeenCalledTimes(1);
    const [file, args, opts] = execFileViaSidecar.mock.calls[0]!;
    expect(file).toBe('git');
    expect(args).toEqual(['rev-parse', 'HEAD']);
    expect(opts).toMatchObject({ cwd: process.cwd(), timeoutMs: 5_000, subsystem: 'process-boot-identity' });
  });

  it('a rejected or non-sha read is still a fail-safe null', async () => {
    execFileViaSidecar.mockRejectedValue(new Error('Command failed: git rev-parse HEAD exited 128'));
    await expect(resolveCurrentHeadCommit()).resolves.toBeNull();
    execFileViaSidecar.mockResolvedValue({ stdout: 'not-a-sha\n', stderr: '' });
    await expect(resolveCurrentHeadCommit()).resolves.toBeNull();
  });

  it('resolveCommitsBehind counts via the sidecar', async () => {
    execFileViaSidecar.mockResolvedValue({ stdout: '7\n', stderr: '' });
    await expect(resolveCommitsBehind(A, B)).resolves.toBe(7);
    const [file, args, opts] = execFileViaSidecar.mock.calls[0]!;
    expect(file).toBe('git');
    expect(args).toEqual(['rev-list', '--count', `${A}..${B}`]);
    expect(opts).toMatchObject({ cwd: process.cwd(), subsystem: 'process-boot-identity' });
  });

  it('resolveRoutineCodeDrift diffs via the sidecar and keeps its classification', async () => {
    execFileViaSidecar.mockResolvedValue({
      stdout: `M\t${ROUTINE_SOURCE_PREFIX}x.ts\nA\t${ROUTINE_SOURCE_PREFIX}y.ts\nM\t${ROUTINE_SOURCE_PREFIX}x.test.ts\n`,
      stderr: '',
    });
    await expect(resolveRoutineCodeDrift(A, B)).resolves.toEqual({
      changed: [`${ROUTINE_SOURCE_PREFIX}x.ts`],
      addedSinceBoot: [`${ROUTINE_SOURCE_PREFIX}y.ts`],
    });
    const [file, args] = execFileViaSidecar.mock.calls[0]!;
    expect(file).toBe('git');
    expect(args).toEqual(['diff', '--name-status', '--no-renames', `${A}..${B}`, '--', ROUTINE_SOURCE_PREFIX]);
  });
});
