import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdmissionIdempotencyConflictError,
  AdmissionPersistenceError,
  Governor,
  admissionRequestFingerprint,
  normalizeAdmissionRequest,
  type AdmissionContext,
} from './admission';
import {
  EndedLeaseOwnerScanCoalescer,
  PgWorkItemAdmissionQueueStore,
  RESOURCE_GOVERNOR_LIVENESS_READ_DEADLINE_MS,
  WorkItemAdmissionQueueDriver,
  mapGovernorQueuePopulationRows,
  mapQueueLeaseOwnerRows,
  selectEndedLeaseOwners,
  type DurableAdmissionQueueStore,
  type DurableAdmissionRecord,
  type QueueLeaseOwnerObservation,
  type QueueMutationResult,
  type QueueReconciliationResult,
  type StoredAdmissionRecord,
} from './queue';
import { PgAdmissionLedgerQueueStore } from './admission-ledger-store';
import { MemoryAdmissionQueueStore } from './memory-admission-queue-store';

class MemoryQueueStore implements DurableAdmissionQueueStore {
  private seq = 0;
  private readonly rows = new Map<string, StoredAdmissionRecord>();
  failEnqueue = false;
  /** Optional concrete fault to throw instead of the generic one, so tests can inject a pg-shaped error. */
  enqueueError: unknown;
  /** EI-21863356544930781: fail the next N enqueues, then succeed — a TRANSIENT fault, so a test
   *  can tell "rode out the dip and persisted" apart from "never failed in the first place". */
  failEnqueueTimes = 0;
  /** Every enqueue attempt, so a test can assert a non-retryable fault was tried exactly ONCE. */
  enqueueAttempts = 0;
  /** EI-22697720752476196: fail the next N terminal release transitions with a transient
   *  contention error, then succeed — reproduces the PG row-lock failure seen in cleanup. */
  failReleaseClaimTimes = 0;
  releaseClaimError: unknown;
  /** Every release attempt, so the retry and non-retry paths are both observable. */
  releaseClaimAttempts = 0;

  get size(): number {
    return this.rows.size;
  }

  private key(namespace: string, idempotencyKey: string): string {
    return `${namespace}\u0000${idempotencyKey}`;
  }

  private byReceipt(receiptId: string): StoredAdmissionRecord | null {
    return [...this.rows.values()].find((row) => row.receiptId === receiptId) ?? null;
  }

  private replace(stored: StoredAdmissionRecord, record: DurableAdmissionRecord): StoredAdmissionRecord {
    const next = { receiptId: stored.receiptId, record };
    this.rows.set(this.key(record.namespace, record.idempotencyKey), next);
    return next;
  }

  async enqueue(record: DurableAdmissionRecord) {
    this.enqueueAttempts += 1;
    if (this.failEnqueueTimes > 0) {
      this.failEnqueueTimes -= 1;
      throw this.enqueueError ?? new Error('database unavailable');
    }
    if (this.failEnqueue) throw this.enqueueError ?? new Error('database unavailable');
    const key = this.key(record.namespace, record.idempotencyKey);
    const existing = this.rows.get(key);
    if (existing) return { ...existing, created: false };
    if (record.coalesceKey) {
      for (const row of this.rows.values()) {
        if (
          row.record.namespace === record.namespace &&
          row.record.coalesceKey === record.coalesceKey &&
          ['queued', 'eligible', 'leased', 'running'].includes(row.record.state)
        ) {
          this.replace(row, {
            ...row.record,
            state: 'superseded',
            updatedAtMs: record.enqueuedAtMs,
            decision: {
              generation: row.record.decision.generation + 1,
              atMs: record.enqueuedAtMs,
              reason: 'coalesced-by-newer-request',
              evidence: { idempotencyKey: record.idempotencyKey },
            },
            lease: undefined,
          });
        }
      }
    }
    const stored = { receiptId: `WI-${++this.seq}`, record };
    this.rows.set(key, stored);
    return { ...stored, created: true };
  }

  async find(namespace: string, idempotencyKey: string) {
    return this.rows.get(this.key(namespace, idempotencyKey)) ?? null;
  }

  async cancel(namespace: string, idempotencyKey: string, reason: string | undefined, nowMs: number) {
    const stored = await this.find(namespace, idempotencyKey);
    if (!stored) return null;
    if (!['queued', 'eligible', 'leased', 'running'].includes(stored.record.state)) {
      return { ...stored, changed: false };
    }
    const next = this.replace(stored, {
      ...stored.record,
      state: 'cancelled',
      updatedAtMs: nowMs,
      decision: {
        generation: stored.record.decision.generation + 1,
        atMs: nowMs,
        reason: 'cancelled',
        evidence: reason ? { reason } : {},
      },
      lease: undefined,
      ...(reason ? { cancellationReason: reason } : {}),
    });
    return { ...next, changed: true };
  }

  async leaseNext(namespace: string, owner: string, leaseId: string, ttlMs: number, nowMs: number) {
    const stored = [...this.rows.values()]
      .filter((row) => row.record.namespace === namespace && ['queued', 'eligible'].includes(row.record.state))
      .sort((a, b) => b.record.priority - a.record.priority || a.record.enqueuedAtMs - b.record.enqueuedAtMs)[0];
    if (!stored) return null;
    const generation = stored.record.decision.generation + 1;
    const next = this.replace(stored, {
      ...stored.record,
      state: 'leased',
      updatedAtMs: nowMs,
      decision: { generation, atMs: nowMs, reason: 'leased', evidence: { owner } },
      lease: { leaseId, owner, generation, expiresAtMs: nowMs + ttlMs },
    });
    return { ...next, changed: true };
  }

  /** Target one already-persisted receipt during observe-only migration.
   *  Mirrors leaseNext, but selects by receiptId instead of queue order. */
  async leaseReceipt(
    namespace: string,
    receiptId: string,
    owner: string,
    leaseId: string,
    ttlMs: number,
    nowMs: number,
  ) {
    const stored = this.byReceipt(receiptId);
    if (!stored || stored.record.namespace !== namespace) return null;
    if (!['queued', 'eligible'].includes(stored.record.state)) return { ...stored, changed: false };
    const generation = stored.record.decision.generation + 1;
    const next = this.replace(stored, {
      ...stored.record,
      state: 'leased',
      updatedAtMs: nowMs,
      decision: { generation, atMs: nowMs, reason: 'leased', evidence: { owner } },
      lease: { leaseId, owner, generation, expiresAtMs: nowMs + ttlMs },
    });
    return { ...next, changed: true };
  }

  private leaseMutation(
    receiptId: string,
    leaseId: string,
    mutate: (record: DurableAdmissionRecord) => DurableAdmissionRecord,
  ): QueueMutationResult | null {
    const stored = this.byReceipt(receiptId);
    if (!stored) return null;
    if (stored.record.lease?.leaseId !== leaseId) return { ...stored, changed: false };
    return { ...this.replace(stored, mutate(stored.record)), changed: true };
  }

  async markRunning(receiptId: string, leaseId: string, nowMs: number) {
    return this.leaseMutation(receiptId, leaseId, (record) => ({
      ...record,
      state: 'running',
      updatedAtMs: nowMs,
      decision: {
        generation: record.decision.generation + 1,
        atMs: nowMs,
        reason: 'execution-started',
        evidence: {},
      },
    }));
  }

