/**
 * The live bench harness's own teardown must remove the pot's LEARNING rows
 * (learning-pot-scope-gate-2026-08-30, P-011).
 *
 * THE BUG THIS PINS. `gym_autoloop_config` and `learning_governor_loops` are
 * keyed by slug in the SHARED schema, so `dropHarnessSchema` cannot reach them
 * and `removeHarnessFromWorkspace` only makes them invisible. This teardown did
 * exactly those two things and nothing else, so every bench run left arming rows
 * behind that no surface enumerates and nothing ever deletes. Measured live
 * 2026-08-30: 28 orphans in each table, every one an `xbench-su-*` / `xb*` /
 * `heval*` bench slug. `pot:dissolve` and `pot:obliterate` have called
 * `teardownPotLearningLoop` since P-021; this path was the one that did not.
 *
 * Migration 1042 reconciles the rows that already leaked; this test is what
 * stops the leak reopening.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let teardownLoopCalls: Array<{ workspaceId: string; potSlug: string }>;
let deregCalls: Array<{ workspaceId: string; slug: string }>;
let dropSchemaCalls: string[];
let order: string[];
/** When set, teardownPotLearningLoop throws — teardown must still finish. */
let teardownLoopThrows: boolean;
let costReads: number;
let costReadFaultAt: number;
let measuredCost: unknown;
let spawnCalls: string[];

