/** Real-PostgreSQL behavior coverage for the ledger-only admission store. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import postgres from 'postgres';
import { acquireTicketSnapshot, pgAcquireTimingSnapshot, withPgAcquireDiagnostics } from '@papercusp/db-org';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  allSessionsLiveResolver,
  applyAdmissionLedgerFixture,
  truncateAdmissionLedgerFixture,
} from '../../test/_admission-ledger-fixture';
import { AdmissionIdempotencyConflictError, Governor } from './admission';
import { PgAdmissionLedgerQueueStore } from './admission-ledger-store';
import { WorkItemAdmissionQueueDriver, type SqlClient } from './queue';

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('resource-governor-ledger-store');
  await applyAdmissionLedgerFixture(db.sql);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await truncateAdmissionLedgerFixture(db.sql);
});

function instance(
  label: string,
  options: {
    now?: () => number;
    workspaceId?: string;
    abandonAfterMs?: number;
  } = {},
) {
  let requestNo = 0;
  let leaseNo = 0;
  const now = options.now ?? (() => 10_000);
  const store = new PgAdmissionLedgerQueueStore({
    sql: db.sql,
    workspaceId: options.workspaceId ?? 'ws-ledger',
    ...(options.abandonAfterMs ? { abandonAfterMs: options.abandonAfterMs } : {}),
    resolveSessionStatesFn: allSessionsLiveResolver,
  });
  const driver = new WorkItemAdmissionQueueDriver(store, {
    namespace: 'integration',
    now,
    leaseIdFactory: () => `${label}-lease-${++leaseNo}`,
  });
  return {
    store,
    driver,
    governor: new Governor(driver, {
      now,
      idFactory: () => `${label}-request-${++requestNo}`,
    }),
  };
}

describe('PgAdmissionLedgerQueueStore', () => {
  it.for(['pool', 'advisory'] as const)('distinguishes a controlled %s wait in the real admission transaction', { timeout: 20_000 }, async (mode) => {
    const pool = `admission-control-${mode}`;
    const client = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
    const store = new PgAdmissionLedgerQueueStore({
      sql: client as unknown as SqlClient, acquirePool: pool, workspaceId: 'ws-ledger',
      resolveSessionStatesFn: allSessionsLiveResolver,
    });
    const governor = new Governor(new WorkItemAdmissionQueueDriver(store, { namespace: 'integration' }));
    const key = `controlled-${mode}`;
    const lockKey = `resource-governor:ws-ledger:integration:id:${key}`;
    const [{ pid: targetPid }] = await client<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    const holder = await (mode === 'pool' ? client : db.sql).reserve();
    const [{ pid: holderPid }] = await holder<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    let pending: ReturnType<Governor['admit']> | undefined;
    let released = false;
    const release = async () => {
      if (released) return;
      if (mode === 'advisory') await holder`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`;
      holder.release();
      released = true;
    };
    try {
      if (mode === 'advisory') await holder`SELECT pg_advisory_lock(hashtextextended(${lockKey}, 0))`;
      let requestId = '';
      let snapshot: typeof pgAcquireTimingSnapshot = () => null;
      const startedAt = performance.now();
      pending = withPgAcquireDiagnostics('admission.wait-control', id => {
        requestId = id;
        snapshot = AsyncLocalStorage.bind(pgAcquireTimingSnapshot);
        return governor.admit({ idempotencyKey: key, admissionClass: 'process' });
      });
      // Observe any early rejection while the blocker is still held. Finally
      // releases it and drains this same operation; no admission is replayed.
      void pending.catch(() => undefined);
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });
      let observed: { wait_event_type: string | null; wait_event: string | null; blocking_pids: number[] } | undefined;
      await expect.poll(async () => {
        if (mode === 'pool') return acquireTicketSnapshot(pool).tickets.some(ticket =>
          ticket.requestId === requestId && ticket.state === 'waiting');
        [observed] = await db.sql<Array<NonNullable<typeof observed>>>`
          SELECT wait_event_type, wait_event, pg_blocking_pids(pid) AS blocking_pids
            FROM pg_stat_activity
           WHERE pid = ${targetPid} AND datname = current_database() AND state = 'active'`;
        return observed?.wait_event_type === 'Lock' && observed.wait_event === 'advisory'
          && observed.blocking_pids.includes(holderPid);
      }, { timeout: 5_000, interval: 10 }).toBe(true);
      expect(settled).toBe(false);
      const blocked = snapshot();
      expect(blocked).toMatchObject({ requestId, operation: 'admission.wait-control', omitted: 0 });
      if (mode === 'pool') {
        expect(targetPid).toBe(holderPid);
        expect(blocked?.acquisitions).toEqual([]);
      } else {
        expect(targetPid).not.toBe(holderPid);
        expect(blocked?.acquisitions).toEqual([{ pool, elapsedMs: expect.any(Number), outcome: 'acquired' }]);
        expect(acquireTicketSnapshot(pool).tickets).toEqual([
          expect.objectContaining({ requestId, state: 'held' }),
        ]);
      }
      await release();
      const outcome = await pending;
      const durationMs = performance.now() - startedAt;
      expect(outcome.kind).toBe('queued');
      const complete = snapshot();
      expect(complete?.acquisitions).toEqual([{ pool, elapsedMs: expect.any(Number), outcome: 'acquired' }]);
      expect(acquireTicketSnapshot(pool).active).toBe(0);
      console.info('ADMISSION_WAIT_CONTROL', JSON.stringify({ mode, requestId, targetPid, holderPid,
        blocked, observed, complete, durationMs }));
    } finally {
      await release();
      await pending?.catch(() => undefined);
      await client.end({ timeout: 5 });
    }
  });

  it('converges concurrent writers on one RG receipt and never creates a work item', async () => {
    const input = {
      idempotencyKey: 'restart-safe',
      admissionClass: 'build',
      priority: 4,
      demand: { cpuWeight: 20, memoryBytes: 8_192 },
    } as const;
    const [left, right] = await Promise.all([instance('a').governor.admit(input), instance('b').governor.admit(input)]);
    if (left.kind !== 'queued' || right.kind !== 'queued') throw new Error('expected queued receipts');

    expect(left.receipt.receiptId).toMatch(/^RG-/);
    expect(right.receipt.receiptId).toBe(left.receipt.receiptId);
    const [ledger, workItems, latch] = await Promise.all([
      db.sql<Array<{ receipt_id: string; state: string }>>`
        SELECT receipt_id, state
          FROM harness_shared.resource_governor_admissions
         WHERE workspace_id = 'ws-ledger'`,
      db.sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count
          FROM harness_shared.work_items
         WHERE workspace_id = 'ws-ledger'`,
      db.sql<Array<{ value: string }>>`
        SELECT value
          FROM harness_shared.operator_settings
         WHERE key = 'resource_governor_admission_ledger_cutover:ws-ledger'`,
    ]);
    expect(ledger).toEqual([{ receipt_id: left.receipt.receiptId, state: 'queued' }]);
    expect(workItems[0]).toEqual({ count: 0 });
    expect(latch[0]).toEqual({ value: '1' });
  });

  it('preserves targeted lease CAS, running, completion, and restart status', async () => {
    const producer = instance('producer');
    const admitted = await producer.governor.admit({
      idempotencyKey: 'exactly-once',
      admissionClass: 'process',
    });
    if (admitted.kind !== 'queued') throw new Error('expected queued receipt');

    const claim = await producer.driver.leaseReceipt({
      receiptId: admitted.receipt.receiptId,
      owner: 'worker-a',
      ttlMs: 5_000,
    });
    if (!claim) throw new Error('expected targeted lease');

    expect((await producer.driver.markRunning(claim.receiptId, 'stale-token'))?.changed).toBe(false);
    expect((await producer.driver.markRunning(claim.receiptId, claim.lease.leaseId))?.record.state).toBe('running');
    const completed = await producer.driver.complete(claim.receiptId, claim.lease.leaseId, 'result:ledger');
    expect(completed?.record).toMatchObject({ state: 'completed', resultRef: 'result:ledger' });
    expect(completed?.record).not.toHaveProperty('lease');
    await expect(instance('restart').governor.status('exactly-once')).resolves.toMatchObject({
      state: 'completed',
      receipt: { receiptId: admitted.receipt.receiptId },
      resultRef: 'result:ledger',
    });
  });

  it('persists latest-wins coalescing and cancellation without work-item projections', async () => {
    await instance('old').governor.admit({
      idempotencyKey: 'old',
      admissionClass: 'indexing',
      coalesceKey: 'index:main',
    });
    await instance('new').governor.admit({
      idempotencyKey: 'new',
      admissionClass: 'indexing',
      coalesceKey: 'index:main',
    });

    const reader = instance('reader');
    await expect(reader.governor.status('old')).resolves.toMatchObject({ state: 'superseded' });
    await expect(reader.governor.cancel('new', 'no longer needed')).resolves.toMatchObject({
      cancelled: true,
      state: 'cancelled',
    });
    const rows = await db.sql<Array<{ idempotency_key: string; state: string }>>`
      SELECT idempotency_key, state
        FROM harness_shared.resource_governor_admissions
       ORDER BY idempotency_key`;
    expect(rows).toEqual([
      { idempotency_key: 'new', state: 'cancelled' },
      { idempotency_key: 'old', state: 'superseded' },
    ]);
  });

  it('keeps supersession time monotonic when the newer request comes from a clock behind the prior receipt', async () => {
    await instance('old', { now: () => 20_000 }).governor.admit({
      idempotencyKey: 'old', admissionClass: 'indexing', coalesceKey: 'index:skew',
    });
    await instance('new', { now: () => 10_000 }).governor.admit({
      idempotencyKey: 'new', admissionClass: 'indexing', coalesceKey: 'index:skew',
    });
    const [old] = await db.sql<Array<{ state: string; enqueued_at_ms: number; updated_at_ms: number; record: {
      decision: { atMs: number };
    } }>>`
      SELECT state, enqueued_at_ms, updated_at_ms, record
        FROM harness_shared.resource_governor_admissions
       WHERE workspace_id = 'ws-ledger' AND idempotency_key = 'old'`;
    expect(old).toMatchObject({
      state: 'superseded', enqueued_at_ms: 20_000, updated_at_ms: 20_000,
      record: { decision: { atMs: 20_000 } },
    });
  });

  it('reads one complete queue census from the ledger plus bounded legacy overlap', async () => {
    const clock = { now: 100_000 };
    const legacyRecord = {
      schemaVersion: 1,
      namespace: 'integration',
      idempotencyKey: 'legacy-active',
      requestFingerprint: 'legacy-fingerprint',
      admissionClass: 'process',
      state: 'queued',
      priority: 1,
      enqueuedAtMs: clock.now - 1_000,
      updatedAtMs: clock.now - 1_000,
      deadlineAtMs: null,
      decision: { generation: 0, atMs: clock.now - 1_000, reason: 'legacy-fixture' },
    };
    await db.sql`
      INSERT INTO harness_shared.work_items (workspace_id, feature_id, payload)
      VALUES (
        'ws-ledger',
        'WI-legacy-active',
        ${JSON.stringify({ resource_governor: legacyRecord })}::text::jsonb
      )`;

    const current = instance('census', { now: () => clock.now });
    const active = await current.governor.admit({ idempotencyKey: 'ledger-active', admissionClass: 'agent' });
    const terminal = await current.governor.admit({ idempotencyKey: 'ledger-terminal', admissionClass: 'agent' });
    if (active.kind !== 'queued' || terminal.kind !== 'queued') throw new Error('expected ledger receipts');
    const claim = await current.driver.leaseReceipt({
      receiptId: terminal.receipt.receiptId,
      owner: 'census-worker',
      ttlMs: 1_000,
    });
    if (!claim) throw new Error('expected terminal fixture lease');
    await current.driver.complete(claim.receiptId, claim.lease.leaseId, 'result:census');

    await expect(current.store.readQueuePopulation(clock.now, 60_000)).resolves.toEqual([
      {
        admissionClass: 'agent',
        depth: 1,
        oldestAgeMs: 0,
        arrivals: 2,
        drained: 1,
        observedWindowMs: 60_000,
      },
      {
        admissionClass: 'process',
        depth: 1,
        oldestAgeMs: 1_000,
        arrivals: 1,
        drained: 0,
        observedWindowMs: 60_000,
      },
    ]);
  });

  it('reconciles lease expiry, deadlines, and deadline-less abandonment in bounded passes', async () => {
    const clock = { now: 20_000 };
    const primary = instance('primary', { now: () => clock.now });
    await primary.governor.admit({ idempotencyKey: 'lease', admissionClass: 'process' });
    const lease = await primary.driver.leaseNext({ owner: 'old-owner', ttlMs: 100 });
    if (!lease) throw new Error('expected lease');
    clock.now += 101;
    await expect(primary.store.reconcileExpiredAll(clock.now)).resolves.toEqual({
      requeued: 1,
      expired: 0,
      abandoned: 0,
      total: 1,
    });
    expect((await primary.store.find('integration', 'lease'))?.record).toMatchObject({
      state: 'queued',
      decision: { reason: 'lease-expired' },
    });

    await primary.governor.admit({
      idempotencyKey: 'deadline',
      admissionClass: 'inference',
      deadlineAtMs: clock.now + 10,
    });
    clock.now += 11;
    await expect(primary.store.reconcileExpiredAll(clock.now)).resolves.toMatchObject({ expired: 1 });
    expect((await primary.store.find('integration', 'deadline'))?.record.state).toBe('expired');

    const abandoned = instance('abandoned', {
      now: () => clock.now,
      workspaceId: 'ws-abandon',
      abandonAfterMs: 100,
    });
    await abandoned.governor.admit({
      idempotencyKey: 'no-deadline',
      admissionClass: 'agent',
    });
    clock.now += 101;
    await expect(abandoned.store.reconcileExpiredAll(clock.now)).resolves.toEqual({
      requeued: 0,
      expired: 0,
      abandoned: 1,
      total: 1,
    });
    expect((await abandoned.store.find('integration', 'no-deadline'))?.record).toMatchObject({
      state: 'expired',
      decision: { reason: 'abandoned-without-deadline' },
    });
  });
});

/**
 * P-006 (resource-governor-admission-ledger-2026-09-01) — the recurrence coverage
 * that used to live only against the legacy work-item store
 * (queue.integration.test.ts), re-pinned against the ledger so it survives the
 * P-005 / D-009 edge that deletes the legacy store and its suite. Every scenario
 * here asserts through the ledger's own generated columns, never through
 * work_items projections (D-003, D-005).
 */
