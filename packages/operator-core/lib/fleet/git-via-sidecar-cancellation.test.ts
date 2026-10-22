import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  spawnSidecar: vi.fn(async () => undefined),
  call: vi.fn(),
  close: vi.fn(),
  preflight: vi.fn(),
  reap: vi.fn(),
}));
vi.mock('./spawner-sidecar-spawn', () => ({ spawnSpawnerSidecar: mock.spawnSidecar }));
vi.mock('./spawner-ipc-client', () => ({
  getSpawnerIpcClient: () => ({ call: mock.call }),
  SpawnerIpcClient: class { call = mock.call; close = mock.close; },
}));
vi.mock('./sidecar-exec-lifetime', () => ({ sidecarContainmentCurrent: mock.preflight, reapDeadSidecar: mock.reap }));

import { isSidecarInfrastructureFault, runCommandViaSpawnerSidecar, runGitStdinViaSpawnerSidecar } from './git-via-sidecar';

const fence = { serverGeneration: 'original-server', connectionId: 'original-connection', forkserverIdentity: null };
const capabilities = { processExecFence: fence, processExecContainment: { pid: 123, identity: 'original' } };
beforeEach(() => {
  vi.clearAllMocks();
  mock.preflight.mockReturnValue(true);
  mock.reap.mockResolvedValue(false);
});

