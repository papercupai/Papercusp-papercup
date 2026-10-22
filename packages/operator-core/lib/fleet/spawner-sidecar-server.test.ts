import { describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpawnerSidecarLoopDelay } from './spawner-sidecar-loop-delay';

vi.mock('../flag-override-store-boot-effect', () => ({}));
vi.mock('../flag-override-store', () => ({ installFlagOverrideStore: () => {} }));
vi.mock('../flag-change-listener', () => ({ ensureFlagChangeListener: async () => {} }));
vi.mock('../dbos/orchestrator-runner', () => ({ spawnInvokeOnce: vi.fn() }));
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
});
