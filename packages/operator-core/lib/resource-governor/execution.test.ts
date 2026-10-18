import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Governor } from './admission';
import { PgAdmissionCutoverQueueStore } from './admission-cutover-store';
import { WorkItemAdmissionQueueDriver, type DurableAdmissionQueueStore, type StoredAdmissionRecord } from './queue';
import { runGovernedTestProcess } from '../../../../scripts/lib/governed-test-process.mjs';
import {
  admissionContextFromEnvironment,
  beginGovernedExecution,
  governedExecutionLeaseTtlForTimeout,
  resetGovernedExecutionRuntimesForTests,
  runGovernedOperation,
  setGovernedProcessClientFactoryForTests,
  withGovernedExecution,
  withGovernedProcessRuntime,
  type GovernedProcessClient,
} from './execution';
import { AGENT_ADMISSION_GOVERNOR_BINDING } from './spawn-execution';

afterEach(() => {
  vi.restoreAllMocks();
});

function deps() {
  let record: any = null;
  const store: DurableAdmissionQueueStore = {
    async enqueue(next) {
      record = next;
      return { receiptId: 'WI-R1', record, created: true };
    },
    async find() {
      return record ? { receiptId: 'WI-R1', record } : null;
    },
    async cancel(_namespace, _key, reason, nowMs) {
      record = { ...record, state: 'cancelled', cancellationReason: reason, updatedAtMs: nowMs, lease: undefined };
      return { receiptId: 'WI-R1', record, changed: true };
    },
    async leaseNext() {
      return null;
    },
    async leaseReceipt(_namespace, receiptId, owner, leaseId, ttlMs, nowMs) {
      record = { ...record, state: 'leased', lease: { owner, leaseId, generation: 1, expiresAtMs: nowMs + ttlMs } };
      return { receiptId, record, changed: true };
    },
    async markRunning(receiptId) {
      record = { ...record, state: 'running' };
      return { receiptId, record, changed: true };
    },
    async complete() {
      return null;
    },
    async releaseLease() {
      return null;
    },
    async releaseClaim(receiptId, _leaseId, actualDemand, nowMs) {
      record = { ...record, state: 'completed', actualDemand, releasedAtMs: nowMs, lease: undefined };
      return { receiptId, record, changed: true };
    },
    async supersede() {
      return null;
    },
  };
  const driver = new WorkItemAdmissionQueueDriver(store, {
    namespace: 'agent-process',
    now: () => 1_000,
    leaseIdFactory: () => 'lease-1',
  });
  return {
    store,
    driver,
    governor: new Governor(driver, { now: () => 1_000, idFactory: () => 'request-1' }),
    current: () => record,
  };
}

