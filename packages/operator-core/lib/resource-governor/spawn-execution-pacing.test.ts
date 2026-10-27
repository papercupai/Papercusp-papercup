/**
 * EI-21935016329074048 regression guard.
 *
 * The unit tests beside this file prove the PACER works. This one proves it is actually
 * WIRED INTO the chokepoint every agent launch passes through — the gap that let 21
 * simultaneous `capability:launch-agent { resume }` calls boot at once and silently drop
 * two kickoff briefs. A correct-but-unreferenced pacer would pass every test in
 * `spawn-pacing.test.ts` and fix nothing.
 *
 * Written to fail against the pre-fix `spawn-execution.ts`, where the burst below enters
 * all six spawn callbacks simultaneously (peak 6, span ~0ms).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const beginGovernedExecutionMock = vi.fn();

vi.mock('./execution', async (importOriginal) => ({
  settleGovernedExecutionInBackground: (await importOriginal<typeof import('./execution')>()).settleGovernedExecutionInBackground,
  beginGovernedExecution: (...args: unknown[]) => beginGovernedExecutionMock(...args),
  governedExecutionRuntime: () => ({ governor: {}, driver: {} }),
}));

import { spawnGovernedAgentProcess } from './spawn-execution';
import { resetAgentSpawnPacingForTests } from './spawn-pacing';

const context = {
  contractVersion: 1 as const,
  requestId: 'request-1',
  rootRequestId: 'request-1',
  parentRequestId: null,
  parentReceiptId: null,
  receiptId: 'WI-1',
  idempotencyKey: 'spawn-1',
  admissionClass: 'agent',
  priority: 0,
  demand: { cpuWeight: 1 },
  depth: 0,
  createdAtMs: 1,
  decisionGeneration: 2,
  leaseId: 'lease-1',
};

const ENV_KEYS = [
  'PAPERCUSP_AGENT_SPAWN_MAX_CONCURRENT_BOOTS',
  'PAPERCUSP_AGENT_SPAWN_BOOT_SETTLE_MS',
  'PAPERCUSP_AGENT_SPAWN_PACING_MAX_WAIT_MS',
] as const;

describe('spawnGovernedAgentProcess boot pacing', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    vi.clearAllMocks();
    resetAgentSpawnPacingForTests();
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    process.env.PAPERCUSP_AGENT_SPAWN_MAX_CONCURRENT_BOOTS = '2';
    process.env.PAPERCUSP_AGENT_SPAWN_BOOT_SETTLE_MS = '25';
    process.env.PAPERCUSP_AGENT_SPAWN_PACING_MAX_WAIT_MS = '5000';
    beginGovernedExecutionMock.mockResolvedValue({
      context,
      finish: vi.fn(async () => true),
      cancel: vi.fn(async () => true),
    });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAgentSpawnPacingForTests();
  });

  it('paces a concurrent burst instead of booting every agent at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const t0 = Date.now();
    const startOffsets: number[] = [];

    await Promise.all(
      Array.from({ length: 6 }, (_unused, i) =>
        spawnGovernedAgentProcess(
          { workspaceId: 'ws', idempotencyKey: `spawn-${i}`, owner: 'launcher' },
          (async () => {
            startOffsets.push(Date.now() - t0);
            inFlight += 1;
            if (inFlight > peak) peak = inFlight;
            await new Promise((r) => setTimeout(r, 10));
            inFlight -= 1;
            return {
              status: 'ok' as const,
              pid: 100 + i,
              terminal: 'headless',
              child: null,
              childExit: new Promise(() => {}),
              display: null,
              desktopEnvResolvedVia: null,
            };
          }) as never,
        ),
      ),
    );

    // Pre-fix this is 6: every launch entered its spawn callback simultaneously.
    expect(peak).toBeLessThanOrEqual(2);
    // 6 spawns / 2 slots = 3 waves, so real time must have elapsed between the
    // first and last start. Pre-fix the whole span is ~0ms.
    expect(Math.max(...startOffsets) - Math.min(...startOffsets)).toBeGreaterThanOrEqual(25);
  });

  it('still cancels the durable receipt when a paced spawn errors', async () => {
    const cancel = vi.fn(async () => true);
    beginGovernedExecutionMock.mockResolvedValue({
      context,
      finish: vi.fn(async () => true),
      cancel,
    });
    const result = await spawnGovernedAgentProcess(
      { workspaceId: 'ws', idempotencyKey: 'spawn-err', owner: 'launcher' },
      async () => ({ status: 'error', error: 'no terminal', code: 502 }) as never,
    );
    expect(result).toMatchObject({ status: 'error' });
    expect(cancel).toHaveBeenCalledWith('no terminal');
  });
});
