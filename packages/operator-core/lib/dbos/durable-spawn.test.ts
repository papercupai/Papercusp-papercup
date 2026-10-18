/**
 * durable-spawn.test.ts — the reusable durable-spawn wrapper (P-010).
 *
 * DBOS is mocked: registerWorkflow returns the impl, WorkflowQueue is a real class
 * (it's `new`'d at import), startWorkflow is a spy we can make succeed or throw. We
 * assert the request-only client path, stable dedup identity, and fail-closed
 * handling when an attempted enqueue has an uncertain outcome.
 *
 * The spies + the DBOS-on flag live in `vi.hoisted` because the `vi.mock` factories
 * are hoisted above top-level declarations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  startWorkflow: vi.fn((_wf: unknown, _opts: unknown) => (_input: unknown) => Promise.resolve()),
  remoteEnqueue: vi.fn(async (opts: { workflowID: string }) => ({ workflowID: opts.workflowID })),
  remoteGetWorkflow: vi.fn(async (_id: string): Promise<unknown | undefined> => undefined),
  loopbackFetch: vi.fn(async (..._args: unknown[]): Promise<{ ok: boolean; status: number; text?: () => Promise<string> }> => ({ ok: true, status: 200 })),
  recordSpawn: vi.fn(async (_sql: unknown, _input: Record<string, unknown>) => {}),
  finishSpawn: vi.fn(async (_sql: unknown, _input: Record<string, unknown>) => {}),
  recordSpawnAccountRoute: vi.fn(async (..._args: unknown[]) => {}),
  spawnAccountRouteFromLaunch: vi.fn((_body: unknown, _spawnId: string) => null),
  recordSpawnPid: vi.fn(async (_sql: unknown, _spawnId: string, _pid: number) => {}),
  heartbeatSpawns: vi.fn(async (_sql: unknown, _spawnIds: string[]) => {}),
  selectSpawnAccount: vi.fn(async () => undefined as string | undefined),
  updateAccountPool: vi.fn(async (mutator: (pool: unknown) => unknown, _ws?: string) => mutator({ accounts: [] })),
  recordAccountPenalty: vi.fn((pool: unknown, _id: string, _now: number, _opts?: { pausedUntil?: number }) => pool),
  getFlag: vi.fn(async (_flag: string, _scope?: string) => true),
  ownerSteering: { value: null as null | Record<string, unknown> },
  agentConfig: { value: null as null | Record<string, unknown> },
  pgRunOutputRows: { value: [] as Array<{ diagnostic: string | null }> },
  activeQueenRows: { value: [] as Array<{ spawn_id: string; harness_slug: string | null }> },
  sql: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  isInStep: vi.fn(() => false),
  state: { dbosOn: true, dbosStarted: true },
  // P-006: deterministic gateway-throttle corroboration (a real probe would reach the live :8788
  // gateway and make these tests flake). false ⇒ a no-turn death classifies infra_loss (legacy);
  // flip to true to exercise the capacity_shed path.
  gatewayThrottled: { value: false },
  // EI-8177: the target-harness-still-registered probe. Defaults to "exists" (a
  // truthy project) so every pre-existing test keeps firing unchanged; tests for
  // the new skip flip this to null.
  resolveProject: vi.fn(async (_slug: string, _ws?: string): Promise<{ slug: string } | null> => ({ slug: 'h' })),
  goneTargetSkipValue: { value: null as string | null },
  setPotStarted: vi.fn(async (_workspaceId: string, _installSlug: string, _started: boolean) => {}),
  setOverwatchStarted: vi.fn(async (_workspaceId: string, _installSlug: string, _started: boolean) => {}),
  resolveBrainOwner: vi.fn(async (_workspaceId: string) => 'owner-1' as string | null),
  wakeRecipients: vi.fn(async (..._args: unknown[]) => ({ woken: 1 })),
  // EI-9759: the pre-invoke-skip → dispatch-ledger close back-edge.
  markDispatchOrphaned: vi.fn(async (_id: string, _by: string, _detail?: string) => true),
  recordFireResult: vi.fn(async (_id: string, _result: unknown) => {}),
  mergeIssuePayload: vi.fn(async (_id: string, _patch: Record<string, unknown>) => undefined),
}));

vi.mock('@dbos-inc/dbos-sdk', () => {
  class WorkflowQueue {
    constructor(public name: string, public opts?: unknown) {}
  }
  return {
    WorkflowQueue,
    DBOS: {
      runStep: (fn: () => unknown) => fn(),
      registerWorkflow: (impl: unknown) => impl,
      startWorkflow: h.startWorkflow,
      isInStep: h.isInStep,
    },
  };
});
vi.mock('./dbos-flags', () => ({ dbosOrchestratorActive: () => h.state.dbosOn }));
vi.mock('./bootstrap', () => ({ dbosStarted: () => h.state.dbosStarted }));
vi.mock('../loopback-fetch', () => ({ loopbackFetch: h.loopbackFetch }));
vi.mock('../fleet/spawn-tree', () => ({
  recordSpawn: h.recordSpawn,
  finishSpawn: h.finishSpawn,
  recordSpawnAccountRoute: h.recordSpawnAccountRoute,
  spawnAccountRouteFromLaunch: h.spawnAccountRouteFromLaunch,
}));
vi.mock('../fleet/spawn-reclaim', () => ({
  recordSpawnPid: h.recordSpawnPid,
  heartbeatSpawns: h.heartbeatSpawns,
  SPAWN_HEARTBEAT_INTERVAL_MS: 1000,
}));
vi.mock('../deployment/account-pool-store', () => ({
  selectSpawnAccount: h.selectSpawnAccount,
  updateAccountPool: h.updateAccountPool,
}));
vi.mock('../deployment/account-pool', () => ({ recordAccountPenalty: h.recordAccountPenalty }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: h.getFlag }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('../owner-steering', () => ({
  getOwnerSteering: vi.fn(async () => h.ownerSteering.value ?? {
    directive: null,
    eligiblePlans: [],
    eligibleHives: [],
    pauseNewWork: false,
    pausedUntil: null,
    modelTiers: null,
    tierCeilings: null,
    modelOverrides: null,
  }),
}));
vi.mock('../agent-config', () => ({ readAgentConfig: vi.fn(async () => h.agentConfig.value) }));
// P-006: the gateway-throttle probe is mocked so the capacity_shed vs infra_loss classification is
// deterministic (the real gatewayWholesaleThrottled would fetch the live :8788 gateway → flaky).
vi.mock('../inference-gateway/observability', () => ({
  gatewayWholesaleThrottled: vi.fn(async () => h.gatewayThrottled.value),
}));
vi.mock('../harness-core', () => ({ resolveProject: h.resolveProject }));
vi.mock('../pot/started', () => ({ setPotStarted: h.setPotStarted }));
vi.mock('../overwatch/control-state', () => ({ setOverwatchStarted: h.setOverwatchStarted }));
vi.mock('../harness/routines/wake-brain-action', () => ({ resolveBrainOwner: h.resolveBrainOwner }));
vi.mock('../agent-tools/coordination/inbox-wake', () => ({ wakeRecipients: h.wakeRecipients }));
vi.mock('../harness/improvements/dispatch-ledger', () => ({
  markDispatchOrphaned: h.markDispatchOrphaned,
  recordFireResult: h.recordFireResult,
}));
vi.mock('../issues-engineer', () => ({ mergeIssuePayload: h.mergeIssuePayload }));

import {
  durableSpawnFire,
  DurableSpawnEnqueueUncertainError,
  durableSpawnFireImpl,
  startDurableSpawns,
  isPermanentSpawnStatus,
  durableSpawnWorkflowTimeoutMs,
  DURABLE_SPAWN_FINISH_CUSHION_MS,
} from './durable-spawn';

const INPUT = {
  url: 'http://x/api/harness/h/invoke?role=worker',
  body: { kickoff: 'go' },
  idempotencyKey: 'k1',
  label: 'h/worker',
};
const remoteClient = async () => ({ enqueue: h.remoteEnqueue, getWorkflow: h.remoteGetWorkflow });

beforeEach(() => {
  h.state.dbosOn = true;
  h.state.dbosStarted = true;
  h.isInStep.mockReset();
  h.isInStep.mockReturnValue(false);
  h.startWorkflow.mockReset();
  h.startWorkflow.mockImplementation((_wf, _opts) => (_input) => Promise.resolve());
  h.remoteEnqueue.mockReset();
  h.remoteEnqueue.mockImplementation(async (opts: { workflowID: string }) => ({ workflowID: opts.workflowID }));
  h.remoteGetWorkflow.mockReset();
  h.remoteGetWorkflow.mockResolvedValue(undefined);
  h.recordSpawn.mockClear();
  h.finishSpawn.mockClear();
  h.recordSpawnPid.mockClear();
  h.heartbeatSpawns.mockClear();
  h.selectSpawnAccount.mockReset();
  h.selectSpawnAccount.mockResolvedValue(undefined);
  h.updateAccountPool.mockReset();
  h.updateAccountPool.mockImplementation(async (mutator: (pool: unknown) => unknown) => mutator({ accounts: [] }));
  h.recordAccountPenalty.mockReset();
  h.recordAccountPenalty.mockImplementation((pool: unknown) => pool);
  h.getFlag.mockReset();
  h.getFlag.mockResolvedValue(true);
  h.ownerSteering.value = null;
  h.agentConfig.value = null;
  h.pgRunOutputRows.value = [];
  h.activeQueenRows.value = [];
  h.goneTargetSkipValue.value = null;
  h.setPotStarted.mockClear();
  h.setOverwatchStarted.mockClear();
  h.resolveBrainOwner.mockReset();
  h.resolveBrainOwner.mockResolvedValue('owner-1');
  h.wakeRecipients.mockClear();
  h.markDispatchOrphaned.mockReset();
  h.markDispatchOrphaned.mockResolvedValue(true);
  h.recordFireResult.mockClear();
  h.mergeIssuePayload.mockReset();
  h.mergeIssuePayload.mockResolvedValue(undefined);
  h.sql.mockReset();
  h.sql.mockImplementation(async (...args: unknown[]): Promise<unknown[]> => {
    const strings = args[0] as TemplateStringsArray | string | undefined;
    const text = Array.isArray(strings) ? strings.join(' ') : String(strings);
    if (text.includes('FROM harness_shared.spawned_agents')) return h.activeQueenRows.value as unknown[];
    if (text.includes('INSERT INTO harness_shared.operator_settings') && text.includes('RETURNING value')) {
      const previous = Number(h.goneTargetSkipValue.value);
      if (Number.isFinite(previous) && previous < 0) return [{ value: String(previous) }];
      const next = Number.isFinite(previous) && previous > 0 ? previous + 1 : 1;
      h.goneTargetSkipValue.value = String(next);
      return [{ value: String(next) }];
    }
    if (text.includes('DELETE FROM harness_shared.operator_settings')) {
      h.goneTargetSkipValue.value = null;
      return [];
    }
    if (text.includes('UPDATE harness_shared.operator_settings')) {
      h.goneTargetSkipValue.value = '-3';
      return [];
    }
    return h.pgRunOutputRows.value as unknown[];
  });
  (h.sql as typeof h.sql & { begin: (cb: (tx: typeof h.sql) => unknown) => unknown }).begin = vi.fn(
    async (cb: (tx: typeof h.sql) => unknown) => cb(h.sql),
  );
  h.loopbackFetch.mockReset();
  h.loopbackFetch.mockImplementation(async () => ({ ok: true, status: 200 }));
  h.gatewayThrottled.value = false; // default: gateway healthy ⇒ a no-turn death is infra_loss
  h.resolveProject.mockReset();
  h.resolveProject.mockResolvedValue({ slug: 'h' }); // default: target harness still exists
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('durableSpawnFire (P-010)', () => {
  it('returns false + does NOT enqueue when DBOS is off (caller fire-and-forgets)', async () => {
    h.state.dbosOn = false;
    const r = await durableSpawnFire(INPUT);
    expect(r).toBe(false);
    expect(h.startWorkflow).not.toHaveBeenCalled();
  });

  it('enqueues a dedup-keyed durable workflow + returns true when DBOS is on', async () => {
    const r = await durableSpawnFire(INPUT);
    expect(r).toBe(true);
    expect(h.startWorkflow).toHaveBeenCalledTimes(1);
    const opts = h.startWorkflow.mock.calls[0][1] as {
      workflowID: string;
      enqueueOptions: { deduplicationID: string };
      duplicationPolicy: string;
    };
    expect(opts.workflowID).toBe('durable-spawn:k1');
    expect(opts.enqueueOptions.deduplicationID).toBe('durable-spawn:k1');
    expect(opts.duplicationPolicy).toBe('return-existing');
  });

  it('stamps DBOS workflow timeout from the invoke body plus cleanup cushion when launch has a deadline', async () => {
    const r = await durableSpawnFire({ ...INPUT, body: { kickoff: 'go', timeoutMs: 180_000 } });
    expect(r).toBe(true);
    const opts = h.startWorkflow.mock.calls[0][1] as { timeoutMS?: number };
    expect(opts.timeoutMS).toBe(180_000 + DURABLE_SPAWN_FINISH_CUSHION_MS);
  });

  it('leaves long-running worker launches without a DBOS workflow timeout when the body has none', async () => {
    const r = await durableSpawnFire(INPUT);
    expect(r).toBe(true);
    const opts = h.startWorkflow.mock.calls[0][1] as { timeoutMS?: number };
    expect(opts.timeoutMS).toBeUndefined();
  });

  it('derives only positive numeric workflow deadlines from durable spawn bodies', () => {
    expect(durableSpawnWorkflowTimeoutMs({ ...INPUT, body: { timeoutMs: 1234.9 } })).toBe(
      1234 + DURABLE_SPAWN_FINISH_CUSHION_MS,
    );
    expect(durableSpawnWorkflowTimeoutMs({ ...INPUT, body: { timeoutMs: 0 } })).toBeUndefined();
    expect(durableSpawnWorkflowTimeoutMs({ ...INPUT, body: { timeoutMs: '180000' } })).toBeUndefined();
  });

  it('does not downgrade an uncertain in-process enqueue to a direct fire', async () => {
    h.startWorkflow.mockImplementation(() => {
      throw new Error('enqueue reply lost');
    });
    await expect(durableSpawnFire(INPUT, { remoteClient })).rejects.toBeInstanceOf(DurableSpawnEnqueueUncertainError);
  });

  // WI-2605: two documented-as-expected degrades that used to fall through to a
  // startWorkflow throw + a scary console.warn every time — now detected up front.
  describe('WI-2605 — anticipated degrades skip the doomed attempt (no log noise)', () => {
    it('enqueues through the DBOS client when this request-only host has no executor', async () => {
      h.state.dbosStarted = false;
      const r = await durableSpawnFire(INPUT, { remoteClient });
      expect(r).toBe(true);
      expect(h.startWorkflow).not.toHaveBeenCalled();
      expect(h.remoteEnqueue).toHaveBeenCalledWith(expect.objectContaining({
        queueName: 'durable-spawn-fire', workflowName: 'durableSpawnFire',
        workflowID: 'durable-spawn:k1', deduplicationID: 'durable-spawn:k1',
        duplicationPolicy: 'return-existing', appVersion: 'bg-host-v1',
      }), INPUT);
    });

    it('treats a lost enqueue response as accepted only when the exact workflow is readable', async () => {
      h.state.dbosStarted = false;
      h.remoteEnqueue.mockRejectedValueOnce(new Error('reply lost'));
      h.remoteGetWorkflow.mockResolvedValueOnce({ workflowID: 'durable-spawn:k1', status: 'ENQUEUED' });
      await expect(durableSpawnFire(INPUT, { remoteClient })).resolves.toBe(true);
      expect(h.remoteGetWorkflow).toHaveBeenCalledWith('durable-spawn:k1');
    });

    it('refuses a direct fallback when an attempted remote enqueue remains uncertain', async () => {
      h.state.dbosStarted = false;
      h.remoteEnqueue.mockRejectedValueOnce(new Error('reply lost'));
      await expect(durableSpawnFire(INPUT, { remoteClient })).rejects.toBeInstanceOf(DurableSpawnEnqueueUncertainError);
    });

    it('returns false only when the remote client failed before an enqueue was attempted', async () => {
      h.state.dbosStarted = false;
      await expect(durableSpawnFire(INPUT, { remoteClient: async () => { throw new Error('database unavailable'); } })).resolves.toBe(false);
      expect(h.remoteEnqueue).not.toHaveBeenCalled();
    });

    it('returns false WITHOUT attempting startWorkflow when called from inside a DBOS step (e.g. git-sync:record dispatching doc-steward)', async () => {
      h.isInStep.mockReturnValue(true);
      const r = await durableSpawnFire(INPUT);
      expect(r).toBe(false);
      expect(h.startWorkflow).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('keeps an unexpected local enqueue failure uncertain when no DBOS row confirms it', async () => {
      h.startWorkflow.mockImplementation(() => {
        throw new Error('some other DBOS error');
      });
      await expect(durableSpawnFire(INPUT, { remoteClient })).rejects.toBeInstanceOf(DurableSpawnEnqueueUncertainError);
      expect(h.startWorkflow).toHaveBeenCalledTimes(1);
    });

    it('falls through to the real attempt when isInStep() itself throws (best-effort probe)', async () => {
      h.isInStep.mockImplementation(() => {
        throw new Error('isInStep unavailable');
      });
      const r = await durableSpawnFire(INPUT);
      expect(r).toBe(true);
      expect(h.startWorkflow).toHaveBeenCalledTimes(1);
    });
  });
});

describe('startDurableSpawns (EI-403-A — the workflow-layer drain seam)', () => {
  const REQ2 = { url: 'http://x/api/harness/h/invoke?role=worker', body: { kickoff: 'b' }, idempotencyKey: 'k2', label: 'h/worker' };

  it('no-ops (0/0, no enqueue) on undefined or empty', async () => {
    expect(await startDurableSpawns(undefined)).toEqual({ enqueued: 0, total: 0 });
    expect(await startDurableSpawns([])).toEqual({ enqueued: 0, total: 0 });
    expect(h.startWorkflow).not.toHaveBeenCalled();
  });

  it('enqueues every request once and reports enqueued===total when DBOS is on', async () => {
    const res = await startDurableSpawns([INPUT, REQ2]);
    expect(res).toEqual({ enqueued: 2, total: 2 });
    expect(h.startWorkflow).toHaveBeenCalledTimes(2);
    const ids = h.startWorkflow.mock.calls.map((c) => (c[1] as { workflowID: string }).workflowID);
    expect(ids).toEqual(['durable-spawn:k1', 'durable-spawn:k2']);
  });

  it('marks an improvement dispatch accepted only after its durable child is enqueued', async () => {
    const req = { ...INPUT, body: { kickoff: 'go', improvementDispatch: { dispatchId: 'dispatch-1', itemId: 'EI-1' } } };
    expect(await startDurableSpawns([req])).toEqual({ enqueued: 1, total: 1 });
    expect(h.recordFireResult).toHaveBeenCalledWith('dispatch-1', {
      ok: true, spawnedRunId: 'durable-spawn:k1',
    });
  });

  it('keeps a checkpointed one-shot request pending when DBOS is off', async () => {
    h.state.dbosOn = false;
    await expect(startDurableSpawns([INPUT, REQ2])).rejects.toThrow(/enqueue unavailable/);
    expect(h.startWorkflow).not.toHaveBeenCalled();
  });

  it('stops after an uncertain enqueue and retries the same workflow IDs', async () => {
    h.startWorkflow
      .mockImplementationOnce(() => {
        throw new Error('enqueue blip');
      })
      .mockImplementation((_wf, _opts) => (_input) => Promise.resolve());
    await expect(startDurableSpawns([INPUT, REQ2])).rejects.toBeInstanceOf(DurableSpawnEnqueueUncertainError);
    const res = await startDurableSpawns([INPUT, REQ2]);
    expect(res).toEqual({ enqueued: 2, total: 2 });
    expect(h.startWorkflow).toHaveBeenCalledTimes(3);
    expect((h.startWorkflow.mock.calls[0][1] as { workflowID: string }).workflowID).toBe(
      (h.startWorkflow.mock.calls[1][1] as { workflowID: string }).workflowID,
    );
  });

  // The parent DBOS workflow already owns this checkpointed request. A refusal
  // must not turn that parent into SUCCESS or close its dispatch as if finished.
  it('keeps a declined improvement dispatch available for workflow recovery', async () => {
    h.state.dbosOn = false; // any decline reason exercises the same branch
    const req = {
      url: 'http://x/api/harness/h/invoke?role=worker',
      body: { kickoff: 'go', improvementDispatch: { dispatchId: 'd-9', itemId: 'EI-10524', attempt: 3 } },
      idempotencyKey: 'implement:EI-10524:3',
      label: 'h/worker',
    };
    await expect(startDurableSpawns([req])).rejects.toThrow(/enqueue unavailable/);
    expect(h.markDispatchOrphaned).not.toHaveBeenCalled();
    expect(h.mergeIssuePayload).not.toHaveBeenCalled();
  });

  it('also retains a declined non-improvement one-shot request', async () => {
    h.state.dbosOn = false;
    await expect(startDurableSpawns([INPUT, REQ2])).rejects.toThrow(/enqueue unavailable/);
    expect(h.markDispatchOrphaned).not.toHaveBeenCalled();
    expect(h.mergeIssuePayload).not.toHaveBeenCalled();
  });
});

// EI-403 round-2: the durable path used to write NO spawned_agents row, so the
// implement worker ran invisibly to fleet:tree (round 1's fire-and-forget fallback
// DID record it, via WI-108). The workflow body now records/finishes the row when a
// caller opts in via `spawnRecord` — these guard that behaviour AND its opt-in shape
// (hive launches, which record their own rows, must NOT double-count → omit it).
describe('durableSpawnFireImpl — fleet:tree visibility (EI-403 round-2)', () => {
  const IMPL = {
    url: 'http://x/api/harness/h/invoke?role=worker',
    body: { kickoff: 'go' },
    idempotencyKey: 'implement:EI-9:2',
    label: 'h/worker',
  };

  it('records a spawned_agents row (stable id) then finishes it `done` when spawnRecord is set', async () => {
    await durableSpawnFireImpl({
      ...IMPL,
      spawnRecord: { workspaceId: 'ws', harnessSlug: 'h', childRole: 'worker', itemId: 'EI-9' },
    });
    expect(h.recordSpawn).toHaveBeenCalledTimes(1);
    const rec = h.recordSpawn.mock.calls[0][1];
    // Stable spawn_id = the durable workflow id → idempotent across retry/recovery.
    expect(rec.spawnId).toBe('durable-spawn:implement:EI-9:2');
    expect(rec.runId).toBe('implement:EI-9:2');
    expect(rec.childRole).toBe('worker');
    expect(rec.parentRole).toBe('operator'); // parentless system launch
    expect(rec.itemId).toBe('EI-9');
    expect(rec.status).toBe('running');
    // The fire still happened.
    expect(h.loopbackFetch).toHaveBeenCalledTimes(1);
    // Closed out `done`.
    expect(h.finishSpawn).toHaveBeenCalledTimes(1);
    const fin = h.finishSpawn.mock.calls[0][1];
    expect(fin.spawnId).toBe('durable-spawn:implement:EI-9:2');
    expect(fin.status).toBe('done');
  });

  it('skips before recording or invoking when the Claude gateway is wholesale-throttled', async () => {
    h.gatewayThrottled.value = true;
    await durableSpawnFireImpl({
      ...IMPL,
      spawnRecord: { workspaceId: 'ws', harnessSlug: 'h', childRole: 'worker', itemId: 'EI-9' },
    });
    expect(h.recordSpawn).not.toHaveBeenCalled();
    expect(h.loopbackFetch).not.toHaveBeenCalled();
    expect(h.finishSpawn).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('gateway wholesale-throttled'));
    expect(h.markDispatchOrphaned).not.toHaveBeenCalled(); // no improvementDispatch on this body
  });

  it('EI-9759: closes the dispatch-ledger row (and rolls back the attempt) when a gateway-throttle skip carries an improvementDispatch correlation', async () => {
    h.gatewayThrottled.value = true;
    await durableSpawnFireImpl({
      ...IMPL,
      body: { kickoff: 'go', improvementDispatch: { dispatchId: 'd-1', itemId: 'EI-9739', attempt: 1 } },
      spawnRecord: { workspaceId: 'ws', harnessSlug: 'h', childRole: 'worker', itemId: 'EI-9739' },
    });
    expect(h.markDispatchOrphaned).toHaveBeenCalledWith(
      'd-1',
      'pre-invoke-skip:gateway-wholesale-throttled',
      expect.stringContaining('attempt 1 not charged'),
    );
    expect(h.mergeIssuePayload).toHaveBeenCalledWith('EI-9739', { implementAttempts: 0 });
  });

  it('EI-9759: a markDispatchOrphaned no-op (already-terminal row) skips the attempt rollback', async () => {
    h.gatewayThrottled.value = true;
    h.markDispatchOrphaned.mockResolvedValue(false); // the worker actually resolved first — nothing to undo
    await durableSpawnFireImpl({
      ...IMPL,
      body: { kickoff: 'go', improvementDispatch: { dispatchId: 'd-1', itemId: 'EI-9739', attempt: 1 } },
      spawnRecord: { workspaceId: 'ws', harnessSlug: 'h', childRole: 'worker', itemId: 'EI-9739' },
    });
    expect(h.markDispatchOrphaned).toHaveBeenCalledTimes(1);
    expect(h.mergeIssuePayload).not.toHaveBeenCalled();
  });

  it('lets the gateway dispatch gate flag disable the pre-invoke skip', async () => {
    h.gatewayThrottled.value = true;
    h.getFlag.mockResolvedValue(false);
    await durableSpawnFireImpl({
      ...IMPL,
      spawnRecord: { workspaceId: 'ws', harnessSlug: 'h', childRole: 'worker', itemId: 'EI-9' },
    });
    expect(h.recordSpawn).toHaveBeenCalledTimes(1);
    expect(h.loopbackFetch).toHaveBeenCalledTimes(1);
    expect(h.finishSpawn).toHaveBeenCalledTimes(1);
  });

  it('EI-8177: skips before recording or invoking when the target harness no longer exists', async () => {
    h.resolveProject.mockResolvedValue(null); // torn down before this queued fire executed
    await durableSpawnFireImpl({
      ...IMPL,
      spawnRecord: { workspaceId: 'ws', harnessSlug: 'h', childRole: 'worker', itemId: 'EI-9' },
    });
    expect(h.recordSpawn).not.toHaveBeenCalled();
    expect(h.loopbackFetch).not.toHaveBeenCalled();
    expect(h.finishSpawn).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no longer exists'));
  });

  it('EI-9759: a gone-target skip also closes an improvementDispatch-correlated dispatch row', async () => {
    h.resolveProject.mockResolvedValue(null);
    await durableSpawnFireImpl({
      ...IMPL,
      body: { kickoff: 'go', improvementDispatch: { dispatchId: 'd-2', itemId: 'EI-1', attempt: 2 } },
      spawnRecord: { workspaceId: 'ws', harnessSlug: 'h', childRole: 'worker', itemId: 'EI-1' },
    });
    expect(h.markDispatchOrphaned).toHaveBeenCalledWith(
      'd-2',
      'pre-invoke-skip:gone-target',
      expect.stringContaining('attempt 2 not charged'),
    );
    expect(h.mergeIssuePayload).toHaveBeenCalledWith('EI-1', { implementAttempts: 1 });
  });

  it('EI-8177: fires normally (fail-open) when the gone-target probe itself errors', async () => {
    h.resolveProject.mockRejectedValue(new Error('registry unreadable'));
    await durableSpawnFireImpl({
      ...IMPL,
      spawnRecord: { workspaceId: 'ws', harnessSlug: 'h', childRole: 'worker', itemId: 'EI-9' },
    });
    expect(h.loopbackFetch).toHaveBeenCalledTimes(1);
    expect(h.finishSpawn).toHaveBeenCalledTimes(1);
  });

  it('WI-3682: escalates and clears the Mug started bit after three consecutive gone-target skips', async () => {
    h.resolveProject.mockResolvedValue(null);
    const input = {
      ...IMPL,
      url: 'http://x/api/harness/gone-hive/invoke?role=mug&ws=ws',
      spawnRecord: { workspaceId: 'ws', harnessSlug: 'gone-hive', childRole: 'mug' },
    };

    await durableSpawnFireImpl({ ...input, idempotencyKey: 'gone-mug-1' });
    await durableSpawnFireImpl({ ...input, idempotencyKey: 'gone-mug-2' });
    expect(h.setPotStarted).not.toHaveBeenCalled();
    await durableSpawnFireImpl({ ...input, idempotencyKey: 'gone-mug-3' });

    expect(h.setPotStarted).toHaveBeenCalledWith('ws', 'gone-hive', false);
    expect(h.wakeRecipients).toHaveBeenCalledWith(['owner-1'], expect.objectContaining({
      source: 'durable-spawn:gone-target',
      workspaceId: 'ws',
    }));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('auto-cleared'));

    // The negative marker makes the detector idempotent while already cleared;
    // queued replays must not wake/escalate the owner on every cycle.
    await durableSpawnFireImpl({ ...input, idempotencyKey: 'gone-mug-4' });
    expect(h.setPotStarted).toHaveBeenCalledTimes(1);
    expect(h.wakeRecipients).toHaveBeenCalledTimes(1);
  });

  it('WI-3682: maps the Kettle control role to the Overwatch started bit', async () => {
    h.resolveProject.mockResolvedValue(null);
    const input = {
      ...IMPL,
      url: 'http://x/api/harness/gone-hive/invoke?role=kettle&ws=ws',
      spawnRecord: { workspaceId: 'ws', harnessSlug: 'gone-hive', childRole: 'kettle' },
    };
    await durableSpawnFireImpl({ ...input, idempotencyKey: 'gone-kettle-1' });
    await durableSpawnFireImpl({ ...input, idempotencyKey: 'gone-kettle-2' });
    await durableSpawnFireImpl({ ...input, idempotencyKey: 'gone-kettle-3' });
    expect(h.setOverwatchStarted).toHaveBeenCalledWith('ws', 'gone-hive', false);
    expect(h.setPotStarted).not.toHaveBeenCalled();
  });

  it('WI-3682: an existing target resets a prior gone-target streak before firing', async () => {
    h.goneTargetSkipValue.value = '2';
    const input = {
      ...IMPL,
      url: 'http://x/api/harness/hive/invoke?role=mug&ws=ws',
      spawnRecord: { workspaceId: 'ws', harnessSlug: 'hive', childRole: 'mug' },
    };
    await durableSpawnFireImpl(input);
    expect(h.goneTargetSkipValue.value).toBeNull();
    expect(h.loopbackFetch).toHaveBeenCalledTimes(1);
  });

  it('does not pre-gate Codex/OpenAI control-plane spawns on a Claude gateway throttle', async () => {
    h.gatewayThrottled.value = true;
    await durableSpawnFireImpl({
      ...IMPL,
      body: { kickoff: 'go', spawnModel: 'chatgpt:5.5' },
      spawnRecord: { workspaceId: 'ws', harnessSlug: 'h', childRole: 'worker', itemId: 'EI-9' },
    });
    expect(h.recordSpawn).toHaveBeenCalledTimes(1);
    expect(h.loopbackFetch).toHaveBeenCalledTimes(1);
    expect(h.finishSpawn).toHaveBeenCalledTimes(1);
  });

  it('heartbeats a visible durable spawn row while /invoke is still pending', async () => {
    vi.useFakeTimers();
    let resolveFetch: ((value: { ok: boolean; status: number }) => void) | undefined;
    h.loopbackFetch.mockImplementation(async () => new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    try {
      const pending = durableSpawnFireImpl({
        ...IMPL,
        spawnRecord: { workspaceId: 'ws', harnessSlug: 'h', childRole: 'mug' },
      });
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(1000);
      expect(h.heartbeatSpawns).toHaveBeenCalledWith(h.sql, ['durable-spawn:implement:EI-9:2']);

      resolveFetch!({ ok: true, status: 200 });
      await pending;
      expect(h.finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        spawnId: 'durable-spawn:implement:EI-9:2',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires /invoke through the long-running launch loopback dispatcher', async () => {
    await durableSpawnFireImpl(IMPL);
    expect(h.loopbackFetch).toHaveBeenCalledTimes(1);
    const call = h.loopbackFetch.mock.calls[0] as unknown[];
    expect(call[2]).toEqual({ launch: true });
  });

  it('refreshes a stale Mug durable body from current owner steering before every /invoke POST', async () => {
    h.ownerSteering.value = {
      modelTiers: [
        { name: 'quick', spec: 'haiku' },
        { name: 'standard', spec: 'sonnet' },
        { name: 'queen-codex', spec: 'gpt-5.5', backend: 'codex' },
      ],
      tierCeilings: { mug: 'queen-codex' },
      modelOverrides: null,
    };
    await durableSpawnFireImpl({
      url: 'http://x/api/harness/papercusp/invoke?role=mug&ws=papercusp-workspace',
      body: { kickoff: 'old persisted body' },
      idempotencyKey: 'q-stale',
      label: 'papercusp/queen',
      spawnRecord: { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', childRole: 'mug' },
    });
    const req = h.loopbackFetch.mock.calls[0]![1] as unknown as { body: string };
    expect(JSON.parse(req.body).spawnModel).toBe('gpt-5.5');
  });

  it('records the refreshed Mug spawnModel on the durable spawn row before firing', async () => {
    h.ownerSteering.value = {
      modelTiers: [
        { name: 'quick', spec: 'chatgpt:5.5', backend: 'codex' },
        { name: 'standard', spec: 'chatgpt:5.5', backend: 'codex' },
      ],
      tierCeilings: { mug: 'quick' },
      modelOverrides: null,
    };
    await durableSpawnFireImpl({
      url: 'http://x/api/harness/papercusp/invoke?role=mug&ws=papercusp-workspace',
      body: { kickoff: 'owner-directed wake' },
      idempotencyKey: 'q-model-row',
      label: 'papercusp/queen',
      spawnRecord: { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', childRole: 'mug' },
    });
    expect(h.recordSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: 'durable-spawn:q-model-row',
      modelSpec: 'chatgpt:5.5',
    }));
  });

  it('skips a duplicate Queen launch when another Queen is already active in the workspace', async () => {
    h.activeQueenRows.value = [{ spawn_id: 'durable-spawn:q-live', harness_slug: 'papercusp' }];
    await durableSpawnFireImpl({
      url: 'http://x/api/harness/papercusp/invoke?role=mug&ws=papercusp-workspace',
      body: { kickoff: 'overlapping wake' },
      idempotencyKey: 'q-overlap',
      label: 'papercusp/queen',
      spawnRecord: { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', childRole: 'mug' },
    });

    expect(h.recordSpawn).not.toHaveBeenCalled();
    expect(h.loopbackFetch).not.toHaveBeenCalled();
    expect(h.finishSpawn).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('skipped duplicate Mug launch'));
  });

  it('retires DBOS-terminal Mug rows before checking the Queen singleton', async () => {
    await durableSpawnFireImpl({
      url: 'http://x/api/harness/papercusp/invoke?role=mug&ws=papercusp-workspace',
      body: { kickoff: 'wake after stale singleton' },
      idempotencyKey: 'q-after-cancelled-row',
      label: 'papercusp/queen',
      spawnRecord: { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', childRole: 'mug' },
    });

    const sqlTexts = h.sql.mock.calls.map((args) => {
      const strings = args[0] as TemplateStringsArray | string | undefined;
      return Array.isArray(strings) ? strings.join(' ') : String(strings);
    });
    expect(sqlTexts.some((text) =>
      text.includes('UPDATE harness_shared.spawned_agents AS a') &&
      text.includes('FROM dbos.workflow_status AS w') &&
      text.includes('MAX_RECOVERY_ATTEMPTS_EXCEEDED'),
    )).toBe(true);
    expect(h.recordSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: 'durable-spawn:q-after-cancelled-row',
      childRole: 'mug',
    }));
    expect(h.loopbackFetch).toHaveBeenCalledTimes(1);
  });

  it('refreshes a stale Kettle durable body from current modelOverrides before every /invoke POST', async () => {
    h.ownerSteering.value = { modelOverrides: { kettle: 'gpt-5.5:high' } };
    await durableSpawnFireImpl({
      url: 'http://x/api/harness/papercusp/invoke?role=kettle&ws=papercusp-workspace',
      body: { kickoff: 'old persisted body' },
      idempotencyKey: 'ow-stale',
      label: 'papercusp/overwatch',
    });
    const req = h.loopbackFetch.mock.calls[0]![1] as unknown as { body: string };
    expect(JSON.parse(req.body).spawnModel).toBe('gpt-5.5:high');
  });

  it('does not override an explicit caller-provided spawnModel in a durable body', async () => {
    h.ownerSteering.value = { modelOverrides: { kettle: 'gpt-5.5:high' } };
    await durableSpawnFireImpl({
      url: 'http://x/api/harness/papercusp/invoke?role=kettle&ws=papercusp-workspace',
      body: { kickoff: 'explicit pin', spawnModel: 'sonnet' },
      idempotencyKey: 'ow-explicit',
      label: 'papercusp/overwatch',
    });
    const req = h.loopbackFetch.mock.calls[0]![1] as unknown as { body: string };
    expect(JSON.parse(req.body).spawnModel).toBe('sonnet');
  });

  it('does NOT record when spawnRecord is omitted (hive launches own their rows)', async () => {
    await durableSpawnFireImpl(IMPL);
    expect(h.recordSpawn).not.toHaveBeenCalled();
    expect(h.finishSpawn).not.toHaveBeenCalled();
    expect(h.loopbackFetch).toHaveBeenCalledTimes(1);
  });

  it('marks the spawn `failed` (and rethrows) when the fire exhausts retries', async () => {
    h.loopbackFetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(
      durableSpawnFireImpl({ ...IMPL, spawnRecord: { workspaceId: 'ws', childRole: 'worker' } }),
    ).rejects.toThrow(/HTTP 503/);
    expect(h.recordSpawn).toHaveBeenCalledTimes(1);
    expect(h.finishSpawn).toHaveBeenCalledTimes(1);
    expect(h.finishSpawn.mock.calls[0][1].status).toBe('failed');
  });

  it('a recordSpawn failure never aborts the fire (best-effort bookkeeping)', async () => {
    h.recordSpawn.mockRejectedValueOnce(new Error('pg down'));
    await expect(
      durableSpawnFireImpl({ ...IMPL, spawnRecord: { workspaceId: 'ws', childRole: 'worker' } }),
    ).resolves.toBeUndefined();
    expect(h.loopbackFetch).toHaveBeenCalledTimes(1); // fired anyway
  });

  // D-007/D-010 fail-loud: HTTP 200 but the agent never produced a turn (host dead/unstable)
  // must be recorded `failed` (infra_loss marker), NOT silently `done`.
  const okBody = (b: Record<string, unknown>) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(b),
  });

  it('records `failed` + infra_loss when the fire returns 200 but the invoke body reports ok:false', async () => {
    h.loopbackFetch.mockResolvedValue(okBody({ ok: false, exitCode: 1, agentOutput: '', timedOut: false }));
    await expect(
      durableSpawnFireImpl({ ...IMPL, spawnRecord: { workspaceId: 'ws', childRole: 'mug' } }),
    ).resolves.toBeUndefined(); // infra_loss does NOT throw (no DBOS recovery storm)
    expect(h.loopbackFetch).toHaveBeenCalledTimes(1); // and does NOT retry the fire
    const fin = h.finishSpawn.mock.calls[0][1];
    expect(fin.status).toBe('failed');
    expect(String(fin.errorMessage)).toContain('infra_loss');
  });

  it('opens the durable release-fixer escalation when no turn is produced', async () => {
    h.loopbackFetch.mockResolvedValue(okBody({
      ok: false,
      exitCode: 143,
      agentOutput: '',
      timedOut: true,
      rawStdoutTail: '[08:16:17 invoke-once received termination signal — aborting agent',
    }));
    await durableSpawnFireImpl({
      url: 'http://x/api/harness/papercusp/invoke?role=release-fixer&ws=papercusp-workspace',
      body: {
        kickoff: 'gate red',
        releaseFixerContext: { candidate: 'deadbeefcafe0123', failingTests: ['lib/gate.test.ts'] },
      },
      idempotencyKey: 'release-fixer-no-turn',
      label: 'papercusp/release-fixer',
      spawnRecord: { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', childRole: 'release-fixer' },
    });
    const sqlTexts = h.sql.mock.calls.map((args) => {
      const strings = args[0] as TemplateStringsArray | string | undefined;
      return Array.isArray(strings) ? strings.join(' ') : String(strings);
    });
    expect(sqlTexts.some((text) => text.includes('INSERT INTO harness_shared.harness_escalations'))).toBe(true);
    expect(h.sql.mock.calls.some((args) => args.includes('green-checkpoint-release-fixer-no-turn'))).toBe(true);
    expect(h.finishSpawn.mock.calls[0]![1]).toMatchObject({ status: 'failed' });
  });

  it('records `failed` + capacity_shed (RETRYABLE → THROWS) when a clean mid-turn exit-1 coincides with a wholesale-throttled gateway (P-006)', async () => {
    h.getFlag.mockResolvedValue(false); // leave this test on the legacy post-invoke classifier path.
    h.gatewayThrottled.value = true; // the gateway pool was all-throttled at death
    h.loopbackFetch.mockResolvedValue(okBody({ ok: false, exitCode: 1, agentOutput: 'partial turn', timedOut: false, stderr: '' }));
    // capacity_shed THROWS so the step-retry re-fires through the paced gateway — NOT a terminal phantom host death.
    await expect(
      durableSpawnFireImpl({ ...IMPL, spawnRecord: { workspaceId: 'ws', childRole: 'mug' } }),
    ).rejects.toThrow(/capacity_shed/);
    const fin = h.finishSpawn.mock.calls[0][1];
    expect(fin.status).toBe('failed');
    expect(String(fin.errorMessage)).toContain('capacity_shed');
    expect(String(fin.errorMessage)).not.toContain('host dead');
  });

  it('does NOT label Codex/OpenAI model failures capacity_shed from a Claude gateway throttle', async () => {
    h.gatewayThrottled.value = true; // Claude pool is throttled, but this spawn is Codex-routed.
    h.loopbackFetch.mockResolvedValue(okBody({ ok: false, exitCode: 1, agentOutput: 'partial turn', timedOut: false, stderr: '' }));
    await expect(
      durableSpawnFireImpl({
        ...IMPL,
        body: { kickoff: 'go', spawnModel: 'chatgpt:5.5' },
        spawnRecord: { workspaceId: 'ws', childRole: 'mug' },
      }),
    ).resolves.toBeUndefined();
    const fin = h.finishSpawn.mock.calls[0][1];
    expect(fin.status).toBe('failed');
    expect(String(fin.errorMessage)).toContain('infra_loss');
    expect(String(fin.errorMessage)).not.toContain('capacity_shed');
  });

  it('persists auth_error for Codex/OpenAI credential rejection instead of generic infra_loss', async () => {
    h.loopbackFetch.mockResolvedValue(okBody({
      ok: false,
      exitCode: 1,
      agentOutput: '',
      timedOut: false,
      stderr: '',
      rawStdoutTail:
        'unexpected status 401 Unauthorized: Incorrect API key provided: sk-ant-a***. auth error code: invalid_api_key',
    }));
    await expect(
      durableSpawnFireImpl({
        ...IMPL,
        body: { kickoff: 'go', spawnModel: 'chatgpt:5.5' },
        spawnRecord: { workspaceId: 'ws', childRole: 'mug' },
      }),
    ).resolves.toBeUndefined();
    const fin = h.finishSpawn.mock.calls[0][1];
    expect(fin.status).toBe('failed');
    expect(String(fin.errorMessage)).toContain('auth_error');
    expect(String(fin.errorMessage)).not.toContain('infra_loss:');
  });

  it('uses PG-canonical run output to classify wrapper-only Codex usage-limit failures', async () => {
    h.pgRunOutputRows.value = [{
      diagnostic:
        '{"type":"error","message":"You have hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 7:54 AM."}',
    }];
    h.loopbackFetch.mockResolvedValue(okBody({
      ok: false,
      exitCode: 1,
      agentOutput: '',
      timedOut: false,
      stderr: '',
      rawStdoutTail:
        '[2026-06-25T09:29:56.452Z] invoke queen rc=1 (stdout: /home/dev/papercupai-workspace/papercup/.papercusp/logs/1782379790-queen.out)',
    }));
    await expect(
      durableSpawnFireImpl({
        ...IMPL,
        url: 'http://x/api/harness/papercusp/invoke?role=queen',
        body: { kickoff: 'go', spawnModel: 'chatgpt:5.5' },
        spawnRecord: { workspaceId: 'papercusp-workspace', childRole: 'mug' },
        label: 'papercusp/queen',
      }),
    ).resolves.toBeUndefined();
    const fin = h.finishSpawn.mock.calls[0][1];
    expect(h.sql).toHaveBeenCalled();
    expect(fin.status).toBe('failed');
    expect(String(fin.errorMessage)).toContain('usage_limit');
    expect(String(fin.errorMessage)).toContain('pgRunOutput:1782379790-queen');
    expect(String(fin.errorMessage)).not.toContain('infra_loss:');
  });

  it('feeds control-plane Codex usage-limit failures back into the account pool', async () => {
    h.selectSpawnAccount.mockResolvedValue('aviynw_codex');
    h.pgRunOutputRows.value = [{
      diagnostic:
        '{"type":"turn.failed","error":{"message":"Quota exceeded. Check your plan and billing details."}}',
    }];
    h.loopbackFetch.mockResolvedValue(okBody({
      ok: false,
      exitCode: 1,
      agentOutput: '',
      timedOut: false,
      stderr: '',
      rawStdoutTail:
        '[2026-06-25T21:45:18.129Z] invoke queen rc=1 (stdout: /home/dev/papercupai-workspace/papercup/.papercusp/logs/1782438318-queen.out)',
    }));

    await expect(
      durableSpawnFireImpl({
        ...IMPL,
        url: 'http://x/api/harness/papercusp/invoke?role=queen',
        body: { kickoff: 'owner-directed wake', spawnModel: 'chatgpt:5.5' },
        spawnRecord: { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', childRole: 'mug' },
        label: 'papercusp/queen',
      }),
    ).resolves.toBeUndefined();

    expect(h.selectSpawnAccount).toHaveBeenCalledWith(
      'papercusp-workspace',
      'papercusp',
      undefined,
      'codex',
    );
    expect(h.updateAccountPool).toHaveBeenCalledWith(expect.any(Function), 'papercusp-workspace');
    expect(h.recordAccountPenalty).toHaveBeenCalledWith(
      expect.anything(),
      'aviynw_codex',
      expect.any(Number),
      { pausedUntil: expect.any(Number) },
    );
    const now = Date.now();
    const opts = h.recordAccountPenalty.mock.calls[0]![3] as { pausedUntil: number };
    expect(opts.pausedUntil).toBeGreaterThan(now + 9 * 60_000);
    expect(opts.pausedUntil).toBeLessThanOrEqual(now + 10 * 60_000 + 5_000);
  });

  it('records `failed` + infra_loss (NOT capacity_shed) for a clean mid-turn exit-1 when the gateway is HEALTHY', async () => {
    h.gatewayThrottled.value = false; // gateway not throttled ⇒ a real host loss, terminal
    h.loopbackFetch.mockResolvedValue(okBody({ ok: false, exitCode: 1, agentOutput: 'partial turn', timedOut: false, stderr: '' }));
    await expect(
      durableSpawnFireImpl({ ...IMPL, spawnRecord: { workspaceId: 'ws', childRole: 'mug' } }),
    ).resolves.toBeUndefined(); // infra_loss does NOT throw
    expect(String(h.finishSpawn.mock.calls[0][1].errorMessage)).toContain('infra_loss');
  });

  it('records `failed` + infra_loss when 200 + ok:true but agentOutput is empty (0-token wake)', async () => {
    h.loopbackFetch.mockResolvedValue(okBody({ ok: true, exitCode: 0, agentOutput: '   ', timedOut: false }));
    await durableSpawnFireImpl({ ...IMPL, spawnRecord: { workspaceId: 'ws', childRole: 'mug' } });
    const fin = h.finishSpawn.mock.calls[0][1];
    expect(fin.status).toBe('failed');
    expect(String(fin.errorMessage)).toContain('infra_loss');
  });

  it('keeps `done` when the agent actually ran (ok:true + non-empty output) — no false positive', async () => {
    h.loopbackFetch.mockResolvedValue(okBody({ ok: true, exitCode: 0, agentOutput: 'DONE\nplaced 5 items', timedOut: false }));
    await durableSpawnFireImpl({ ...IMPL, spawnRecord: { workspaceId: 'ws', childRole: 'mug' } });
    expect(h.finishSpawn.mock.calls[0][1].status).toBe('done');
  });

  it('keeps `done` when the body is unparseable/unreadable (never flip on uncertainty)', async () => {
    h.loopbackFetch.mockResolvedValue({ ok: true, status: 200, text: async () => 'not json' });
    await durableSpawnFireImpl({ ...IMPL, spawnRecord: { workspaceId: 'ws', childRole: 'mug' } });
    expect(h.finishSpawn.mock.calls[0][1].status).toBe('done');
  });
});

// A deleted harness 404s its /invoke route forever. The fire used to treat any
// non-2xx as transient → 3 step-retries AND a workflow ERROR that DBOS recovery
// re-ran (maxRecoveryAttempts), amplifying one dead-harness spawn into perpetual
// `→ HTTP 404` log spam on green. A 404/410 (target gone) is now terminal-but-
// not-thrown: the step succeeds (no retry, no recovery) and the workflow ends.
describe('durableSpawnFireImpl — permanent (target-gone) vs transient fire failure', () => {
  const IMPL = {
    url: 'http://x/api/harness/deleted-harness/invoke?role=queen',
    body: { kickoff: 'go' },
    idempotencyKey: 'q1',
    label: 'deleted-harness/queen',
  };

  it.each([404, 410])(
    'a %i (spawn target gone) does NOT throw — so DBOS recovery is not triggered — and warns once',
    async (status) => {
      h.loopbackFetch.mockResolvedValue({ ok: false, status });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(durableSpawnFireImpl(IMPL)).resolves.toBeUndefined();
      expect(h.loopbackFetch).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`HTTP ${status} (permanent`));
    },
  );

  it('a permanent failure marks the fleet:tree row `failed` (not `done`) without throwing', async () => {
    h.loopbackFetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(
      durableSpawnFireImpl({ ...IMPL, spawnRecord: { workspaceId: 'ws', childRole: 'mug' } }),
    ).resolves.toBeUndefined();
    expect(h.finishSpawn).toHaveBeenCalledTimes(1);
    const fin = h.finishSpawn.mock.calls[0][1] as { status: string; errorMessage: string };
    expect(fin.status).toBe('failed');
    expect(String(fin.errorMessage)).toContain('permanent');
  });

  it.each([500, 502, 503, 429])(
    'a transient %i still THROWS (→ step-retry + DBOS recovery), unchanged',
    async (status) => {
      h.loopbackFetch.mockResolvedValue({ ok: false, status });
      await expect(durableSpawnFireImpl(IMPL)).rejects.toThrow(new RegExp(`HTTP ${status}`));
    },
  );

  it('captures the response body into the THROWN error for a transient failure (self-diagnosing)', async () => {
    h.loopbackFetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => '{"error":"gateway paused"}',
    });
    await expect(durableSpawnFireImpl(IMPL)).rejects.toThrow(
      /HTTP 503 — \{"error":"gateway paused"\}/,
    );
  });

  it('captures the response body into the permanent WARNING for a deterministic 4xx (self-diagnosing)', async () => {
    h.loopbackFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"unknown_workspace"}',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(durableSpawnFireImpl(IMPL)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 400 — {"error":"unknown_workspace"}'),
    );
  });
});

describe('isPermanentSpawnStatus (D1/WI-262 — deterministic 4xx are not retried)', () => {
  it('treats deterministic client/target errors as permanent (no retry storm)', () => {
    expect(isPermanentSpawnStatus(400)).toBe(true);  // unknown_workspace ("*") on durable replay
    expect(isPermanentSpawnStatus(404)).toBe(true);  // harness deleted
    expect(isPermanentSpawnStatus(410)).toBe(true);  // gone
    expect(isPermanentSpawnStatus(422)).toBe(true);  // unprocessable payload
  });
  it('keeps genuinely transient statuses retryable', () => {
    expect(isPermanentSpawnStatus(408)).toBe(false); // request timeout
    expect(isPermanentSpawnStatus(429)).toBe(false); // rate-limit / gateway pacing
    expect(isPermanentSpawnStatus(500)).toBe(false); // server error
    expect(isPermanentSpawnStatus(503)).toBe(false); // pacing pause / restart
  });
});