describe('governed execution lifecycle', () => {
  it('derives a bounded short lease from a process timeout', () => {
    expect(governedExecutionLeaseTtlForTimeout(undefined)).toBe(5 * 60_000);
    expect(governedExecutionLeaseTtlForTimeout(1_000)).toBe(6_000);
    expect(governedExecutionLeaseTtlForTimeout(60 * 60_000)).toBe(30 * 60_000);
  });

  it('round-trips a propagated parent context and rejects malformed env input', async () => {
    const d = deps();
    const execution = await beginGovernedExecution(
      { idempotencyKey: 'parent', admissionClass: 'agent' },
      { owner: 'agent-launcher' },
      d,
    );
    expect(admissionContextFromEnvironment(JSON.stringify(execution.context))).toEqual(execution.context);
    expect(admissionContextFromEnvironment('{bad json')).toBeUndefined();
    expect(admissionContextFromEnvironment(JSON.stringify({ requestId: 'partial' }))).toBeUndefined();
  });

  it('persists, targets its own receipt, marks running, and releases exact actual demand', async () => {
    const d = deps();
    const execution = await beginGovernedExecution(
      { idempotencyKey: 'launch-1', admissionClass: 'agent', demand: { cpuWeight: 1, memoryBytes: 10 } },
      { owner: 'agent-launcher' },
      d,
    );
    expect(execution).toMatchObject({ receiptId: 'WI-R1', context: { receiptId: 'WI-R1', leaseId: 'lease-1' } });
    expect(d.current()).toMatchObject({ state: 'running', lease: { owner: 'agent-launcher' } });
    expect(await execution.finish({ cpuWeight: 2, memoryBytes: 12 })).toBe(true);
    expect(await execution.finish()).toBe(false);
    expect(d.current()).toMatchObject({ state: 'completed', actualDemand: { cpuWeight: 2, memoryBytes: 12 } });
  });

  it('cancels the visible durable receipt before process start failure returns', async () => {
    const d = deps();
    const execution = await beginGovernedExecution(
      { idempotencyKey: 'launch-2', admissionClass: 'agent' },
      { owner: 'agent-launcher' },
      d,
    );
    expect(await execution.cancel('spawn failed')).toBe(true);
    expect(d.current()).toMatchObject({ state: 'cancelled', cancellationReason: 'spawn failed' });
  });

  it('wraps a bounded subprocess lifecycle and releases it after the result', async () => {
    const d = deps();
    const result = await withGovernedExecution(
      { idempotencyKey: 'bounded-1', admissionClass: 'process', demand: { cpuWeight: 0.25 } },
      { owner: 'bounded-runner' },
      d,
      async (context) => ({ ok: true, parentRequestId: context.parentRequestId }),
    );
    expect(result).toEqual({ ok: true, parentRequestId: null });
    expect(d.current()).toMatchObject({ state: 'completed' });
  });

  it('cancels the durable receipt when a bounded subprocess throws', async () => {
    const d = deps();
    await expect(
      withGovernedExecution(
        { idempotencyKey: 'bounded-2', admissionClass: 'process' },
        { owner: 'bounded-runner' },
        d,
        async () => {
          throw new Error('spawn exploded');
        },
      ),
    ).rejects.toThrow('spawn exploded');
    expect(d.current()).toMatchObject({
      state: 'cancelled',
      cancellationReason: 'governed execution failed: spawn exploded',
    });
  });

  it('cancels and cleans up a queued receipt when targeted lease acquisition fails', async () => {
    const d = deps();
    vi.spyOn(d.driver, 'leaseReceipt').mockResolvedValue(null);

    await expect(
      beginGovernedExecution(
        { idempotencyKey: 'lease-miss', admissionClass: 'process' },
        { owner: 'bounded-runner', leaseTtlMs: 6_000 },
        d,
      ),
    ).rejects.toThrow("'WI-R1' is not leaseable");
    expect(d.current()).toMatchObject({ state: 'cancelled' });
  });

  it('cancels a queued receipt even when the lease driver throws', async () => {
    const d = deps();
    const error = Object.assign(new Error('lease store unavailable'), { pgCode: '57014' });
    vi.spyOn(d.driver, 'leaseReceipt').mockRejectedValue(error);

    await expect(
      beginGovernedExecution(
        { idempotencyKey: 'lease-throw', admissionClass: 'process' },
        { owner: 'bounded-runner', leaseTtlMs: 6_000 },
        d,
      ),
    ).rejects.toBe(error);
    expect(error).toMatchObject({
      pgCode: '57014',
      governedAdmissionStartFailure: {
        contractVersion: 1,
        idempotencyKey: 'lease-throw',
        receiptId: 'WI-R1',
        state: 'cancelled',
        cancellationVerified: true,
      },
    });
    expect(d.current()).toMatchObject({
      state: 'cancelled',
      cancellationReason: expect.stringContaining('lease acquisition'),
    });
  });

  it.each(['throws', 'unknown', 'completed', 'wrong-key'])(
    'does not confirm cancellation when cleanup %s',
    async (mode) => {
      const d = deps();
      const error = Object.assign(new Error('lease timeout'), { pgCode: '57014' });
      vi.spyOn(d.driver, 'leaseReceipt').mockRejectedValue(error);
      const cancel = vi.spyOn(d.governor, 'cancel');
      if (mode === 'throws') cancel.mockRejectedValue(new Error('cleanup unavailable'));
      else cancel.mockResolvedValue({
        idempotencyKey: mode === 'wrong-key' ? 'other' : 'unconfirmed',
        cancelled: false,
        state: mode === 'wrong-key' ? 'cancelled' : mode === 'completed' ? 'completed' : 'unknown',
      });
      await expect(beginGovernedExecution(
        { idempotencyKey: 'unconfirmed', admissionClass: 'process' },
        { owner: 'bounded-runner' },
        d,
      )).rejects.toBe(error);
      expect(error).toMatchObject({ governedAdmissionStartFailure: { cancellationVerified: false } });
    },
  );

  it('confirms an already-cancelled receipt without requiring a new transition', async () => {
    const d = deps();
    const error = Object.assign(new Error('lease timeout'), { pgCode: '57014' });
    vi.spyOn(d.driver, 'leaseReceipt').mockRejectedValue(error);
    vi.spyOn(d.governor, 'cancel').mockResolvedValue({
      idempotencyKey: 'already-cancelled', cancelled: false, state: 'cancelled',
    });
    await expect(beginGovernedExecution(
      { idempotencyKey: 'already-cancelled', admissionClass: 'process' },
      { owner: 'bounded-runner' }, d,
    )).rejects.toMatchObject({ governedAdmissionStartFailure: { cancellationVerified: true } });
  });

  it('preserves frozen pre-start errors as a retryable cause with cleanup evidence', async () => {
    const d = deps();
    const error = Object.freeze(Object.assign(new Error('frozen lease timeout'), { pgCode: '57014' }));
    vi.spyOn(d.driver, 'leaseReceipt').mockRejectedValue(error);
    await expect(beginGovernedExecution(
      { idempotencyKey: 'frozen-error', admissionClass: 'process' },
      { owner: 'bounded-runner' }, d,
    )).rejects.toMatchObject({
      cause: error,
      governedAdmissionStartFailure: { idempotencyKey: 'frozen-error', cancellationVerified: true },
    });
  });

  it('releases a partial lease and cancels when mark-running fails', async () => {
    const d = deps();
    vi.spyOn(d.driver, 'markRunning').mockResolvedValue(null);
    const releaseLease = vi.spyOn(d.driver, 'releaseLease');

    await expect(
      beginGovernedExecution(
        { idempotencyKey: 'mark-miss', admissionClass: 'process' },
        { owner: 'bounded-runner', leaseTtlMs: 6_000 },
        d,
      ),
    ).rejects.toThrow("'WI-R1' could not enter running state");
    expect(releaseLease).toHaveBeenCalledWith('WI-R1', 'lease-1');
    expect(d.current()).toMatchObject({ state: 'cancelled' });
  });

  it.each([
    ['owner-ended', undefined, false],
    ['leased', { leaseId: 'other-private-token', owner: 'replacement', generation: 2, expiresAtMs: 7_000 }, false],
  ] as const)('preserves %s refusal evidence before cancellation without exposing lease tokens', async (reason, lease, leaseMatches) => {
    const d = deps();
    vi.spyOn(d.driver, 'markRunning').mockImplementation(async receiptId => ({
      receiptId,
      changed: false,
      record: {
        ...d.current(), state: lease ? 'leased' : 'queued', lease,
        decision: { generation: 2, atMs: 1_000, reason, evidence: {} },
      },
    }));

    const error = await beginGovernedExecution(
      { idempotencyKey: 'observed-refusal', admissionClass: 'agent' },
      { owner: 'resumed-agent' }, d,
    ).then(() => { throw new Error('expected start refusal'); }, error => error);

    expect(error.governedAdmissionTransition).toEqual({
      state: lease ? 'leased' : 'queued', decision: reason, generation: 2,
      leasePresent: Boolean(lease), leaseMatches,
    });
    expect(error.message).toContain(`\"decision\":\"${reason}\"`);
    expect(error.message).not.toContain('other-private-token');
    expect(error.message).not.toContain('lease-1');
    expect(error.governedAdmissionStartFailure.cancellationVerified).toBe(true);
    expect(d.current()).toMatchObject({ state: 'cancelled' });
  });

  it('retries the real execution seam without re-leasing its cancelled receipt', async () => {
    // Preserve idempotent tombstones as the durable store does. A same-key
    // retry returns the cancelled row and cannot lease it, reproducing EI-25713586716473636.
    const rows = new Map<string, StoredAdmissionRecord>();
    const byReceipt = (id: string) => [...rows.values()].find((row) => row.receiptId === id);
    const update = (row: StoredAdmissionRecord, record: StoredAdmissionRecord['record']) => {
      const next = { ...row, record };
      rows.set(record.idempotencyKey, next);
      return { ...next, changed: true };
    };
    const store: DurableAdmissionQueueStore = {
      ...deps().store,
      async enqueue(record) {
        const existing = rows.get(record.idempotencyKey);
        if (existing) return { ...existing, created: false };
        const row = { receiptId: `receipt-${rows.size + 1}`, record };
        rows.set(record.idempotencyKey, row);
        return { ...row, created: true };
      },
      async find(_namespace, key) { return rows.get(key) ?? null; },
      async cancel(_namespace, key, reason, nowMs) {
        const row = rows.get(key);
        return row ? update(row, {
          ...row.record, state: 'cancelled', cancellationReason: reason, updatedAtMs: nowMs, lease: undefined,
        }) : null;
      },
      async leaseReceipt(_namespace, id, owner, leaseId, ttlMs, nowMs) {
        const row = byReceipt(id);
        if (!row || row.record.state !== 'queued') return null;
        return update(row, { ...row.record, state: 'leased', lease: {
          owner, leaseId, generation: 1, expiresAtMs: nowMs + ttlMs,
        } });
      },
      async markRunning(id) {
        const row = byReceipt(id);
        return row ? update(row, { ...row.record, state: 'running' }) : null;
      },
      async releaseClaim(id, _leaseId, actualDemand, nowMs) {
        const row = byReceipt(id);
        return row ? update(row, {
          ...row.record, state: 'completed', actualDemand, releasedAtMs: nowMs, lease: undefined,
        }) : null;
      },
    };
    const driver = new WorkItemAdmissionQueueDriver(store, { namespace: 'test-process' });
    const governor = new Governor(driver);
    const lease = vi.spyOn(driver, 'leaseReceipt').mockRejectedValueOnce(
      Object.assign(new Error('lease transaction timed out'), { pgCode: '57014' }),
    );
    const child = vi.fn(async () => 'one child result');
    const result = await runGovernedTestProcess({
      workspaceId: 'ws', owner: 'test-runner', env: {}, idempotencyKey: 'initial-key',
      sleep: async () => {}, log: () => {},
      executionApi: { runGovernedOperation: (input: Parameters<typeof runGovernedOperation>[0], run: any) =>
        withGovernedExecution({ ...input, idempotencyKey: input.idempotencyKey! },
          { owner: input.owner }, { governor, driver }, run) },
    }, child);
    expect(result).toBe('one child result');
    expect(child).toHaveBeenCalledTimes(1);
    expect(lease).toHaveBeenCalledTimes(2);
    expect(rows.get('initial-key')!.record.state).toBe('cancelled');
    expect([...rows.values()].map((row) => row.record.state)).toEqual(['cancelled', 'completed']);
    expect(lease.mock.calls.map(([input]) => input.receiptId)).toEqual(['receipt-1', 'receipt-2']);
  });

  it('serializes concurrent terminal callbacks and accepts measured demand', async () => {
    const d = deps();
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const release = vi.spyOn(d.governor, 'release').mockImplementation(async (_context, actualDemand) => {
      await gate;
      return { requestId: 'request-1', released: actualDemand?.memoryBytes === 42 };
    });
    const cancel = vi.spyOn(d.governor, 'cancel');
    const execution = await beginGovernedExecution(
      { idempotencyKey: 'serialized', admissionClass: 'process' },
      { owner: 'bounded-runner' },
      d,
    );

    const first = execution.finish({ cpuWeight: 0.5, memoryBytes: 42 });
    const second = execution.cancel('late abort');
    expect(release).toHaveBeenCalledOnce();
    await expect(second).resolves.toBe(false);
    unblock();
    await expect(first).resolves.toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    await expect(execution.finish()).resolves.toBe(false);
  });

  it('cancels the durable receipt when the caller aborts before the operation settles', async () => {
    const d = deps();
    const controller = new AbortController();
    let resolveRun!: (value: string) => void;
    const run = withGovernedExecution(
      { idempotencyKey: 'aborted-caller', admissionClass: 'process' },
      { owner: 'bounded-runner', signal: controller.signal },
      d,
      async () =>
        new Promise<string>((resolve) => {
          resolveRun = resolve;
        }),
    );

    await vi.waitFor(() => expect(d.current()).toMatchObject({ state: 'running' }));
    controller.abort(new Error('client closed'));
    await vi.waitFor(() =>
      expect(d.current()).toMatchObject({
        state: 'cancelled',
        cancellationReason: 'governed execution aborted: client closed',
      }),
    );

    // The underlying operation may not understand AbortSignal. Its eventual
    // settle must still preserve the caller's abort outcome and never release
    // the receipt back into a completed state.
    resolveRun('late result');
    await expect(run).rejects.toThrow('client closed');
    expect(d.current()).toMatchObject({ state: 'cancelled' });
  });

  it('does not create a durable receipt for an already-aborted caller', async () => {
    const d = deps();
    const controller = new AbortController();
    controller.abort(new Error('request already gone'));

    await expect(
      withGovernedExecution(
        { idempotencyKey: 'pre-aborted-caller', admissionClass: 'process' },
        { owner: 'bounded-runner', signal: controller.signal },
        d,
        async () => 'unreachable',
      ),
    ).rejects.toThrow('request already gone');
    expect(d.current()).toBeNull();
  });

  it('uses a settlement policy to cancel undetermined outcomes and release measured outcomes', async () => {
    const d = deps();
    const cancelled = await withGovernedExecution(
      { idempotencyKey: 'policy-cancel', admissionClass: 'process' },
      {
        owner: 'bounded-runner',
        settle: () => ({ kind: 'cancel' as const, reason: 'timeout' }),
      },
      d,
      async () => 'undetermined',
    );
    expect(cancelled).toBe('undetermined');
    expect(d.current()).toMatchObject({ state: 'cancelled', cancellationReason: 'timeout' });

    const released = await withGovernedExecution(
      { idempotencyKey: 'policy-release', admissionClass: 'process' },
      {
        owner: 'bounded-runner',
        measureActualDemand: () => ({ cpuWeight: 0.25, diskBytes: 99 }),
      },
      d,
      async () => 'passed',
    );
    expect(released).toBe('passed');
    expect(d.current()).toMatchObject({ state: 'completed', actualDemand: { cpuWeight: 0.25, diskBytes: 99 } });
  });

  it('fails closed when a driver returns non-durable compatibility admission', async () => {
    const driver = { admit: vi.fn(async (_request: any, context: any) => ({ kind: 'admitted' as const, context })) };
    await expect(
      beginGovernedExecution(
        { idempotencyKey: 'launch-3', admissionClass: 'agent' },
        { owner: 'agent-launcher' },
        { governor: new Governor(driver), driver: {} as WorkItemAdmissionQueueDriver },
      ),
    ).rejects.toThrow(/requires a durable queued receipt/);
  });

  // goal-brief D-031: placement readers treat an unpublished agent-class admission state
  // as open only while the agent door declares the governor observe-only. That claim is
  // this behavior — admit, then lease our OWN receipt in the same call, never waiting on a
  // controller's lease selection. A door that starts waiting fails here until the
  // declaration in spawn-execution.ts moves to 'binding' with it.
  it('leases an agent receipt without a controller while the agent door is observe-only', async () => {
    const d = deps();
    const leaseNext = vi.spyOn(d.store, 'leaseNext');
    const leaseReceipt = vi.spyOn(d.store, 'leaseReceipt');
    const execution = await beginGovernedExecution(
      { idempotencyKey: 'launch-4', admissionClass: 'agent' },
      { owner: 'agent-launcher' },
      d,
    );
    if (AGENT_ADMISSION_GOVERNOR_BINDING === 'observe-only') {
      expect(leaseNext).not.toHaveBeenCalled();
      expect(leaseReceipt).toHaveBeenCalledOnce();
      expect(leaseReceipt.mock.calls[0]![1]).toBe(execution.receiptId);
      expect(d.current()).toMatchObject({ state: 'running', lease: { owner: 'agent-launcher' } });
    } else {
      expect(leaseReceipt).not.toHaveBeenCalled();
    }
  });
});