beforeEach(() => {
  vi.resetModules();
  teardownLoopCalls = [];
  deregCalls = [];
  dropSchemaCalls = [];
  order = [];
  teardownLoopThrows = false;
  costReads = 0; costReadFaultAt = -1;
  measuredCost = [{ tokens_in: '0', tokens_out: '0', cost_usd: '0', turns: '0' }];
  spawnCalls = [];
  vi.doMock('../dbos/orchestrator-runner', () => ({ spawnInvokeOnce: async (_dir: string, role: string) => {
    spawnCalls.push(role); return { exitCode: 0, output: 'DONE', stderr: '' };
  } }));
  vi.doMock('../dbos/orchestrator-spawn-env', () => ({ buildPipelineExtraEnv: () => ({}) }));
  vi.doMock('@papercusp/orchestrator', () => ({ parseDecisionFor: () => 'DONE' }));
  vi.doMock('@papercusp/orchestrator/blueprint', () => ({
    loadBlueprintFromFile: () => ({ blueprint: { spine: { edges: { DONE: {} }, decider: 'director', maxTurns: 1 } } }),
    deriveNext: () => costReadFaultAt === 1 ? { kind: 'spawn', role: 'worker', extras: [] } : { kind: 'terminal', outcome: 'done' },
  }));

  vi.doMock('../pot/provision-learning-loop', () => ({
    teardownPotLearningLoop: async ({
      workspaceId,
      potSlug,
    }: {
      workspaceId: string;
      potSlug: string;
    }) => {
      order.push('learning-loop');
      teardownLoopCalls.push({ workspaceId, potSlug });
      if (teardownLoopThrows) throw new Error('boom');
      return { potSlug, gymAutoloop: true, scoutRoutine: true, governorRegistrants: true };
    },
  }));
  vi.doMock('../harness-membership', () => ({
    removeHarnessFromWorkspace: async (workspaceId: string, slug: string) => {
      order.push('deregister');
      deregCalls.push({ workspaceId, slug });
      return { changed: true };
    },
  }));
  vi.doMock('../scaffold-harness-schema', () => ({
    dropHarnessSchema: async (slug: string) => {
      order.push('drop-schema');
      dropSchemaCalls.push(slug);
    },
  }));
  vi.doMock('@papercusp/db-org', async () => ({
    ...(await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org')),
    getOrgPg: () => ({ sql: async () => {
      if (costReads++ === costReadFaultAt) throw new Error('PRIVATE SQL READ FAILURE');
      return measuredCost;
    } }),
  }));
});

const runTeardown = async () => {
  const { liveBenchHarnessOps } = await import('./bench-harness-live');
  const ops = liveBenchHarnessOps({ workspaceId: 'ws-1' });
  await ops.teardown({
    handle: { slug: 'xbench-su-AbC123' },
    workspaceId: 'ws-1',
  } as unknown as Parameters<typeof ops.teardown>[0]);
};

describe('liveBenchHarnessOps.driveToDone spend guard', () => {
  const drive = async () => {
    const { liveBenchHarnessOps } = await import('./bench-harness-live');
    return liveBenchHarnessOps({ workspaceId: 'ws-1' }).driveToDone({
      handle: { slug: 'xbench-private', featureId: 'F-XB', worktreePath: '/private-fixture' },
      workspaceId: 'ws-1', budget: { maxUsd: 3, maxTokens: 1000 }, timeoutMs: 10_000, pollMs: 1,
    });
  };
  it('refuses unknown spend before starting the decider', async () => {
    costReadFaultAt = 0;
    await expect(drive()).rejects.toThrow();
    expect(spawnCalls).toEqual([]);
  });
  it('refuses unknown spend between the decider and role dispatch', async () => {
    costReadFaultAt = 1;
    await expect(drive()).rejects.toThrow();
    expect(spawnCalls).toEqual(['director']);
  });
  it.each(['invalid-number', 'negative', 'missing-aggregate', 'partial-usage'] as const)
  ('refuses %s spend evidence before spawning', async kind => {
    if (kind === 'invalid-number') measuredCost = [{ tokens_in: 'nan', tokens_out: '0', cost_usd: '0', turns: '0' }];
    if (kind === 'negative') measuredCost = [{ tokens_in: '-1', tokens_out: '0', cost_usd: '0', turns: '0' }];
    if (kind === 'missing-aggregate') measuredCost = [];
    if (kind === 'partial-usage') measuredCost = [{ tokens_in: '1', tokens_out: '0', cost_usd: '0', turns: '1', missing_measurements: '1' }];
    await expect(drive()).rejects.toThrow();
    expect(spawnCalls).toEqual([]);
  });
  it('accepts a measured empty population and retains the actual monetary cap', async () => {
    expect(await drive()).toMatchObject({ disposition: 'done' });
    expect(spawnCalls).toEqual(['director']);
    measuredCost = [{ tokens_in: '100', tokens_out: '20', cost_usd: '3', turns: '1' }];
    spawnCalls = [];
    expect(await drive()).toMatchObject({ disposition: 'budget-exhausted' });
    expect(spawnCalls).toEqual([]);
  });
});

describe('liveBenchHarnessOps.teardown', () => {
  it('tears down the pot learning loop, not only the registry entry and the schema', async () => {
    await runTeardown();
    expect(teardownLoopCalls).toEqual([{ workspaceId: 'ws-1', potSlug: 'xbench-su-AbC123' }]);
    expect(deregCalls).toEqual([{ workspaceId: 'ws-1', slug: 'xbench-su-AbC123' }]);
    expect(dropSchemaCalls).toEqual(['xbench-su-AbC123']);
  });

  it('tears the learning rows down BEFORE deregistering the harness', async () => {
    // Ordering is load-bearing: the learning teardown resolves against a slug
    // the registry still knows. Deregistering first is how a "successful"
    // teardown silently clears nothing.
    await runTeardown();
    expect(order.indexOf('learning-loop')).toBeLessThan(order.indexOf('deregister'));
  });

  it('still deregisters and drops the schema when the learning teardown throws', async () => {
    // Best-effort, matching the two calls it sits beside: teardown must never
    // mask the run's outcome.
    teardownLoopThrows = true;
    await expect(runTeardown()).resolves.toBeUndefined();
    expect(deregCalls).toHaveLength(1);
    expect(dropSchemaCalls).toEqual(['xbench-su-AbC123']);
  });
});