  async complete(receiptId: string, leaseId: string, resultRef: string | undefined, nowMs: number) {
    const evidence: Readonly<Record<string, string>> = resultRef ? { resultRef } : {};
    return this.leaseMutation(receiptId, leaseId, (record) => ({
      ...record,
      state: 'completed',
      updatedAtMs: nowMs,
      decision: {
        generation: record.decision.generation + 1,
        atMs: nowMs,
        reason: 'execution-completed',
        evidence,
      },
      lease: undefined,
      ...(resultRef ? { resultRef } : {}),
    }));
  }

  async releaseLease(receiptId: string, leaseId: string, nowMs: number) {
    return this.leaseMutation(receiptId, leaseId, (record) => ({
      ...record,
      state: 'queued',
      updatedAtMs: nowMs,
      decision: {
        generation: record.decision.generation + 1,
        atMs: nowMs,
        reason: 'lease-released',
        evidence: {},
      },
      lease: undefined,
    }));
  }

  async releaseClaim(
    receiptId: string,
    leaseId: string,
    actualDemand: DurableAdmissionRecord['demand'] | undefined,
    nowMs: number,
  ) {
    this.releaseClaimAttempts += 1;
    if (this.failReleaseClaimTimes > 0) {
      this.failReleaseClaimTimes -= 1;
      throw this.releaseClaimError ?? new Error('database unavailable');
    }
    return this.leaseMutation(receiptId, leaseId, (record) => ({
      ...record,
      state: 'completed',
      updatedAtMs: nowMs,
      decision: {
        generation: record.decision.generation + 1,
        atMs: nowMs,
        reason: 'resources-released',
        evidence: { actualDemandReported: actualDemand !== undefined },
      },
      lease: undefined,
      ...(actualDemand ? { actualDemand } : {}),
      releasedAtMs: nowMs,
    }));
  }

  async supersede(receiptId: string, replacementReceiptId: string, nowMs: number) {
    const stored = this.byReceipt(receiptId);
    if (!stored) return null;
    if (!['queued', 'eligible', 'leased', 'running'].includes(stored.record.state)) {
      return { ...stored, changed: false };
    }
    const next = this.replace(stored, {
      ...stored.record,
      state: 'superseded',
      updatedAtMs: nowMs,
      decision: {
        generation: stored.record.decision.generation + 1,
        atMs: nowMs,
        reason: 'superseded',
        evidence: { replacementReceiptId },
      },
      lease: undefined,
      supersededByReceiptId: replacementReceiptId,
    });
    return { ...next, changed: true };
  }
}

function governor(
  store: DurableAdmissionQueueStore,
  now = () => 1_000,
  // EI-21863356544930781: lets a retry test collapse the real ~6s of backoff to nothing.
  driverOptions: { admissionRetryBackoffsMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
) {
  let request = 0;
  let lease = 0;
  const driver = new WorkItemAdmissionQueueDriver(store, {
    namespace: 'test',
    now,
    leaseIdFactory: () => `lease-${++lease}`,
    ...driverOptions,
  });
  return {
    driver,
    governor: new Governor(driver, { now, idFactory: () => `request-${++request}` }),
  };
}

function recordingSqlClient(activeRows: unknown[] = []) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values });
    return Promise.resolve(
      strings.join('?').includes('SELECT feature_id AS receipt_id') ? activeRows : ([] as unknown[]),
    );
  };
  const client = Object.assign(tx, {
    begin: async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx),
  }) as never;
  return { client, queries };
}

describe('goal observation replay binding', () => {
  it('accepts legacy snapshot-inclusive receipts while rejecting changed semantic pins', async () => {
    const store = new MemoryAdmissionQueueStore();
    const input = { idempotencyKey: 'legacy-goal-replay', admissionClass: 'agent',
      metadata: { goalId: 'goal', fleetSlug: 'fleet', targetOwnerId: 'target', goalAdmission: 'first-snapshot' } };
    const first = await governor(store).governor.admit(input);
    const stored = (await store.find('test', input.idempotencyKey))!;
    const normalized = normalizeAdmissionRequest(input);
    const legacyFingerprint = createHash('sha256').update(JSON.stringify({
      idempotencyKey: normalized.idempotencyKey, admissionClass: normalized.admissionClass,
      priority: normalized.priority, deadlineAtMs: normalized.deadlineAtMs, demand: normalized.demand,
      payloadRef: normalized.payloadRef, coalesceKey: normalized.coalesceKey,
      parentRequestId: normalized.parent?.requestId ?? null, bypassKey: normalized.bypassKey,
      metadata: normalized.metadata,
    })).digest('hex');
    expect(legacyFingerprint).not.toBe(createHash('sha256').update(admissionRequestFingerprint(normalized)).digest('hex'));
    Object.assign(stored.record, { requestFingerprint: legacyFingerprint });
    const retry = await governor(store).governor.admit({ ...input,
      metadata: { ...input.metadata, goalAdmission: 'new-snapshot' } });
    expect(retry).toEqual(first);
    expect(stored.record.requestFingerprint).toBe(legacyFingerprint);
    expect(stored.record.metadata.goalAdmission).toBe('first-snapshot');
    const { goalAdmission: _observation, ...pins } = input.metadata;
    expect(await governor(store).governor.admit({ ...input, metadata: pins })).toEqual(first);
    for (const [field, value] of Object.entries({ goalId: 'other-goal', fleetSlug: 'other-fleet', targetOwnerId: 'other-target' })) {
      await expect(governor(store).governor.admit({ ...input, metadata: { ...input.metadata, [field]: value } }))
        .rejects.toBeInstanceOf(AdmissionIdempotencyConflictError);
    }
  });

  it('reuses the original durable receipt across governor instances without replacing its observation', async () => {
    const store = new MemoryAdmissionQueueStore();
    const input = {
      idempotencyKey: 'goal-replay', admissionClass: 'agent', demand: { cpuWeight: 1 },
      metadata: { goalId: 'goal', fleetSlug: 'fleet', targetOwnerId: 'target', goalReservation: true,
        goalAdmission: JSON.stringify({ measuredAt: 'first', headcount: 1 }) },
    };
    const first = await governor(store).governor.admit(input);
    const retryGovernor = governor(store).governor;
    const retry = await retryGovernor.admit({ ...input, metadata: { ...input.metadata,
      goalAdmission: JSON.stringify({ measuredAt: 'retry', headcount: 2 }) } });
    expect(retry).toEqual(first);
    expect((await store.find('test', input.idempotencyKey))?.record.metadata.goalAdmission)
      .toBe(input.metadata.goalAdmission);
    for (const [field, value] of Object.entries({ goalId: 'other-goal', fleetSlug: 'other-fleet',
      targetOwnerId: 'other-target', goalReservation: false })) {
      await expect(governor(store).governor.admit({ ...input, metadata: { ...input.metadata, [field]: value } }))
        .rejects.toBeInstanceOf(AdmissionIdempotencyConflictError);
    }
    await expect(governor(store).governor.admit({ ...input, demand: { cpuWeight: 2 } }))
      .rejects.toBeInstanceOf(AdmissionIdempotencyConflictError);
  });

  it('still rejects changed goalAdmission metadata for other admission classes', async () => {
    const store = new MemoryAdmissionQueueStore();
    const input = { idempotencyKey: 'process-replay', admissionClass: 'process',
      metadata: { goalAdmission: 'first' } };
    await governor(store).governor.admit(input);
    await expect(governor(store).governor.admit({ ...input, metadata: { goalAdmission: 'retry' } }))
      .rejects.toBeInstanceOf(AdmissionIdempotencyConflictError);
  });
});