describe('PgAdmissionLedgerQueueStore — ported legacy recurrence coverage (P-006)', () => {
  const LEDGER = 'harness_shared.resource_governor_admissions';

  async function ledgerRows(workspaceId = 'ws-ledger') {
    return db.sql<Array<{ idempotency_key: string; state: string; lease_owner: string | null; reason: string | null }>>`
      SELECT idempotency_key, state, lease_owner, record->'decision'->>'reason' AS reason
        FROM harness_shared.resource_governor_admissions
       WHERE workspace_id = ${workspaceId}
       ORDER BY idempotency_key`;
  }

  async function workItemCount(workspaceId = 'ws-ledger') {
    const rows = await db.sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM harness_shared.work_items WHERE workspace_id = ${workspaceId}`;
    return rows[0]?.count;
  }

  it('CONTROL: the fixture has no work-item id allocator, so an enqueue that allocated one would fail loudly', async () => {
    // The beforeAll fixture deliberately omits harness_shared.next_work_item_id() and
    // harness_shared.work_item_seq. That is what makes every `work_items count = 0`
    // assertion in this file non-vacuous: a ledger enqueue path that still reached for
    // the legacy allocator (D-003) would throw here instead of quietly succeeding.
    const [procs, seqs] = await Promise.all([
      db.sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'harness_shared' AND p.proname = 'next_work_item_id'`,
      db.sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'harness_shared' AND c.relname = 'work_item_seq' AND c.relkind = 'S'`,
    ]);
    expect(procs[0]).toEqual({ count: 0 });
    expect(seqs[0]).toEqual({ count: 0 });
  });

  // The admission classes production writers actually emit. Measured on the live
  // papercusp-workspace ledger 2026-09-01 (24h window): process 75,633 · embedding
  // 46,583 · inference 10,481 · transfer 144 · agent 1; `mcp` is the remaining
  // KnownAdmissionClass a live caller can pass. The matrix is a superset of the
  // plan's "four live classes" on purpose — a class that goes live later must not
  // fall outside it.
  const LIVE_CLASSES = ['process', 'embedding', 'inference', 'agent', 'transfer', 'mcp'] as const;

  it.each(LIVE_CLASSES)(
    'enqueues the %s class as an opaque RG receipt and never writes or allocates a work item',
    async (admissionClass) => {
      const key = `class-${admissionClass}`;
      const producer = instance(key);
      const admitted = await producer.governor.admit({
        idempotencyKey: key,
        admissionClass,
        // `inference` is the one live class that carries a deadline (WI-1741497 control shape).
        ...(admissionClass === 'inference' ? { deadlineAtMs: 10_000 + 60_000 } : {}),
      });
      if (admitted.kind !== 'queued') throw new Error(`expected queued ${admissionClass} receipt`);

      expect(admitted.receipt.receiptId).toMatch(
        /^RG-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(admitted.receipt.receiptId).not.toMatch(/^WI-/);
      const ledger = await db.sql<Array<{ receipt_id: string; admission_class: string; state: string }>>`
        SELECT receipt_id, admission_class, state
          FROM harness_shared.resource_governor_admissions
         WHERE workspace_id = 'ws-ledger'`;
      expect(ledger).toEqual([{ receipt_id: admitted.receipt.receiptId, admission_class: admissionClass, state: 'queued' }]);
      expect(await workItemCount()).toBe(0);
      await expect(instance('restart').governor.status(key)).resolves.toMatchObject({
        state: 'queued',
        receipt: { receiptId: admitted.receipt.receiptId },
      });
    },
  );

  it('rejects a conflicting replay of a persisted receipt after restart', async () => {
    const input = {
      idempotencyKey: 'restart-safe',
      admissionClass: 'build',
      priority: 4,
      demand: { cpuWeight: 20, memoryBytes: 8_192 },
      payloadRef: 'work-item:WI-parent',
    } as const;
    const admitted = await instance('first').governor.admit(input);
    if (admitted.kind !== 'queued') throw new Error('expected queued receipt');

    const restarted = instance('restart');
    await expect(restarted.governor.status('restart-safe')).resolves.toMatchObject({
      state: 'queued',
      receipt: { receiptId: admitted.receipt.receiptId },
    });
    await expect(restarted.governor.admit({ ...input, priority: 5 })).rejects.toBeInstanceOf(
      AdmissionIdempotencyConflictError,
    );
    expect(await ledgerRows()).toEqual([
      { idempotency_key: 'restart-safe', state: 'queued', lease_owner: null, reason: 'persisted' },
    ]);
    expect(await workItemCount()).toBe(0);
  });

  it('grants exactly one lease when concurrent workers race leaseNext for one receipt', async () => {
    await instance('producer').governor.admit({ idempotencyKey: 'once', admissionClass: 'process', priority: 2 });

    const a = instance('worker-a');
    const b = instance('worker-b');
    const claims = await Promise.all([
      a.driver.leaseNext({ owner: 'worker-a', ttlMs: 5_000 }),
      b.driver.leaseNext({ owner: 'worker-b', ttlMs: 5_000 }),
    ]);
    const winners = claims.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    const winner = winners[0]!;

    const row = await db.sql<Array<{ lease_owner: string | null; state: string }>>`
      SELECT lease_owner, state FROM harness_shared.resource_governor_admissions
       WHERE workspace_id = 'ws-ledger' AND receipt_id = ${winner.receiptId}`;
    expect(row[0]).toEqual({ lease_owner: winner.lease.owner, state: 'leased' });

    expect((await a.driver.markRunning(winner.receiptId, 'stale-lease'))?.changed).toBe(false);
    const owner = winner.lease.owner === 'worker-a' ? a.driver : b.driver;
    expect((await owner.markRunning(winner.receiptId, winner.lease.leaseId))?.record.state).toBe('running');
    expect((await owner.complete(winner.receiptId, winner.lease.leaseId, 'result:durable'))?.record.state).toBe(
      'completed',
    );
    await expect(instance('reader').governor.status('once')).resolves.toMatchObject({
      state: 'completed',
      resultRef: 'result:durable',
    });
    expect(await workItemCount()).toBe(0);
  });

  it('leases only the targeted receipt and refuses a second owner for it', async () => {
    const producer = instance('producer');
    const first = await producer.governor.admit({ idempotencyKey: 'target-first', admissionClass: 'agent' });
    const second = await producer.governor.admit({ idempotencyKey: 'target-second', admissionClass: 'agent' });
    if (first.kind !== 'queued' || second.kind !== 'queued') throw new Error('expected queued receipts');

    const restarted = instance('targeted-worker');
    const claim = await restarted.driver.leaseReceipt({
      receiptId: second.receipt.receiptId,
      owner: 'targeted-worker',
      ttlMs: 5_000,
    });
    expect(claim).toMatchObject({
      receiptId: second.receipt.receiptId,
      record: { idempotencyKey: 'target-second', state: 'leased' },
      lease: { owner: 'targeted-worker' },
    });
    expect(await ledgerRows()).toEqual([
      { idempotency_key: 'target-first', state: 'queued', lease_owner: null, reason: 'persisted' },
      {
        idempotency_key: 'target-second',
        state: 'leased',
        lease_owner: 'targeted-worker',
        reason: 'observe-only-targeted-lease',
      },
    ]);
    expect(
      await restarted.driver.leaseReceipt({
        receiptId: second.receipt.receiptId,
        owner: 'other-worker',
        ttlMs: 5_000,
      }),
    ).toBeNull();
  });

  it('cancels idempotently across restart — the second cancel reports the settled state without mutating it', async () => {
    await instance('first').governor.admit({ idempotencyKey: 'cancel-me', admissionClass: 'process' });
    await expect(instance('second').governor.cancel('cancel-me', 'no longer needed')).resolves.toMatchObject({
      cancelled: true,
      state: 'cancelled',
    });
    await expect(instance('third').governor.cancel('cancel-me')).resolves.toMatchObject({
      cancelled: false,
      state: 'cancelled',
    });
    expect(await ledgerRows()).toMatchObject([{ idempotency_key: 'cancel-me', state: 'cancelled', lease_owner: null }]);
  });

  it('reclaims an expired lease for a new owner, rejects the stale token, and expires overdue queued work', async () => {
    const clock = { now: 20_000 };
    const producer = instance('producer', { now: () => clock.now });
    await producer.governor.admit({ idempotencyKey: 'lease-expiry', admissionClass: 'transfer' });

    const first = await producer.driver.leaseNext({ owner: 'worker-old', ttlMs: 100 });
    if (!first) throw new Error('expected first lease');
    clock.now += 101;

    const replacement = instance('replacement', { now: () => clock.now });
    const second = await replacement.driver.leaseNext({ owner: 'worker-new', ttlMs: 100 });
    expect(second).toMatchObject({ receiptId: first.receiptId, lease: { owner: 'worker-new' } });
    expect(second!.lease.generation).toBeGreaterThan(first.lease.generation);
    expect((await producer.driver.markRunning(first.receiptId, first.lease.leaseId))?.changed).toBe(false);
    expect((await replacement.driver.markRunning(first.receiptId, second!.lease.leaseId))?.record.state).toBe(
      'running',
    );

    await producer.governor.admit({
      idempotencyKey: 'deadline',
      admissionClass: 'build',
      deadlineAtMs: clock.now + 10,
    });
    clock.now += 11;
    expect(await replacement.driver.leaseNext({ owner: 'worker-new', ttlMs: 100 })).toBeNull();
    await expect(instance('reader', { now: () => clock.now }).governor.status('deadline')).resolves.toMatchObject({
      state: 'expired',
    });
  });

  it('reconciles an expired running receipt before a targeted lease in the same namespace', async () => {
    const clock = { now: 30_000 };
    const producer = instance('producer', { now: () => clock.now });
    const first = await producer.governor.admit({ idempotencyKey: 'target-expired-running', admissionClass: 'inference' });
    const second = await producer.governor.admit({ idempotencyKey: 'target-next', admissionClass: 'inference' });
    if (first.kind !== 'queued' || second.kind !== 'queued') throw new Error('expected queued receipts');

    const oldClaim = await producer.driver.leaseReceipt({
      receiptId: first.receipt.receiptId,
      owner: 'worker-old',
      ttlMs: 100,
    });
    if (!oldClaim) throw new Error('expected old targeted lease');
    await producer.driver.markRunning(oldClaim.receiptId, oldClaim.lease.leaseId);
    clock.now += 101;

    const nextClaim = await instance('replacement', { now: () => clock.now }).driver.leaseReceipt({
      receiptId: second.receipt.receiptId,
      owner: 'worker-new',
      ttlMs: 100,
    });
    expect(nextClaim).toMatchObject({ receiptId: second.receipt.receiptId, lease: { owner: 'worker-new' } });
    expect(await ledgerRows()).toEqual([
      { idempotency_key: 'target-expired-running', state: 'queued', lease_owner: null, reason: 'lease-expired' },
      { idempotency_key: 'target-next', state: 'leased', lease_owner: 'worker-new', reason: 'observe-only-targeted-lease' },
    ]);
  });

  it('drives an orphaned deadline-less running receipt terminal once the dwell passes (WI-1741497)', async () => {
    // Against real Postgres because the abandonment predicate IS SQL (deadline_at_ms IS NULL
    // AND updated_at_ms <= now - dwell): a TypeScript mirror cannot prove it.
    const clock = { now: 40_000 };
    const dwellMs = 60_000;
    const orphan = instance('orphan', { now: () => clock.now, workspaceId: 'ws-orphan', abandonAfterMs: dwellMs });

    // An `agent` admission never sets deadlineAtMs — the shape of the immortal live rows.
    const admitted = await orphan.governor.admit({ idempotencyKey: 'orphaned-agent-spawn', admissionClass: 'agent' });
    if (admitted.kind !== 'queued') throw new Error('expected queued receipt');
    const claim = await orphan.driver.leaseReceipt({
      receiptId: admitted.receipt.receiptId,
      owner: 'spawner-that-dies',
      ttlMs: 100,
    });
    if (!claim) throw new Error('expected targeted lease');
    await orphan.driver.markRunning(claim.receiptId, claim.lease.leaseId);

    // The spawner dies: nothing ever releases. The lease lapses and reconciliation requeues it.
    clock.now += 101;
    await expect(orphan.store.reconcileExpiredAll(clock.now)).resolves.toEqual({
      requeued: 1,
      expired: 0,
      abandoned: 0,
      total: 1,
    });
    expect(await ledgerRows('ws-orphan')).toEqual([
      { idempotency_key: 'orphaned-agent-spawn', state: 'queued', lease_owner: null, reason: 'lease-expired' },
    ]);

    // Inside the dwell nothing happens — the requeue reset the updated_at_ms clock.
    clock.now += dwellMs - 1;
    await expect(orphan.store.reconcileExpiredAll(clock.now)).resolves.toMatchObject({ abandoned: 0 });

    // Past it the floor fires: terminal state, terminal reason, no lease left behind.
    clock.now += 2;
    await expect(orphan.store.reconcileExpiredAll(clock.now)).resolves.toEqual({
      requeued: 0,
      expired: 0,
      abandoned: 1,
      total: 1,
    });
    expect(await ledgerRows('ws-orphan')).toEqual([
      {
        idempotency_key: 'orphaned-agent-spawn',
        state: 'expired',
        lease_owner: null,
        reason: 'abandoned-without-deadline',
      },
    ]);
    await expect(orphan.governor.status('orphaned-agent-spawn')).resolves.toMatchObject({ state: 'expired' });
  });

  it('CONTROL: a deadline-bearing receipt is never touched by the abandonment floor (WI-1741497)', async () => {
    const clock = { now: 40_000 };
    const dwellMs = 60_000;
    const control = instance('deadline-control', {
      now: () => clock.now,
      workspaceId: 'ws-orphan',
      abandonAfterMs: dwellMs,
    });
    const admitted = await control.governor.admit({
      idempotencyKey: 'inference-with-deadline',
      admissionClass: 'inference',
      deadlineAtMs: clock.now + dwellMs * 10,
    });
    if (admitted.kind !== 'queued') throw new Error('expected queued receipt');

    clock.now += dwellMs * 2;
    await expect(control.store.reconcileExpiredAll(clock.now)).resolves.toEqual({
      requeued: 0,
      expired: 0,
      abandoned: 0,
      total: 0,
    });
    await expect(control.governor.status('inference-with-deadline')).resolves.toMatchObject({ state: 'queued' });

    // Once its own deadline passes it terminates through the DEADLINE branch, not the floor.
    clock.now += dwellMs * 10;
    await expect(control.store.reconcileExpiredAll(clock.now)).resolves.toEqual({
      requeued: 0,
      expired: 1,
      abandoned: 0,
      total: 1,
    });
    expect(await ledgerRows('ws-orphan')).toMatchObject([
      { idempotency_key: 'inference-with-deadline', state: 'expired', lease_owner: null },
    ]);
  });

  it('persists nested receipt lineage and exact actual-cost release across restart', async () => {
    const clock = { now: 40_000 };
    const producer = instance('producer', { now: () => clock.now });
    const parent = await producer.governor.admit({
      idempotencyKey: 'lineage-parent',
      admissionClass: 'agent',
      demand: { cpuWeight: 2 },
    });
    const child = await producer.governor.admit({
      idempotencyKey: 'lineage-child',
      admissionClass: 'database',
      demand: { databaseConnections: 1 },
      parent: parent.context,
    });
    const parentReceiptId = parent.context.receiptId;
    const childReceiptId = child.context.receiptId;
    if (!parentReceiptId || !childReceiptId) throw new Error('expected receipt ids on both admission contexts');
    expect(childReceiptId).toMatch(/^RG-/);
    expect(childReceiptId).not.toBe(parentReceiptId);
    expect(child.context).toMatchObject({ receiptId: childReceiptId, parentReceiptId });

    const childClaim = await producer.driver.leaseReceipt({
      receiptId: childReceiptId,
      owner: 'worker',
      ttlMs: 1_000,
    });
    if (!childClaim || childClaim.record.idempotencyKey !== 'lineage-child') throw new Error('expected child lease');
    clock.now += 10;
    await expect(producer.governor.release(childClaim.context, { databaseConnections: 3 })).resolves.toMatchObject({
      released: true,
    });
    await expect(producer.governor.release(childClaim.context, { databaseConnections: 4 })).resolves.toMatchObject({
      released: false,
    });

    const row = await db.sql<Array<{ state: string; lease_owner: string | null; record: Record<string, unknown> }>>`
      SELECT state, lease_owner, record
        FROM harness_shared.resource_governor_admissions
       WHERE workspace_id = 'ws-ledger' AND receipt_id = ${childReceiptId}`;
    expect(row[0]).toMatchObject({ state: 'completed', lease_owner: null });
    expect(row[0]?.record).toMatchObject({
      state: 'completed',
      actualDemand: { databaseConnections: 3 },
      releasedAtMs: clock.now,
      decision: { reason: 'resources-released' },
      context: { parentReceiptId, parentRequestId: 'producer-request-1' },
    });
    expect(row[0]?.record).not.toHaveProperty('lease');
    await expect(instance('reader', { now: () => clock.now }).governor.status('lineage-child')).resolves.toMatchObject({
      state: 'completed',
      context: {
        receiptId: childReceiptId,
        parentReceiptId,
        rootRequestId: 'producer-request-1',
      },
    });
    expect(await workItemCount()).toBe(0);
  });

  it('orders policy leases by class virtual time, then durable row scheduling evidence', async () => {
    const nowMs = 100_000;
    const enqueue = async (
      idempotencyKey: string,
      admissionClass: string,
      enqueuedAtMs: number,
      options: {
        priority?: number;
        deadlineAtMs?: number;
        demand?: { memoryBytes?: number; databaseConnections?: number };
      } = {},
    ) => {
      await instance(`producer-${idempotencyKey}`, { now: () => enqueuedAtMs }).governor.admit({
        idempotencyKey,
        admissionClass,
        ...options,
      });
    };

    await enqueue('agent-first-by-class-clock', 'agent', nowMs, { priority: 0 });
    await enqueue('build-released-affinity', 'build', nowMs, { demand: { databaseConnections: 1 } });
    await enqueue('build-deadline', 'build', nowMs, { deadlineAtMs: nowMs + 10_000 });
    await enqueue('build-aged', 'build', nowMs - 8_000);
    await enqueue('build-priority', 'build', nowMs, { priority: 7 });
    await enqueue('build-constrained', 'build', nowMs, { priority: 100, demand: { memoryBytes: 1 } });

    const worker = instance('policy-worker', { now: () => nowMs });
    const selection = {
      classes: [
        { admissionClass: 'agent', virtualTime: 0, weight: 1, constrainedResources: [] },
        { admissionClass: 'build', virtualTime: 10, weight: 1, constrainedResources: ['memory'] },
      ],
      releasedResources: ['database'],
      agingIntervalMs: 1_000,
      deadlineHorizonMs: 20_000,
      resourceAffinityBonus: 20,
      constrainedResourcePenalty: 200,
    } as const;

    const leased: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const claim = await worker.driver.leaseNext({ owner: 'policy-worker', ttlMs: 10_000, selection });
      if (!claim) throw new Error(`expected policy lease ${index + 1}`);
      leased.push(claim.record.idempotencyKey);
    }

    expect(leased).toEqual([
      'agent-first-by-class-clock',
      'build-released-affinity',
      'build-deadline',
      'build-aged',
      'build-priority',
      'build-constrained',
    ]);
    expect(await workItemCount()).toBe(0);
  });

  it(`never touches ${LEDGER.replace('resource_governor_admissions', 'work_items')} on any enqueue path`, async () => {
    // Belt-and-braces over the per-class matrix: a whole burst of mixed-class admissions,
    // coalesced supersession, cancellation, and a nested child all land in the ledger only.
    const producer = instance('burst');
    await Promise.all(
      LIVE_CLASSES.map((admissionClass, index) =>
        producer.governor.admit({
          idempotencyKey: `burst-${admissionClass}`,
          admissionClass,
          coalesceKey: index % 2 === 0 ? 'burst:even' : undefined,
        }),
      ),
    );
    await producer.governor.cancel('burst-agent');
    const parent = await producer.governor.admit({ idempotencyKey: 'burst-parent', admissionClass: 'process' });
    await producer.governor.admit({
      idempotencyKey: 'burst-child',
      admissionClass: 'database',
      parent: parent.context,
    });

    const [ledgerCount, workItems] = await Promise.all([
      db.sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM harness_shared.resource_governor_admissions WHERE workspace_id = 'ws-ledger'`,
      db.sql<Array<{ count: number }>>`SELECT count(*)::int AS count FROM harness_shared.work_items`,
    ]);
    expect(ledgerCount[0]).toEqual({ count: LIVE_CLASSES.length + 2 });
    expect(workItems[0]).toEqual({ count: 0 });
  });
});
