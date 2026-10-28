import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// WI-10006716: an UNSIGNALLED sidecar call keeps the legacy contract of rethrowing a
// transport error, so the catch site cannot tell "nothing ran" from "the child may
// have run". The throw site must mark the post-dispatch case.
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

import { resetSidecarFallbackStatsForTest, runCommandViaSpawnerSidecar } from './git-via-sidecar';
import { isSidecarPostDispatchFault, sidecarPostDispatchDetail } from './sidecar-dispatch-fault';

async function rejection(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error('expected the sidecar call to reject');
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  resetSidecarFallbackStatsForTest();
  mock.preflight.mockReturnValue(true);
  mock.reap.mockResolvedValue(false);
  // A post-dispatch transport fault is logged as [spawner-process-exec-fault];
  // the post-dispatch cases assert that line, the others assert its absence.
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

const execFaultLogged = (): boolean =>
  warn.mock.calls.some((call: unknown[]) => call[0] === '[spawner-process-exec-fault]');

describe('unsignalled process:exec transport failures', () => {
  it('marks a transport loss AFTER dispatch as an unknown-outcome fault, preserving the original error', async () => {
    const transport = Object.assign(new Error('Socket error: connection reset'), { code: 'ECONNRESET' });
    mock.call.mockImplementation((method: string, _params: unknown, opts?: { onRequestId?: (id: number, c: string) => void }) => {
      if (method !== 'process:exec') throw new Error(`unexpected RPC ${method}`);
      opts?.onRequestId?.(41, 'conn-a');
      return Promise.reject(transport);
    });

    const error = await rejection(runCommandViaSpawnerSidecar('git', ['commit-tree', 'tree-id', '-m', 'x'], {
      cwd: '/tmp', timeoutMs: 5000,
    }));

    expect(error).toBe(transport);
    expect((error as NodeJS.ErrnoException).code).toBe('ECONNRESET');
    expect(isSidecarPostDispatchFault(error)).toBe(true);
    expect(sidecarPostDispatchDetail(error)).toEqual({ requestId: 41 });
    expect(execFaultLogged()).toBe(true);
  });

  it('marks an RPC timeout after dispatch, because the child may still be running', async () => {
    mock.call.mockImplementation((method: string, _params: unknown, opts?: { onRequestId?: (id: number, c: string) => void }) => {
      if (method !== 'process:exec') throw new Error(`unexpected RPC ${method}`);
      opts?.onRequestId?.(42, 'conn-b');
      return Promise.reject(new Error('RPC request timeout: process:exec'));
    });

    const error = await rejection(runCommandViaSpawnerSidecar('git', ['update-ref', 'refs/x', 'oid'], {
      cwd: '/tmp', timeoutMs: 5000,
    }));

    expect(isSidecarPostDispatchFault(error)).toBe(true);
  });

  it('does not mark a transport failure BEFORE dispatch, which stays safe to replay locally', async () => {
    mock.call.mockImplementation((method: string) => {
      if (method !== 'process:exec') throw new Error(`unexpected RPC ${method}`);
      return Promise.reject(Object.assign(new Error('connect ECONNREFUSED /run/spawner.sock'), { code: 'ECONNREFUSED' }));
    });

    const error = await rejection(runCommandViaSpawnerSidecar('git', ['commit-tree', 'tree-id', '-m', 'x'], {
      cwd: '/tmp', timeoutMs: 5000,
    }));

    expect((error as Error).message).toContain('ECONNREFUSED');
    expect(isSidecarPostDispatchFault(error)).toBe(false);
    expect(execFaultLogged()).toBe(false);
  });

  it('does not mark a non-transport error the sidecar answered after dispatch', async () => {
    mock.call.mockImplementation((method: string, _params: unknown, opts?: { onRequestId?: (id: number, c: string) => void }) => {
      if (method !== 'process:exec') throw new Error(`unexpected RPC ${method}`);
      opts?.onRequestId?.(43, 'conn-c');
      return Promise.reject(new Error('invalid params: command'));
    });

    const error = await rejection(runCommandViaSpawnerSidecar('git', ['commit-tree', 'tree-id', '-m', 'x'], {
      cwd: '/tmp', timeoutMs: 5000,
    }));

    expect(isSidecarPostDispatchFault(error)).toBe(false);
  });

  it('forwards only the supplied safe diagnostic correlation tags with the process exec request', async () => {
    const runId = '35118a11-cd1d-4470-8652-e59592c0197c';
    let sentParams: unknown;
    mock.call.mockImplementation((method: string, params: unknown, opts?: { onRequestId?: (id: number, connectionId: string) => void }) => {
      if (method !== 'process:exec') throw new Error(`unexpected RPC ${method}`);
      sentParams = params;
      opts?.onRequestId?.(44, 'client-connection-44');
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    });

    await expect(runCommandViaSpawnerSidecar('git', ['fetch'], {
      cwd: '/tmp', timeoutMs: 5000,
      diagnosticTags: { runId, commandClass: 'git' },
    })).resolves.toMatchObject({ code: 0, stdout: '', stderr: '' });

    expect(sentParams).toMatchObject({ diagnosticTags: { runId, commandClass: 'git' } });
  });
});