describe('resource-governor queue liveness and census boundaries (EI-219699)', () => {
  it('selects only explicit ended owners and preserves every ambiguous state', () => {
    const rows: QueueLeaseOwnerObservation[] = [
      { receiptId: 'WI-ended', leaseId: 'lease-ended', owner: 'ended' },
      { receiptId: 'WI-suspect', leaseId: 'lease-suspect', owner: 'suspect' },
      { receiptId: 'WI-live', leaseId: 'lease-live', owner: 'live' },
      { receiptId: 'WI-parked', leaseId: 'lease-parked', owner: 'parked' },
      { receiptId: 'WI-unknown', leaseId: 'lease-unknown', owner: 'unknown' },
      { receiptId: 'WI-stale', leaseId: 'lease-stale', owner: 'stale' },
    ];
    const verdicts = new Map([
      ['ended', { sessionState: 'ended' as const }],
      ['suspect', { sessionState: 'suspect' as const }],
      ['live', { sessionState: 'live' as const }],
      ['parked', { sessionState: 'parked' as const }],
      ['unknown', { sessionState: null }],
      ['stale', { sessionState: 'draining' as const }],
    ]);
    expect(selectEndedLeaseOwners(rows, verdicts)).toEqual([rows[0]]);
  });

  it('maps complete census rows and PostgreSQL numeric strings without bounding the input', () => {
    expect(
      mapGovernorQueuePopulationRows([
        {
          admission_class: ' agent ',
          depth: '12',
          oldest_age_ms: '2500',
          arrivals: '8',
          drained: 3,
          observed_window_ms: '60000',
        },
        {
          admission_class: 'empty',
          depth: 0,
          oldest_age_ms: null,
          arrivals: 1,
          drained: 1,
          observed_window_ms: 60000,
        },
      ]),
    ).toEqual([
      { admissionClass: 'agent', depth: 12, oldestAgeMs: 2500, arrivals: 8, drained: 3, observedWindowMs: 60000 },
      { admissionClass: 'empty', depth: 0, arrivals: 1, drained: 1, observedWindowMs: 60000 },
    ]);
  });

  it('resolves distinct active owners before mutation and emits compare-and-release identity guards', async () => {
    const { client, queries } = recordingSqlClient([
      { receipt_id: 'WI-dead', lease_id: 'lease-dead', owner: 'owner-dead' },
      { receipt_id: 'WI-live', lease_id: 'lease-live', owner: 'owner-live' },
      { receipt_id: 'WI-dead-2', lease_id: 'lease-dead-2', owner: 'owner-dead' },
    ]);
    const resolveSessionStatesFn = async (subjects: readonly { ownerId: string }[], options: unknown) => {
      expect(subjects).toEqual([{ ownerId: 'owner-dead' }, { ownerId: 'owner-live' }]);
      // WI-10004631: one owner-filtered presence read for the roster, never one
      // point read per active lease owner.
      expect(options).toMatchObject({ hydrateBatch: true, nowMs: 5_000 });
      expect(options).not.toHaveProperty('hydratePerId');
      return new Map([
        ['owner-dead', { sessionState: 'ended' as const }],
        ['owner-live', { sessionState: 'live' as const }],
      ]);
    };
    const store = new PgWorkItemAdmissionQueueStore({
      sql: client,
      workspaceId: 'workspace-test',
      resolveSessionStatesFn: resolveSessionStatesFn as never,
    });

    await expect(store.reconcileExpired('test', 5_000)).resolves.toMatchObject({ requeued: 0 });
    const ownerEnded = queries.find((query) => query.text.includes("'owner-ended'"));
    expect(ownerEnded).toBeDefined();
    expect(ownerEnded?.text).toContain('jsonb_to_recordset');
    expect(ownerEnded?.text).toContain("lease'->>'leaseId'");
    expect(ownerEnded?.text).toContain("lease'->>'owner'");
    expect(ownerEnded?.text).toContain('identity.lease_id');
    expect(ownerEnded?.text).toContain('identity.owner');
    expect(ownerEnded?.text).toContain('FOR UPDATE OF item SKIP LOCKED');
  });

  it('maps active lease identity rows conservatively, dropping incomplete rows', () => {
    expect(
      mapQueueLeaseOwnerRows([
        { receipt_id: ' WI-1 ', lease_id: ' lease-1 ', owner: ' owner-1 ' },
        { receipt_id: 'WI-2', lease_id: null, owner: 'owner-2' },
      ]),
    ).toEqual([{ receiptId: 'WI-1', leaseId: 'lease-1', owner: 'owner-1' }]);
  });
});

describe('resource-governor liveness-read deadline (EI-23122978932795934)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [
      'legacy work-item store',
      (sql: never) => new PgWorkItemAdmissionQueueStore({ sql, workspaceId: 'workspace-test' }),
    ],
    [
      'canonical ledger store',
      (sql: never) => new PgAdmissionLedgerQueueStore({ sql, workspaceId: 'workspace-test' }),
    ],
  ])('bounds a hung %s raw-pool liveness query', async (_label, makeStore) => {
    vi.useFakeTimers();
    const hangingSql = Object.assign(
      (strings: TemplateStringsArray) =>
        strings.join('').includes('SELECT') ? new Promise<never>(() => {}) : { fragment: strings.join('') },
      {},
    ) as never;
    const store = makeStore(hangingSql);
    const pending = store.readActiveLeaseOwners();
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'DbCallDeadlineError',
      deadlineMs: RESOURCE_GOVERNOR_LIVENESS_READ_DEADLINE_MS,
    });

    await vi.advanceTimersByTimeAsync(RESOURCE_GOVERNOR_LIVENESS_READ_DEADLINE_MS);
    await assertion;
  });
});