describe('cancellable process:exec caller', () => {
  it('forwards progress, requests cancellation once and waits for the child-exit response', async () => {
    let finish!: (value: { code: number; stdout: string; stderr: string }) => void;
    const original = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => { finish = resolve; });
    const onProgress = vi.fn();
    mock.call.mockImplementation((method: string, _params: unknown, opts?: {
      onRequestId?: (id: number) => void; onOutputActivity?: () => void;
    }) => {
      if (method === 'process:exec') {
        opts?.onRequestId?.(17);
        opts?.onOutputActivity?.();
        return original;
      }
      if (method === 'spawn:cancel') return Promise.resolve({ ...capabilities, cancelled: true });
      throw new Error(`unexpected RPC ${method}`);
    });

    const controller = new AbortController();
    const run = runCommandViaSpawnerSidecar('git', ['rev-parse', 'HEAD'], {
      cwd: '/tmp', timeoutMs: 5000, signal: controller.signal, onProgress,
    });
    await vi.waitFor(() => expect(mock.call).toHaveBeenCalledWith('process:exec', expect.anything(), expect.anything()));
    expect(mock.call.mock.calls.find(([method]) => method === 'process:exec')?.[1]).toMatchObject({
      callerLabel: 'git-via-sidecar.runCommandViaSpawnerSidecar',
    });
    expect(onProgress).toHaveBeenCalledOnce();
    controller.abort();
    controller.abort();
    await vi.waitFor(() => expect(mock.call.mock.calls.filter(([method, params]) => method === 'spawn:cancel' && params.requestId)).toHaveLength(1));
    expect(mock.call).toHaveBeenCalledWith('spawn:cancel', { requestId: 17 }, { timeoutMs: 5000 });

    let settled = false;
    void run.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish({ code: -1, stdout: '', stderr: 'aborted by caller' });
    expect(await run).toMatchObject({ code: -1, stderr: 'aborted by caller' });
  });

  it('labels stdin handoff executions with their static callsite identity', async () => {
    mock.call.mockResolvedValue({ code: 0, stdoutBytes: 0, stderr: '' });

    const result = await runGitStdinViaSpawnerSidecar([], '/tmp', '', 5000, {});

    expect(result).toMatchObject({ code: 0, stdout: Buffer.alloc(0), stderr: '' });
    expect(mock.call).toHaveBeenCalledWith('process:exec', expect.objectContaining({
      callerLabel: 'git-via-sidecar.runGitStdinViaSpawnerSidecar',
    }), expect.anything());
  });

  it('logs the child PID, elapsed time and timeout limits on a post-dispatch RPC timeout', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mock.call.mockImplementation((method: string, _params: unknown, opts?: {
      onRequestId?: (id: number, connectionId: string) => void;
      onPid?: (pid: number) => void;
    }) => {
      if (method === 'spawn:cancel') return Promise.resolve(capabilities);
      if (method === 'process:exec') {
        opts?.onRequestId?.(17, 'client-connection-17');
        opts?.onPid?.(4242);
        return Promise.reject(new Error('RPC request timeout: process:exec'));
      }
      if (method === 'process:drain') return Promise.resolve({ exitConfirmed: true, result: null });
      throw new Error(`unexpected RPC ${method}`);
    });

    const result = await runCommandViaSpawnerSidecar('git', ['gc', '--prune=now'], {
      timeoutMs: 5000,
      idleTimeoutMs: 1000,
      rpcTimeoutMs: 9000,
      signal: new AbortController().signal,
    });

    expect(result.stderr).toContain('not replayed');
    const fault = warning.mock.calls.find(([tag]) => tag === '[spawner-process-exec-fault]')?.[1] as
      Record<string, unknown> | undefined;
    expect(fault).toMatchObject({
      event: 'rpc-timeout',
      clientConnectionId: 'client-connection-17',
      serverGeneration: fence.serverGeneration,
      connectionId: fence.connectionId,
      requestId: 17,
      method: 'process:exec',
      childPid: 4242,
      childTimeoutMs: 5000,
      childIdleTimeoutMs: 1000,
      rpcTimeoutMs: 9000,
    });
    expect(fault?.elapsedMs).toEqual(expect.any(Number));
    expect(fault?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('refuses dispatch without verified containment, so fallback cannot duplicate work', async () => {
    mock.call.mockResolvedValue(capabilities);
    mock.preflight.mockReturnValue(false);
    await expect(runCommandViaSpawnerSidecar('git', ['commit'], {
      timeoutMs: 5000, signal: new AbortController().signal,
    })).rejects.toThrow('before dispatch');
    expect(mock.call.mock.calls.map(([method]) => method)).toEqual(['spawn:cancel']);
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it('binds dispatch to preflight and waits through transport loss until the old connection drains', async () => {
    let finish!: (value: unknown) => void;
    mock.call.mockImplementation((method, params, opts) => {
      if (method === 'spawn:cancel') return Promise.resolve(capabilities);
      if (method === 'process:exec') {
        expect(params.fence).toEqual(fence);
        opts.onRequestId(17);
        return Promise.reject(new Error('socket lost before PID'));
      }
      if (method === 'process:drain') {
        expect(params).toEqual({ ...fence, requestId: 17 });
        expect(opts.timeoutMs).toBe(0);
        return new Promise((resolve) => { finish = resolve; });
      }
    });
    let settled = false;
    const run = runCommandViaSpawnerSidecar('git', ['commit'], {
      timeoutMs: 5000, signal: new AbortController().signal,
    }).then((result) => { settled = true; return result; });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(settled).toBe(false);
    finish({ exitConfirmed: true, result: null });
    const result = await run;
    expect(result.stderr).toContain('not replayed');
    expect(isSidecarInfrastructureFault(result)).toBe(false);
    expect(mock.call.mock.calls.filter(([method]) => method === 'process:exec')).toHaveLength(1);
    expect(mock.reap).not.toHaveBeenCalled();
  });

  it('retains the lease across a newer server until kernel proof succeeds, without replay', async () => {
    let release!: (value: boolean) => void;
    mock.reap.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve; }));
    mock.call.mockImplementation((method, _params, opts) => {
      if (method === 'spawn:cancel') return Promise.resolve(capabilities);
      if (method === 'process:exec') { opts.onRequestId(7); return Promise.reject(new Error('server died')); }
      if (method === 'process:drain') return Promise.reject(new Error('server generation mismatch'));
    });
    let settled = false;
    const run = runCommandViaSpawnerSidecar('git', ['commit'], {
      timeoutMs: 5000, signal: new AbortController().signal,
    }).then((result) => { settled = true; return result; });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(settled).toBe(false);
    release(true);
    expect((await run).stderr).toContain('not replayed');
    expect(mock.call.mock.calls.filter(([method]) => method === 'process:exec')).toHaveLength(1);
  });
});
