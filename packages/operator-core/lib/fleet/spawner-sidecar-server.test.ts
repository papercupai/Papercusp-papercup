import { describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpawnerSidecarLoopDelay } from './spawner-sidecar-loop-delay';

const invocation = vi.hoisted(() => ({ loaded: vi.fn(), run: vi.fn() }));
vi.mock('../flag-override-store-boot-effect', () => ({}));
vi.mock('../flag-override-store', () => ({ installFlagOverrideStore: () => {} }));
vi.mock('../flag-change-listener', () => ({ ensureFlagChangeListener: async () => {} }));
vi.mock('../dbos/orchestrator-runner', () => {
  invocation.loaded();
  return { spawnInvokeOnce: invocation.run };
});
vi.mock('./spawner-sidecar-spawn', () => ({ spawnSpawnerSidecar: async () => {} }));

import { runSpawnerSidecarServer } from './spawner-sidecar-server';
import { SpawnerIpcClient } from './spawner-ipc-client';

describe('spawner sidecar health', () => {
  it('reports a loop stall and resets the measurement window', async () => {
    const health = createSpawnerSidecarLoopDelay(1);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const end = performance.now() + 80;
      while (performance.now() < end) { /* deliberate synchronous loop stall */ }
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(health.readP99Ms()).toBeGreaterThan(40);

      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(health.readP99Ms()).toBeLessThan(40);
    } finally {
      health.close();
    }
  });

  it('the real health RPC reports a 200 ms stall and resets its response window', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sidecar-health-'));
    const socketPath = join(directory, 'health.sock');
    vi.stubEnv('PAPERCUSP_SPAWNER_IPC_SOCKET', socketPath);
    const server = runSpawnerSidecarServer();
    const client = new SpawnerIpcClient(socketPath);
    try {
      await once(server, 'listening');
      await new Promise((resolve) => setTimeout(resolve, 40));
      // The existing cancellation/capability query is the sidecar health RPC;
      // with no requestId it does not cancel any command or create a process.
      const health = () => client.call<{ eventLoopDelayP99Ms: number }>('spawn:cancel', {});
      const before = await health();
      expect(Number.isFinite(before.eventLoopDelayP99Ms)).toBe(true);
      // The read resets the histogram. Arm that fresh window before injecting
      // the stall, just as the helper-level control arms its initial window.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const until = performance.now() + 200;
      while (performance.now() < until) { /* deliberate server event-loop stall */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
      const after = await health();
      expect(after.eventLoopDelayP99Ms, JSON.stringify({ before, after })).toBeGreaterThanOrEqual(180);
      expect(after.eventLoopDelayP99Ms).toBeGreaterThan(before.eventLoopDelayP99Ms + 100);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect((await health()).eventLoopDelayP99Ms).toBeLessThan(after.eventLoopDelayP99Ms);
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('serves health before loading agent orchestration, then forwards the invocation and its notifications', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sidecar-invoke-load-'));
    const socketPath = join(directory, 'server.sock');
    vi.stubEnv('PAPERCUSP_SPAWNER_IPC_SOCKET', socketPath);
    const server = runSpawnerSidecarServer();
    const client = new SpawnerIpcClient(socketPath);
    const result = { output: 'agent result', exitCode: 0, stderr: '', rawStdoutTail: '' };
    invocation.run.mockImplementation(async (...args: unknown[]) => {
      const opts = args[4] as { onChildPid: (pid: number) => void; onOutputActivity: () => void };
      opts.onChildPid(1234);
      opts.onOutputActivity();
      return result;
    });
    const onPid = vi.fn();
    const onOutputActivity = vi.fn();
    try {
      await once(server, 'listening');
      await client.call('spawn:cancel', {});
      expect(invocation.loaded).not.toHaveBeenCalled();
      const reply = await client.call('spawn:invokeOnce', {
        projectDir: directory, role: 'test', extras: ['one'], extraEnv: { TEST: 'yes' },
        timeoutMs: 5000, resultPath: 'result.json', forceSessionId: 'test-session', taskSpawnId: 'test-task',
      }, { onPid, onOutputActivity });
      expect(reply).toEqual(result);
      expect(invocation.loaded).toHaveBeenCalledTimes(1);
      expect(invocation.run).toHaveBeenCalledWith(directory, 'test', ['one'], { TEST: 'yes' }, expect.objectContaining({
        signal: expect.any(AbortSignal), timeoutMs: 5000, resultPath: 'result.json',
        forceSessionId: 'test-session', taskSpawnId: 'test-task',
      }));
      expect(onPid).toHaveBeenCalledWith(1234);
      expect(onOutputActivity).toHaveBeenCalledTimes(1);
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