describe('WorkItemAdmissionQueueDriver', () => {
  it('bounds PostgreSQL queue mutations with database-side lock and statement timeouts', async () => {
    const { client, queries } = recordingSqlClient();
    const store = new PgWorkItemAdmissionQueueStore({
      sql: client,
      workspaceId: 'workspace-test',
    });

    await expect(store.reconcileExpired('test', 1_000)).resolves.toEqual({
      requeued: 0,
      expired: 0,
      abandoned: 0,
      total: 0,
    });

    // boundedOrgTxn sets both transaction-local timeouts in ONE set_config
    // statement (WI-10003631 merged the two round trips); the values bind in order.
    const timeoutQueries = queries.filter((query) => query.text.includes('SELECT set_config'));
    expect(timeoutQueries).toHaveLength(1);
    expect(timeoutQueries[0]!.text).toContain("set_config('lock_timeout', ?, true)");
    expect(timeoutQueries[0]!.text).toContain("set_config('statement_timeout', ?, true)");
    expect(timeoutQueries[0]!.values).toEqual(['8000ms', '15000ms']);

    // The liveness census is a read-only work_items query and intentionally has
    // no row lock. Only the three mutation branches must retain bounded
    // FOR UPDATE SKIP LOCKED selection.
    const workItemQueries = queries.filter((query) => query.text.includes('harness_shared.work_items'));
    expect(workItemQueries).toHaveLength(4);
    const reconcileQueries = workItemQueries.filter((query) => query.text.includes('FOR UPDATE SKIP LOCKED'));
    expect(reconcileQueries).toHaveLength(3);
    for (const query of reconcileQueries) {
      expect(query.text).toContain('FOR UPDATE SKIP LOCKED');
      expect(query.text).toContain('LIMIT ?');
    }
    expect(queries.some((query) => query.text.includes('pg_try_advisory_xact_lock'))).toBe(true);
  });

  it('skips reconciliation when another process owns the workspace turn', async () => {
    const queries: string[] = [];
    const tx = (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const text = strings.join('?');
      queries.push(text);
      return text.includes('pg_try_advisory_xact_lock')
        ? Promise.resolve([{ locked: false }])
        : Promise.resolve([] as unknown[]);
    };
    const client = {
      begin: async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx),
    } as never;
    const store = new PgWorkItemAdmissionQueueStore({ sql: client, workspaceId: 'workspace-test' });

    await expect(store.reconcileExpired('test', 1_000)).resolves.toEqual({
      requeued: 0,
      expired: 0,
      abandoned: 0,
      total: 0,
    });
    expect(queries).toHaveLength(2); // one bounded-transaction set_config + one non-blocking try-lock
    expect(queries.filter((query) => query.includes('harness_shared.work_items'))).toHaveLength(0);
  });

  it('returns one stable durable receipt across process restart and rejects conflicting replay', async () => {
    const store = new MemoryQueueStore();
    const first = governor(store).governor;
    const restarted = governor(store).governor;
    const request = {
      idempotencyKey: 'same',
      admissionClass: 'build',
      demand: { memoryBytes: 4_096 },
      payloadRef: 'work-item:WI-source',
    } as const;

    const a = await first.admit(request);
    const b = await restarted.admit(request);
    expect(a).toMatchObject({ kind: 'queued', receipt: { receiptId: 'WI-1', state: 'queued' } });
    expect(b).toMatchObject({ kind: 'queued', receipt: { receiptId: 'WI-1', state: 'queued' } });
    expect(store.size).toBe(1);

    await expect(restarted.admit({ ...request, priority: 9 })).rejects.toBeInstanceOf(
      AdmissionIdempotencyConflictError,
    );
  });

  it('never returns a receipt when durable persistence fails', async () => {
    const store = new MemoryQueueStore();
    store.failEnqueue = true;
    await expect(
      governor(store).governor.admit({ idempotencyKey: 'lost', admissionClass: 'mcp' }),
    ).rejects.toBeInstanceOf(AdmissionPersistenceError);
    expect(store.size).toBe(0);
  });

  // Regression: the wrapper used to carry a CONSTANT message and keep the real fault only on
  // `.cause`, which is not serialised to MCP callers. Every distinct DB fault therefore reached an
  // agent as the same undiagnosable sentence. Observed 2026-08-27: capability:launch-agent failed
  // 4/4 with only "durable admission record could not be persisted", costing hours of blind
  // hypothesis-elimination because the actual SQLSTATE was never visible.
  it('surfaces the underlying fault in the thrown message, not just on .cause', async () => {
    const store = new MemoryQueueStore();
    store.failEnqueue = true;
    store.enqueueError = new Error('relation "harness_shared.work_items" does not exist');

    const error = await governor(store)
      .governor.admit({ idempotencyKey: 'lost', admissionClass: 'mcp' })
      .then(
        () => null,
        (thrown: unknown) => thrown as AdmissionPersistenceError,
      );

    expect(error).toBeInstanceOf(AdmissionPersistenceError);
    expect(error?.message).toContain('relation "harness_shared.work_items" does not exist');
    // The constant prefix alone must never be the whole message again.
    expect(error?.message).not.toBe('durable admission record could not be persisted');
    expect((error?.cause as Error | undefined)?.message).toBe(
      'relation "harness_shared.work_items" does not exist',
    );
  });

  // EI-21863356544930781: a transient pg contention timeout (55P03) on the admission write used to
  // cost the caller the whole run. Reproduced as two consecutive testing:run calls failing with
  // "durable admission record could not be persisted ... sqlstate=55P03" while the SAME tests ran
  // fine via npm immediately after — the tests were runnable throughout; only the bookkeeping
  // write lost its lock race. Admission is PRE-execution, so the fix is a bounded retry, not
  // best-effort recording.
  const contentionError = () =>
    Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });

  const noSleep = { admissionRetryBackoffsMs: [1, 1, 1] as const, sleep: async () => {} };

  it('rides out a transient pg contention timeout on the admission write and still persists', async () => {
    const store = new MemoryQueueStore();
    store.failEnqueueTimes = 2; // fails twice, then succeeds — the contention dip clears
    store.enqueueError = contentionError();

    const outcome = await governor(store, () => 1_000, noSleep).governor.admit({
      idempotencyKey: 'rides-out',
      admissionClass: 'mcp',
    });

    expect(outcome.kind).toBe('queued');
    expect(store.size).toBe(1);
    expect(store.enqueueAttempts).toBe(3); // two failures + the successful write
  });

  // EI-22697720752476196: the original production red happened AFTER test execution, while
  // WorkItemAdmissionQueueDriver.release() tried to complete its governed receipt. The same
  // bounded retry must cover this terminal row-lock transition, or a transient 57014 still
  // reports a cleanup failure and leaks the reservation.
  it('rides out transient pg contention during terminal resource release', async () => {
    const store = new MemoryQueueStore();
    store.failReleaseClaimTimes = 2; // the contention dip clears before the third CAS attempt
    store.releaseClaimError = contentionError();
    const { governor: api, driver } = governor(store, () => 1_000, noSleep);
    const admitted = await api.admit({ idempotencyKey: 'release-rides-out', admissionClass: 'process' });
    if (admitted.kind !== 'queued') throw new Error('expected a queued receipt');
    const claim = await driver.leaseReceipt({
      receiptId: admitted.receipt.receiptId,
      owner: 'worker',
      ttlMs: 1_000,
    });
    if (!claim) throw new Error('expected a targeted lease');

    await expect(api.release(claim.context, { cpuWeight: 1 })).resolves.toEqual({
      requestId: claim.context.requestId,
      released: true,
    });
    expect(store.releaseClaimAttempts).toBe(3); // two transient failures + the successful release
    await expect(api.status('release-rides-out')).resolves.toMatchObject({ state: 'completed' });
  });

  it('uses the claimed receipt identity without a pre-settlement identity lookup', async () => {
    const store = new MemoryQueueStore();
    const { governor: api, driver } = governor(store, () => 1_000, { sleep: async () => {} });
    const admitted = await api.admit({ idempotencyKey: 'receipt-targeted-release', admissionClass: 'process' });
    if (admitted.kind !== 'queued') throw new Error('expected a queued receipt');
    const claim = await driver.leaseReceipt({
      receiptId: admitted.receipt.receiptId,
      owner: 'worker',
      ttlMs: 1_000,
    });
    if (!claim) throw new Error('expected a targeted lease');

    const find = vi.spyOn(store, 'find').mockImplementation(async () => {
      throw new Error('pre-settlement identity lookup must not run for a claimed receipt');
    });
    await expect(api.release(claim.context, { cpuWeight: 1 })).resolves.toEqual({
      requestId: claim.context.requestId,
      released: true,
    });
    expect(find).not.toHaveBeenCalled();
  });

  it('does not retry a non-contention terminal release failure', async () => {
    const store = new MemoryQueueStore();
    store.failReleaseClaimTimes = 1;
    store.releaseClaimError = Object.assign(new Error('relation "resource_governor_admissions" does not exist'), {
      code: '42P01',
    });
    const { governor: api, driver } = governor(store, () => 1_000, noSleep);
    const admitted = await api.admit({ idempotencyKey: 'release-real-fault', admissionClass: 'process' });
    if (admitted.kind !== 'queued') throw new Error('expected a queued receipt');
    const claim = await driver.leaseReceipt({
      receiptId: admitted.receipt.receiptId,
      owner: 'worker',
      ttlMs: 1_000,
    });
    if (!claim) throw new Error('expected a targeted lease');

    await expect(api.release(claim.context)).rejects.toThrow('resource_governor_admissions');
    expect(store.releaseClaimAttempts).toBe(1);
  });

  /**
   * NEGATIVE CONTROL. Without this, the test above would still pass if the retry were
   * unconditional — which would be a real defect: a genuine fault (missing relation, DB down,
   * a bug) must surface on the FIRST attempt, not after burning the backoff budget. Asserting
   * the attempt COUNT is the part that discriminates; asserting only that it threw would not.
   */
  it('does NOT retry a non-contention fault — it surfaces on the first attempt', async () => {
    const store = new MemoryQueueStore();
    store.failEnqueue = true;
    store.enqueueError = Object.assign(
      new Error('relation "harness_shared.work_items" does not exist'),
      { code: '42P01' },
    );

    await expect(
      governor(store, () => 1_000, noSleep).governor.admit({
        idempotencyKey: 'real-fault',
        admissionClass: 'mcp',
      }),
    ).rejects.toBeInstanceOf(AdmissionPersistenceError);

    expect(store.enqueueAttempts).toBe(1);
  });

  it('says the retries are spent when contention never clears, so a caller does not just retry again', async () => {
    const store = new MemoryQueueStore();
    store.failEnqueue = true; // contention that never clears
    store.enqueueError = contentionError();

    const error = await governor(store, () => 1_000, noSleep)
      .governor.admit({ idempotencyKey: 'never-clears', admissionClass: 'mcp' })
      .then(
        () => null,
        (thrown: unknown) => thrown as AdmissionPersistenceError,
      );

    expect(error).toBeInstanceOf(AdmissionPersistenceError);
    expect(error?.message).toContain('after 4 attempts');
    expect(error?.message).toContain('sqlstate=55P03');
    expect(store.enqueueAttempts).toBe(4); // initial + 3 backoffs
  });

  it('includes postgres diagnostic fields when the fault is a pg error', async () => {
    const store = new MemoryQueueStore();
    store.failEnqueue = true;
    store.enqueueError = Object.assign(new Error('new row violates check constraint'), {
      code: '23514',
      constraint: 'work_items_status_check',
      schema: 'harness_shared',
      table: 'work_items',
    });

    const error = await governor(store)
      .governor.admit({ idempotencyKey: 'lost', admissionClass: 'mcp' })
      .then(
        () => null,
        (thrown: unknown) => thrown as AdmissionPersistenceError,
      );

    expect(error?.message).toContain('sqlstate=23514');
    expect(error?.message).toContain('constraint=work_items_status_check');
    expect(error?.message).toContain('relation=harness_shared.work_items');
  });

  it('does not throw while describing a non-Error rejection', async () => {
    const store = new MemoryQueueStore();
    store.failEnqueue = true;
    store.enqueueError = 'connection terminated unexpectedly';

    await expect(
      governor(store).governor.admit({ idempotencyKey: 'lost', admissionClass: 'mcp' }),
    ).rejects.toThrow(/connection terminated unexpectedly/);
  });

  it('leases once, rejects a stale lease, and exposes the durable result', async () => {
    const clock = { now: 10_000 };
    const store = new MemoryQueueStore();
    const { governor: api, driver } = governor(store, () => clock.now);
    await api.admit({ idempotencyKey: 'run', admissionClass: 'process', priority: 2 });

    const [won, lost] = await Promise.all([
      driver.leaseNext({ owner: 'worker-a', ttlMs: 1_000 }),
      driver.leaseNext({ owner: 'worker-b', ttlMs: 1_000 }),
    ]);
    expect([won, lost].filter(Boolean)).toHaveLength(1);
    const claim = won ?? lost;
    if (!claim) throw new Error('expected a lease');
    expect(claim.lease.owner).toMatch(/^worker-/);

    expect((await driver.markRunning(claim.receiptId, 'stale'))?.changed).toBe(false);
    expect((await driver.markRunning(claim.receiptId, claim.lease.leaseId))?.record.state).toBe('running');
    expect((await driver.complete(claim.receiptId, claim.lease.leaseId, 'result:42'))?.record.state).toBe('completed');
    await expect(api.status('run')).resolves.toMatchObject({ state: 'completed', resultRef: 'result:42' });
  });

  it('cancels idempotently and coalesces an older active receipt', async () => {
    const store = new MemoryQueueStore();
    const { governor: api } = governor(store);
    const old = await api.admit({ idempotencyKey: 'old', admissionClass: 'indexing', coalesceKey: 'index:main' });
    await api.admit({ idempotencyKey: 'new', admissionClass: 'indexing', coalesceKey: 'index:main' });
    expect(await api.status('old')).toMatchObject({ state: 'superseded' });
    expect(await api.cancel('new', 'operator stopped it')).toMatchObject({ cancelled: true, state: 'cancelled' });
    expect(await api.cancel('new')).toMatchObject({ cancelled: false, state: 'cancelled' });
    expect((old as { context: AdmissionContext }).context.rootRequestId).toBeTruthy();
  });

  it('propagates receipt lineage and records exact actual-cost release once', async () => {
    const clock = { now: 1_000 };
    const store = new MemoryQueueStore();
    const feedback: unknown[] = [];
    let request = 0;
    let lease = 0;
    const driver = new WorkItemAdmissionQueueDriver(store, {
      namespace: 'test',
      now: () => clock.now,
      leaseIdFactory: () => `lease-${++lease}`,
      onActualDemand: (input) => void feedback.push(input),
    });
    const api = new Governor(driver, { now: () => clock.now, idFactory: () => `request-${++request}` });

    const parent = await api.admit({ idempotencyKey: 'parent', admissionClass: 'agent', demand: { cpuWeight: 2 } });
    const child = await api.admit({
      idempotencyKey: 'child',
      admissionClass: 'database',
      demand: { databaseConnections: 1 },
      parent: parent.context,
    });
    expect(parent.context).toMatchObject({ receiptId: 'WI-1', rootRequestId: 'request-1' });
    expect(child.context).toMatchObject({
      receiptId: 'WI-2',
      parentReceiptId: 'WI-1',
      parentRequestId: 'request-1',
      rootRequestId: 'request-1',
      demand: { databaseConnections: 1 },
    });

    const parentClaim = await driver.leaseNext({ owner: 'worker', ttlMs: 1_000 });
    const childClaim = await driver.leaseNext({ owner: 'worker', ttlMs: 1_000 });
    const claim = [parentClaim, childClaim].find((item) => item?.record.idempotencyKey === 'child');
    if (!claim) throw new Error('expected child lease');
    clock.now = 1_100;
    await expect(api.release(claim.context, { databaseConnections: 2 })).resolves.toEqual({
      requestId: 'request-2',
      released: true,
    });
    await expect(api.release(claim.context, { databaseConnections: 3 })).resolves.toEqual({
      requestId: 'request-2',
      released: false,
    });
    await expect(api.status('child')).resolves.toMatchObject({
      state: 'completed',
      context: { receiptId: 'WI-2', parentReceiptId: 'WI-1', rootRequestId: 'request-1' },
    });
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatchObject({
      receiptId: 'WI-2',
      plannedDemand: { databaseConnections: 1 },
      actualDemand: { databaseConnections: 2 },
      releasedAtMs: 1_100,
    });
  });

  describe('reconcileExpired() coalescing (EI-1211660)', () => {
    /** A store whose reconcileExpired() never resolves on its own — settleNext() drives it,
     *  so a test can observe how many concurrent driver.reconcileExpired() calls are still
     *  in flight before any of them settle. */
    class DeferredReconcileStore extends MemoryQueueStore {
      calls = 0;
      private pendingResolvers: Array<(value: QueueReconciliationResult) => void> = [];

      async reconcileExpired(_namespace: string, _nowMs: number): Promise<QueueReconciliationResult> {
        this.calls += 1;
        return new Promise((resolve) => {
          this.pendingResolvers.push(resolve);
        });
      }

      settleNext(result: QueueReconciliationResult): void {
        const resolve = this.pendingResolvers.shift();
        if (!resolve) throw new Error('settleNext() called with no reconcileExpired() call pending');
        resolve(result);
      }
    }

    it('shares one store round-trip across concurrent calls, then across settled calls within the window', async () => {
      const clock = { now: 1_000 };
      const store = new DeferredReconcileStore();
      const driver = new WorkItemAdmissionQueueDriver(store, {
        namespace: 'test',
        now: () => clock.now,
      });

      // Two callers racing concurrently (the fleet-wide-admission shape this exists to fix)
      // must observe exactly ONE store call between them, not two.
      const first = driver.reconcileExpired();
      const second = driver.reconcileExpired();
      expect(store.calls).toBe(1);

      store.settleNext({ requeued: 1, expired: 2, abandoned: 0, total: 3 });
      await expect(first).resolves.toEqual({ requeued: 1, expired: 2, abandoned: 0, total: 3 });
      await expect(second).resolves.toEqual({ requeued: 1, expired: 2, abandoned: 0, total: 3 });

      // Still inside the coalesce window after settlement: a later caller reuses the same
      // settled result rather than issuing a fresh round-trip.
      clock.now += 500;
      await expect(driver.reconcileExpired()).resolves.toEqual({ requeued: 1, expired: 2, abandoned: 0, total: 3 });
      expect(store.calls).toBe(1);

      // Outside the window: the next call issues a genuinely fresh store round-trip.
      clock.now += 10_000;
      const fresh = driver.reconcileExpired();
      expect(store.calls).toBe(2);
      store.settleNext({ requeued: 0, expired: 0, abandoned: 0, total: 0 });
      await expect(fresh).resolves.toEqual({ requeued: 0, expired: 0, abandoned: 0, total: 0 });
    });

    it('never caches a rejection — the very next call retries against the store fresh', async () => {
      const clock = { now: 1_000 };
      let calls = 0;
      class FailOnceStore extends MemoryQueueStore {
        async reconcileExpired(): Promise<QueueReconciliationResult> {
          calls += 1;
          if (calls === 1) throw new Error('transient contention');
          return { requeued: 0, expired: 0, abandoned: 0, total: 0 };
        }
      }
      const driver = new WorkItemAdmissionQueueDriver(new FailOnceStore(), {
        namespace: 'test',
        now: () => clock.now,
      });

      await expect(driver.reconcileExpired()).rejects.toThrow('transient contention');
      // Immediately after, still well inside what would be the coalesce window — the failed
      // attempt must not be cached against later callers.
      await expect(driver.reconcileExpired()).resolves.toEqual({ requeued: 0, expired: 0, abandoned: 0, total: 0 });
      expect(calls).toBe(2);
    });

    it('a store with no reconcileExpired() keeps returning the zero result with no coalescing state', async () => {
      const store = new MemoryQueueStore();
      const driver = new WorkItemAdmissionQueueDriver(store, { namespace: 'test', now: () => 1_000 });
      await expect(driver.reconcileExpired()).resolves.toEqual({ requeued: 0, expired: 0, abandoned: 0, total: 0 });
      await expect(driver.reconcileExpired()).resolves.toEqual({ requeued: 0, expired: 0, abandoned: 0, total: 0 });
    });
  });
});