/**
 * WI-638180 — the dedicated-client LIFETIME.
 *
 * A top-level governed admission used to run on `getOrgPg()`, a process-wide
 * singleton no library may close. The one-shot test-runner CLIs therefore
 * finished every unit of work and then hung forever on two idle PgBouncer
 * sockets — which reads to a supervisor exactly like a wedged test run
 * (`pc-heavy` reporting exit 75), not like a completed one.
 *
 * These pin the replacement contract: a process-scoped operation gets its OWN
 * client, and that client is closed when the LAST in-flight operation settles —
 * not per-operation, and not never. The falsifier is stated with each case:
 * every assertion below fails against the pre-fix behaviour (a client that is
 * never ended) or against an obvious wrong repair (ending it under a running
 * sibling, or handing the next operation an already-closed pool).
 */
describe('governed process client lifetime (WI-638180)', () => {
  interface FakeClient extends GovernedProcessClient {
    ends: number;
  }

  let built: FakeClient[] = [];

  function fakeClient(endImpl?: (client: FakeClient) => Promise<void>): FakeClient {
    // A query would mean the test is exercising the store, not the lifetime.
    const sql = (() => {
      throw new Error('lifetime tests must never issue a query');
    }) as unknown as GovernedProcessClient['sql'];
    const client: FakeClient = {
      sql,
      ends: 0,
      async end() {
        client.ends += 1;
        if (endImpl) await endImpl(client);
      },
    };
    built.push(client);
    return client;
  }

  beforeEach(() => {
    built = [];
    resetGovernedExecutionRuntimesForTests();
    setGovernedProcessClientFactoryForTests(() => fakeClient());
  });

  afterEach(() => {
    setGovernedProcessClientFactoryForTests(null);
    resetGovernedExecutionRuntimesForTests();
  });

  it('closes the dedicated client once the operation settles', async () => {
    // Falsifier: the pre-fix seam closed nothing, so `ends` stayed 0 here and
    // the CLI's event loop stayed non-empty forever.
    const deps = await withGovernedProcessRuntime('ws-1', 'ns-1', async (d) => {
      expect(built).toHaveLength(1);
      expect(built[0]!.ends).toBe(0);
      return d;
    });
    expect(deps.driver).toBeInstanceOf(WorkItemAdmissionQueueDriver);
    expect(built[0]!.ends).toBe(1);
  });

  it('binds the runtime store to the dedicated client, never the shared pool', async () => {
    // Reaching through the driver is deliberate: WHICH client the store queries
    // is the property that matters and nothing else observes it. Were this ever
    // repointed at the `getOrgPg()` singleton, the close above would become a
    // process-wide database outage instead of a local teardown.
    await withGovernedProcessRuntime('ws-1', 'ns-1', async (deps) => {
      const store = (deps.driver as unknown as { store: { sql: unknown } }).store;
      expect(store).toBeInstanceOf(PgAdmissionCutoverQueueStore);
      expect(store.sql).toBe(built[0]!.sql);
    });
  });

  it('keeps ONE client open across overlapping operations and closes it once', async () => {
    // Falsifier: a naive per-operation close ends the pool underneath a sibling
    // that is still running — that reports ends=2 here, and CONNECTION_ENDED in
    // production, where the runners admit several groups concurrently.
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const first = withGovernedProcessRuntime('ws-1', 'ns-1', async () => {
      markStarted();
      await new Promise<void>((done) => {
        releaseFirst = done;
      });
    });
    await started;

    await withGovernedProcessRuntime('ws-1', 'ns-2', async () => {
      expect(built).toHaveLength(1);
      expect(built[0]!.ends).toBe(0);
    });
    expect(built[0]!.ends).toBe(0);

    releaseFirst();
    await first;
    expect(built).toHaveLength(1);
    expect(built[0]!.ends).toBe(1);
  });

  it('builds a FRESH client for an operation that starts after the close', async () => {
    // Falsifier: keeping the cached runtime across a close hands the next
    // operation a store bound to an ended pool — a "fix" that swaps the hang
    // for a hard failure on the second test group.
    await withGovernedProcessRuntime('ws-1', 'ns-1', async () => undefined);
    await withGovernedProcessRuntime('ws-1', 'ns-1', async () => undefined);
    expect(built).toHaveLength(2);
    expect(built.map((client) => client.ends)).toEqual([1, 1]);
    expect(built[0]!.sql).not.toBe(built[1]!.sql);
  });

  it('closes the client when the operation THROWS, and preserves the error', async () => {
    // Falsifier: closing only on the success path leaves a FAILED run hung —
    // the worst shape of this bug, because the runner already has bad news and
    // now cannot exit to deliver it.
    await expect(
      withGovernedProcessRuntime('ws-1', 'ns-1', async () => {
        throw new Error('operation exploded');
      }),
    ).rejects.toThrow(/operation exploded/);
    expect(built[0]!.ends).toBe(1);
  });

  it('does not let a close failure replace the operation result', async () => {
    setGovernedProcessClientFactoryForTests(() =>
      fakeClient(async () => {
        throw new Error('pool teardown failed');
      }),
    );
    await expect(withGovernedProcessRuntime('ws-1', 'ns-1', async () => 'real result')).resolves.toBe('real result');
    expect(built[0]!.ends).toBe(1);
  });

  it('routes runGovernedOperation onto the dedicated client when asked', async () => {
    // The `dedicatedClient` flag is the only thing selecting this path, so the
    // wiring is proven rather than assumed: admission fails on the throwing
    // fake `sql`, and the dedicated client must still be built AND closed.
    await expect(
      runGovernedOperation(
        {
          workspaceId: 'ws-1',
          namespace: 'ns-1',
          owner: 'lifetime-test',
          admissionClass: 'process',
          dedicatedClient: true,
        },
        async () => 'unreachable',
      ),
    ).rejects.toThrow();
    expect(built).toHaveLength(1);
    expect(built[0]!.ends).toBe(1);
  });
});
