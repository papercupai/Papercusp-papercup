/**
 * execFileViaSidecar — the shared "fork this short command in the spawner sidecar"
 * seam (WI-10004975). The contract every routed call site relies on:
 *   - exit 0 → { stdout, stderr }, and the local spawn is NOT paid;
 *   - non-zero exit → REJECT with execFile's error shape (.code/.stdout/.stderr), because
 *     unit-reconciler recovers stdout from a rejected `systemctl show` (EI-19966318801100410);
 *   - a sidecar transport throw or infrastructure fault → local spawn, COUNTED per subsystem;
 *   - sidecar disabled → local spawn with the caller's timeout/cwd/maxBuffer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  execFileViaSidecar,
  getSidecarFallbackStats,
  resetSidecarFallbackStatsForTest,
  type ExecFileLikeError,
} from './git-via-sidecar';
import type { ExecParams, ExecResult } from './sidecar-exec-process';

const opts = { timeoutMs: 1234, rpcTimeoutMs: 5678, subsystem: 'test-subsystem', cwd: '/tmp', maxBuffer: 99 };

describe('execFileViaSidecar', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetSidecarFallbackStatsForTest();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('uses the sidecar result on exit 0 and never pays the local spawn', async () => {
    const viaSidecar = vi.fn(async () => ({ code: 0, stdout: 'out', stderr: 'err' }));
    const local = vi.fn();
    const res = await execFileViaSidecar('systemctl', ['--user', 'show'], opts, {
      sidecarEnabled: () => true,
      viaSidecar,
      local,
    });
    expect(res).toEqual({ stdout: 'out', stderr: 'err' });
    expect(viaSidecar).toHaveBeenCalledWith('systemctl', ['--user', 'show'], {
      timeoutMs: 1234,
      rpcTimeoutMs: 5678,
      cwd: '/tmp',
    });
    expect(local).not.toHaveBeenCalled();
  });

  it('rejects a non-zero exit with the execFile error shape, keeping the child stdout recoverable', async () => {
    const viaSidecar = vi.fn(async () => ({ code: 3, stdout: 'Id=x.service\n', stderr: 'boom' }));
    const local = vi.fn();
    const err = (await execFileViaSidecar('systemctl', ['show'], opts, {
      sidecarEnabled: () => true,
      viaSidecar,
      local,
    }).catch((e: unknown) => e)) as ExecFileLikeError;
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(3);
    expect(err.stdout).toBe('Id=x.service\n');
    expect(err.stderr).toBe('boom');
    expect(err.message).toContain('boom'); // keychain matches child stderr text in the message
    expect(local).not.toHaveBeenCalled(); // the child RAN: its answer is final, never re-run locally
  });

  it('falls back to a local spawn on a sidecar infrastructure fault and counts it under the subsystem', async () => {
    const viaSidecar = vi.fn(async () => ({ code: -1, stdout: '', stderr: 'spawner sidecar could not spawn' }));
    const local = vi.fn(async () => ({ stdout: 'local-out', stderr: '' }));
    const res = await execFileViaSidecar('journalctl', ['-n', '1'], opts, {
      sidecarEnabled: () => true,
      viaSidecar,
      local,
    });
    expect(res.stdout).toBe('local-out');
    expect(local).toHaveBeenCalledWith('journalctl', ['-n', '1'], { timeout: 1234, cwd: '/tmp', maxBuffer: 99 });
    expect(getSidecarFallbackStats().bySubsystem['test-subsystem']?.count).toBe(1);
  });

  it('falls back to a local spawn when the sidecar transport throws', async () => {
    const viaSidecar = vi.fn(async () => {
      throw new Error('RPC request timeout');
    });
    const local = vi.fn(async () => ({ stdout: 'local-out' }));
    const res = await execFileViaSidecar('secret-tool', ['lookup'], opts, {
      sidecarEnabled: () => true,
      viaSidecar,
      local,
    });
    expect(res).toEqual({ stdout: 'local-out', stderr: '' });
    expect(getSidecarFallbackStats().bySubsystem['test-subsystem']?.count).toBe(1);
  });

  it('spawns locally, without touching the sidecar, when the route is disabled', async () => {
    const viaSidecar = vi.fn();
    const local = vi.fn(async () => ({ stdout: 'x', stderr: 'y' }));
    const res = await execFileViaSidecar('ps', ['-o', 'etimes='], opts, {
      sidecarEnabled: () => false,
      viaSidecar,
      local,
    });
    expect(res).toEqual({ stdout: 'x', stderr: 'y' });
    expect(viaSidecar).not.toHaveBeenCalled();
    expect(getSidecarFallbackStats().total).toBe(0);
  });

  it('uses governed local execProcess and preserves timeout, cwd, env, maxBuffer, and rejection fields', async () => {
    let next: ExecResult = { code: 0, stdout: 'local-out', stderr: '' };
    const executeProcess = vi.fn(async (_params: ExecParams): Promise<ExecResult> => next);
    const env = { PATH: '/bin', LANG: 'C' };
    const localOpts = { timeoutMs: 2222, subsystem: 'local-governed-test', cwd: '/tmp/repo', env, maxBuffer: 128 };
    const res = await execFileViaSidecar('git', ['rev-parse', 'HEAD'], localOpts, {
      sidecarEnabled: () => false,
      executeProcess,
    });

    expect(res).toEqual({ stdout: 'local-out', stderr: '' });
    expect(executeProcess).toHaveBeenLastCalledWith({
      command: 'git',
      args: ['rev-parse', 'HEAD'],
      timeoutMs: 2222,
      cwd: '/tmp/repo',
      env,
      inheritEnv: false,
      maxBuffer: 128,
    });

    next = { code: 7, stdout: 'partial', stderr: 'git failed' };
    const err = (await execFileViaSidecar('git', ['show', 'bad-ref'], localOpts, {
      sidecarEnabled: () => false,
      executeProcess,
    }).catch((e: unknown) => e)) as ExecFileLikeError;
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(7);
    expect(err.stdout).toBe('partial');
    expect(err.stderr).toBe('git failed');
    expect(err.message).toContain('git failed');
  });

  it('uses execFile default maxBuffer and inherited env when no overrides are supplied', async () => {
    const executeProcess = vi.fn(async (_params: ExecParams): Promise<ExecResult> => ({ code: 0, stdout: 'ok', stderr: '' }));
    await execFileViaSidecar('git', ['rev-parse', 'HEAD'], { timeoutMs: 321, subsystem: 'default-local-test' }, {
      sidecarEnabled: () => false,
      executeProcess,
    });
    expect(executeProcess).toHaveBeenCalledWith({
      command: 'git',
      args: ['rev-parse', 'HEAD'],
      timeoutMs: 321,
      inheritEnv: true,
      maxBuffer: 1024 * 1024,
    });
  });

  it('maps a local maxBuffer overflow to the execFile rejection code and signal', async () => {
    const executeProcess = vi.fn(async (_params: ExecParams): Promise<ExecResult> => ({
      code: -1,
      stdout: 'abc',
      stderr: '',
      maxBufferExceeded: 'stdout' as const,
    }));
    const err = (await execFileViaSidecar('git', ['show', 'large'], { timeoutMs: 321, subsystem: 'max-buffer-test' }, {
      sidecarEnabled: () => false,
      executeProcess,
    }).catch((e: unknown) => e)) as ExecFileLikeError;
    expect(err.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    expect(err.stdout).toBe('abc');
    expect(err.stderr).toBe('');
    expect(err.killed).toBe(true);
    expect(err.signal).toBe('SIGTERM');
    expect(err.message).toBe('stdout maxBuffer length exceeded');
  });
});