/**
 * WI-1741497 — the no-deadline abandonment floor.
 *
 * THE DEFECT THIS CLOSES. Two individually-correct mechanisms composed into a leak.
 * Reconciliation requeues a receipt whose LEASE died (`leased`/`running` -> `queued`),
 * and receipt-gc deletes only TERMINAL receipts, deliberately never an active one. The
 * single exit from `queued` to terminal was the deadline branch, gated on a NUMERIC
 * `deadlineAtMs` — which only the inference gateway ever sets. So an `agent`/`process`/
 * `embedding`/`transfer` receipt whose owner died was requeued into `queued` and became
 * immortal: exempt from GC by design, exempt from expiry by predicate.
 *
 * MEASURED 2026-08-31 against live PG: 1,509 such rows, 1,271 stamped
 * `reason: 'lease-expired'` (proof the reconciler had run and requeued them correctly),
 * oldest 91.8h, accumulating ~14/hour and never draining. The four `inference` rows —
 * the one class that sets a deadline — were the healthy control in the same population.
 */
describe('no-deadline abandonment floor (WI-1741497)', () => {
  const DWELL_MS = 60_000;
  const LEASE_TTL_MS = 100;

  /** Drive a receipt to `queued`-with-no-lease the way production does: lease it, run it, let the lease die. */
  async function orphanedReceipt(clock: { now: number }, store: MemoryAdmissionQueueStore, klass: string) {
    const { driver, governor: gov } = governor(store, () => clock.now);
    const admitted = await gov.admit({ idempotencyKey: `orphan-${klass}`, admissionClass: klass });
    if (admitted.kind !== 'queued') throw new Error('expected a queued receipt');
    const claim = await driver.leaseReceipt({
      receiptId: admitted.receipt.receiptId,
      owner: 'worker-that-dies',
      ttlMs: LEASE_TTL_MS,
    });
    if (!claim) throw new Error('expected a targeted lease');
    await driver.markRunning(claim.receiptId, claim.lease.leaseId);
    // The owning process dies here — nothing ever calls release()/complete().
    clock.now += LEASE_TTL_MS + 1;
    await expect(store.reconcileExpired('test', clock.now)).resolves.toMatchObject({ requeued: 1, abandoned: 0 });
    return admitted.receipt.receiptId;
  }

  it('CALIBRATION: an orphaned deadline-less receipt reaches a terminal state once the dwell passes', async () => {
    const clock = { now: 1_000 };
    const store = new MemoryAdmissionQueueStore().withAbandonAfterMs(DWELL_MS);
    await orphanedReceipt(clock, store, 'agent');

    // Requeued but still inside the dwell: untouched, because the dwell clock restarts
    // on every write (including the requeue itself).
    clock.now += DWELL_MS - 1;
    await expect(store.reconcileExpired('test', clock.now)).resolves.toMatchObject({ abandoned: 0 });
    await expect(store.find('test', 'orphan-agent')).resolves.toMatchObject({ record: { state: 'queued' } });

    // Past the dwell: terminal, with its own reason so a future reader can tell WHICH
    // branch acted — the same legibility that let `lease-expired` prove the requeue ran.
    clock.now += 2;
    await expect(store.reconcileExpired('test', clock.now)).resolves.toMatchObject({ abandoned: 1 });
    await expect(store.find('test', 'orphan-agent')).resolves.toMatchObject({
      record: { state: 'expired', decision: { reason: 'abandoned-without-deadline' } },
    });
  });

  it('REGRESSION WITNESS: with the floor disabled the receipt is immortal — the exact pre-fix behaviour', async () => {
    // Falsifiability without mutating the shared tree (the repo's mutation-probe rule).
    // Same store, same clock, same orphaning sequence as the CALIBRATION case above —
    // the ONLY difference is a dwell no elapsed time can reach, which disables the floor.
    // The receipt then survives forever in `queued`, reproducing the measured live defect.
    // If this test ever starts abandoning the row, the calibration above has stopped
    // depending on the floor and is passing for some other reason.
    const clock = { now: 1_000 };
    const store = new MemoryAdmissionQueueStore().withAbandonAfterMs(Number.MAX_SAFE_INTEGER);
    await orphanedReceipt(clock, store, 'agent');

    for (let tick = 0; tick < 5; tick += 1) {
      clock.now += DWELL_MS * 1_000;
      await expect(store.reconcileExpired('test', clock.now)).resolves.toMatchObject({ abandoned: 0 });
    }
    // Still active, still holding its receipt — and receipt-gc never sweeps an active state,
    // which is precisely how 1,509 of these accumulated in production.
    await expect(store.find('test', 'orphan-agent')).resolves.toMatchObject({
      record: { state: 'queued', decision: { reason: 'lease-expired' } },
    });
  });

  it('CONTROL: a receipt WITH a numeric deadline is never abandoned — the deadline branch owns it', async () => {
    const clock = { now: 1_000 };
    const store = new MemoryAdmissionQueueStore().withAbandonAfterMs(DWELL_MS);
    const { governor: gov } = governor(store, () => clock.now);
    // The live `inference` shape: the one admission class that sets a deadline.
    const admitted = await gov.admit({
      idempotencyKey: 'has-deadline',
      admissionClass: 'inference',
      deadlineAtMs: clock.now + 10 * DWELL_MS,
    });
    if (admitted.kind !== 'queued') throw new Error('expected a queued receipt');

    clock.now += DWELL_MS * 2;
    await expect(store.reconcileExpired('test', clock.now)).resolves.toMatchObject({ abandoned: 0 });
    await expect(store.find('test', 'has-deadline')).resolves.toMatchObject({ record: { state: 'queued' } });
  });

  it('CONTROL: a live leased/running receipt is never abandoned, however long it runs', async () => {
    const clock = { now: 1_000 };
    const store = new MemoryAdmissionQueueStore().withAbandonAfterMs(DWELL_MS);
    const { driver, governor: gov } = governor(store, () => clock.now);
    const admitted = await gov.admit({ idempotencyKey: 'long-runner', admissionClass: 'agent' });
    if (admitted.kind !== 'queued') throw new Error('expected a queued receipt');
    const claim = await driver.leaseReceipt({
      receiptId: admitted.receipt.receiptId,
      owner: 'worker',
      ttlMs: 100 * DWELL_MS,
    });
    if (!claim) throw new Error('expected a targeted lease');
    await driver.markRunning(claim.receiptId, claim.lease.leaseId);

    clock.now += DWELL_MS * 10;
    await expect(store.reconcileExpired('test', clock.now)).resolves.toMatchObject({ requeued: 0, abandoned: 0 });
    await expect(store.find('test', 'long-runner')).resolves.toMatchObject({ record: { state: 'running' } });
  });

  /**
   * FALSIFIABILITY CONTROLS — permanently-wrong predicates kept in the test file, per the
   * repo's mutation-probe discipline (never mutate the shared tree to prove a guard works).
   *
   * The three cases above are the instrument. These two deliberately-wrong abandonment
   * predicates prove the instrument has POWER: each disagrees with the real store's
   * observed behaviour on at least one case. If a future refactor made both agree, the
   * cases would have stopped discriminating and this test says so.
   */
  it('CONTROLS: two wrong abandonment predicates each disagree with observed behaviour', () => {
    type Case = { readonly hasLease: boolean; readonly deadlineAtMs: number | null; readonly dwellMs: number };
    // Exactly the three situations exercised above, with their OBSERVED outcomes.
    const observed: ReadonlyArray<readonly [Case, boolean]> = [
      [{ hasLease: false, deadlineAtMs: null, dwellMs: DWELL_MS + 1 }, true], // orphaned, past dwell
      [{ hasLease: false, deadlineAtMs: null, dwellMs: DWELL_MS - 1 }, false], // orphaned, inside dwell
      [{ hasLease: false, deadlineAtMs: 999_999, dwellMs: DWELL_MS * 2 }, false], // has a deadline
      [{ hasLease: true, deadlineAtMs: null, dwellMs: DWELL_MS * 10 }, false], // still leased
    ];

    const wrongIgnoresDeadline = (c: Case) => !c.hasLease && c.dwellMs > DWELL_MS;
    const wrongIgnoresDwell = (c: Case) => !c.hasLease && c.deadlineAtMs === null;

    const disagreements = (predicate: (c: Case) => boolean) =>
      observed.filter(([c, expected]) => predicate(c) !== expected).length;

    // Dropping the deadline guard resurrects the bug in the other direction: it would
    // reap the `inference` receipts that the deadline branch legitimately owns.
    expect(disagreements(wrongIgnoresDeadline)).toBeGreaterThan(0);
    // Dropping the dwell guard would reap a receipt the instant it is requeued.
    expect(disagreements(wrongIgnoresDwell)).toBeGreaterThan(0);
  });

  it('the PG predicate COALESCEs jsonb_typeof, so an ABSENT deadline key still matches', async () => {
    const { client, queries } = recordingSqlClient();
    const store = new PgWorkItemAdmissionQueueStore({ sql: client, workspaceId: 'workspace-test' });
    await store.reconcileExpired('test', 5_000);

    const abandon = queries.find((q) => q.text.includes('abandoned-without-deadline'));
    expect(abandon, 'reconciliation must emit the abandonment branch').toBeDefined();

    // THE POINT OF THIS ASSERTION. jsonb_typeof returns SQL NULL when the KEY IS ABSENT
    // (vs the string 'null' when present holding JSON null), and `NULL <> 'number'` is
    // NULL — not true. A bare `<> 'number'` therefore silently matches NOTHING for
    // exactly the rows whose deadline was never written, while still reporting a clean
    // zero. That is the same failure shape this whole work-item is about, so the guard
    // is pinned here rather than left to review.
    expect(abandon?.text).toContain("COALESCE(jsonb_typeof(payload->'resource_governor'->'deadlineAtMs'), 'null')");
    expect(abandon?.text).toMatch(/state'\s*IN\s*\('queued',\s*'eligible'\)/);
  });
});

describe('ended-lease-owner scan on the lease hot path (WI-10004631)', () => {
  /** A controllable liveness oracle: counts calls and settles only when released. */
  function gatedResolver() {
    const calls: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fn = async (subjects: readonly { ownerId: string }[], options: unknown) => {
      calls.push(options);
      await gate;
      return new Map(subjects.map((s) => [s.ownerId, { sessionState: 'live' as const }]));
    };
    return { calls, release, fn: fn as never };
  }

  /** Fake SQL that returns one active lease for the given store's active-lease read. */
  function leaseSql(activeLeaseMarker: string, activeRow: Record<string, unknown>) {
    const queries: string[] = [];
    const tx = (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      queries.push(text);
      return Promise.resolve(text.includes(activeLeaseMarker) ? [activeRow] : ([] as unknown[]));
    };
    const client = Object.assign(tx, {
      begin: async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx),
    }) as never;
    return { client, activeReads: () => queries.filter((q) => q.includes(activeLeaseMarker)).length };
  }

  it('coalescer: concurrent callers share one in-flight scan; sequential callers re-scan by default', async () => {
    const coalescer = new EndedLeaseOwnerScanCoalescer();
    let computes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compute = async () => {
      computes += 1;
      await gate;
      return [{ receiptId: 'R-1', leaseId: 'L-1', owner: 'o' }];
    };
    const burst = Array.from({ length: 20 }, () => coalescer.scan('agent-process', 1_000, compute));
    release();
    const results = await Promise.all(burst);
    expect(computes).toBe(1);
    expect(new Set(results).size).toBe(1);

    await coalescer.scan('agent-process', 1_001, compute);
    expect(computes).toBe(2);
    // Namespaces never share a scan.
    await Promise.all([coalescer.scan('a', 1_002, compute), coalescer.scan('b', 1_002, compute)]);
    expect(computes).toBe(4);
  });

  it('coalescer: an opt-in reuse window reuses a settled scan, expires, and treats a backwards clock as a miss', async () => {
    const coalescer = new EndedLeaseOwnerScanCoalescer(2_000);
    let computes = 0;
    const compute = async () => {
      computes += 1;
      return [];
    };
    await coalescer.scan(null, 10_000, compute);
    await coalescer.scan(null, 11_999, compute);
    expect(computes).toBe(1);
    await coalescer.scan(null, 12_000, compute);
    expect(computes).toBe(2);
    await coalescer.scan(null, 5_000, compute);
    expect(computes).toBe(3);
  });

  it('coalescer: a failed scan is not cached and does not wedge later callers', async () => {
    const coalescer = new EndedLeaseOwnerScanCoalescer(60_000);
    await expect(
      coalescer.scan('ns', 1, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(coalescer.scan('ns', 2, async () => [])).resolves.toEqual([]);
  });

  it.each([
    [
      'legacy work-item store',
      'SELECT feature_id AS receipt_id',
      { receipt_id: 'WI-1', lease_id: 'lease-1', owner: 'owner-1' },
      (sql: never, fn: never, reuse?: number) =>
        new PgWorkItemAdmissionQueueStore({
          sql,
          workspaceId: 'workspace-test',
          resolveSessionStatesFn: fn,
          endedLeaseOwnerReuseMs: reuse,
        }),
    ],
    [
      'canonical ledger store',
      'lease_owner AS owner',
      { receipt_id: 'RG-1', lease_id: 'lease-1', owner: 'owner-1' },
      (sql: never, fn: never, reuse?: number) =>
        new PgAdmissionLedgerQueueStore({
          sql,
          workspaceId: 'workspace-test',
          resolveSessionStatesFn: fn,
          endedLeaseOwnerReuseMs: reuse,
        }),
    ],
  ])('%s: a burst of leaseReceipt calls runs ONE liveness scan, batch-hydrated', async (_label, marker, row, make) => {
    const { client, activeReads } = leaseSql(marker, row);
    const oracle = gatedResolver();
    const store = make(client, oracle.fn);
    const burst = Array.from({ length: 20 }, (_, i) =>
      store.leaseReceipt('agent-process', `missing-${i}`, 'owner-x', `lease-${i}`, 60_000, 50_000),
    );
    // Let every caller reach the shared scan before it settles.
    await new Promise((resolve) => setImmediate(resolve));
    oracle.release();
    await Promise.all(burst);
    expect(oracle.calls).toHaveLength(1);
    expect(activeReads()).toBe(1);
    expect(oracle.calls[0]).toMatchObject({ hydrateBatch: true, nowMs: 50_000 });
    expect(oracle.calls[0]).not.toHaveProperty('hydratePerId');

    // Default (no reuse window): the next sequential lease reads fresh state.
    await store.leaseReceipt('agent-process', 'missing-next', 'owner-x', 'lease-next', 60_000, 50_001);
    expect(oracle.calls).toHaveLength(2);
  });

  it('canonical ledger store: the production reuse window skips the scan for a lease inside it', async () => {
    const { client, activeReads } = leaseSql('lease_owner AS owner', {
      receipt_id: 'RG-1',
      lease_id: 'lease-1',
      owner: 'owner-1',
    });
    const oracle = gatedResolver();
    oracle.release();
    const store = new PgAdmissionLedgerQueueStore({
      sql: client,
      workspaceId: 'workspace-test',
      resolveSessionStatesFn: oracle.fn,
      endedLeaseOwnerReuseMs: 2_000,
    });
    await store.leaseReceipt('agent-process', 'a', 'o', 'l-a', 60_000, 100_000);
    await store.leaseReceipt('agent-process', 'b', 'o', 'l-b', 60_000, 101_500);
    expect(oracle.calls).toHaveLength(1);
    expect(activeReads()).toBe(1);
    await store.leaseReceipt('agent-process', 'c', 'o', 'l-c', 60_000, 102_000);
    expect(oracle.calls).toHaveLength(2);
    // Explicit reconciliation always reads fresh state, inside the window or not.
    await store.reconcileExpired('agent-process', 102_001);
    expect(oracle.calls).toHaveLength(3);
  });
});
