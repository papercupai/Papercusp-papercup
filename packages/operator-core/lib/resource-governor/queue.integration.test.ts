/**
 * P-003 recurrence guard against real Postgres. Proves that canonical
 * work_items persistence, the partial unique identity index, and row locking
 * provide restart-safe receipts and exclusive execution leases.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../test/_work-items-schema';
import { OrgTxnTimeoutError } from '../pg-bounded-txn';
import { AdmissionIdempotencyConflictError, Governor } from './admission';
import { PgWorkItemAdmissionQueueStore, WorkItemAdmissionQueueDriver } from './queue';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(__dirname, '../../../../libs/papercusp/libs/db/sql/986-resource-governor-work-item-queue-identity.sql'),
  'utf8',
);

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('resource-governor-queue');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL).simple();
  await db.sql.unsafe(migration).simple();
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items`;
  await db.sql`ALTER SEQUENCE harness_shared.work_item_seq RESTART WITH 1`;
});

/**
 * Pin the owner-liveness enrichment leg (WI-2141150).
 *
 * This file's subject is durable receipt persistence and exclusive leasing — NOT
 * liveness. `PgWorkItemAdmissionQueueStore` resolves owner-death lease reclamation
 * through `resolveSessionStatesFn ?? (await import('.../liveness-oracle')).resolveSessionStates`,
 * so a store handed this file's ISOLATED `db.sql` still falls through to the REAL
 * global oracle: the injected client scopes the queue reads, but not the liveness
 * read. Verdicts about these synthetic owners ('targeted-worker', ...) are then
 * decided from global state, and `selectEndedLeaseOwners` requeues the leases under
 * test as 'owner-ended' — bumping `decision.generation`/`updatedAtMs` and changing
 * lease and ordering outcomes. That silently reddened 6 of these 12 cases between
 * 2026-08-31T20:14Z and 2026-09-02T07:09Z with the test file itself unchanged.
 *
 * Returning no verdicts means no owner is ever classified `ended`, so the
 * reclamation leg is inert and the lease semantics under test are deterministic.
 * A test of X must pin everything that is not X; same seam and `as never` idiom as
 * reconcile-escalations.reroute.integration.test.ts.
 */
const pinNoEndedOwners = (async () => new Map()) as never;

function instance(label: string, now = () => 10_000) {
  let requestNo = 0;
  let leaseNo = 0;
  const store = new PgWorkItemAdmissionQueueStore({
    sql: db.sql,
    workspaceId: 'ws-governor',
    resolveSessionStatesFn: pinNoEndedOwners,
  });
  const driver = new WorkItemAdmissionQueueDriver(store, {
    namespace: 'integration',
    now,
    leaseIdFactory: () => `${label}-lease-${++leaseNo}`,
  });
  return {
    store,
    driver,
    governor: new Governor(driver, { now, idFactory: () => `${label}-request-${++requestNo}` }),
  };
}

describe('PgWorkItemAdmissionQueueStore', () => {
  it('keeps the original goal observation on durable replay after a new population measurement', async () => {
    const input = { idempotencyKey: 'observed-agent', admissionClass: 'agent',
      metadata: { goalId: 'goal', fleetSlug: 'fleet', targetOwnerId: 'target', goalReservation: true,
        goalAdmission: JSON.stringify({ measuredAt: 'first', headcount: 1 }) } };
    const first = await instance('first').governor.admit(input);
    const retry = await instance('retry').governor.admit({ ...input, metadata: { ...input.metadata,
      goalAdmission: JSON.stringify({ measuredAt: 'retry', headcount: 2 }) } });
    expect(retry).toEqual(first);
    const rows = await db.sql<Array<{ payload: any }>>`SELECT payload FROM harness_shared.work_items`;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.resource_governor.metadata.goalAdmission).toBe(input.metadata.goalAdmission);
    expect(retry.context.metadata?.goalAdmission).toBe(input.metadata.goalAdmission);
    await expect(instance('changed-target').governor.admit({ ...input,
      metadata: { ...input.metadata, targetOwnerId: 'other-target' } }))
      .rejects.toBeInstanceOf(AdmissionIdempotencyConflictError);
  });

  it('concurrent process instances converge on one durable receipt and reject conflicting replay', async () => {
    const a = instance('a');
    const b = instance('b');
    const input = {
      idempotencyKey: 'restart-safe',
      admissionClass: 'build',
      priority: 4,
      demand: { cpuWeight: 20, memoryBytes: 8_192 },
      payloadRef: 'work-item:WI-parent',
    } as const;

    const [left, right] = await Promise.all([a.governor.admit(input), b.governor.admit(input)]);
    expect(left).toMatchObject({ kind: 'queued', receipt: { receiptId: 'WI-1' } });
    expect(right).toMatchObject({ kind: 'queued', receipt: { receiptId: 'WI-1' } });

    const rows = await db.sql<
      Array<{ feature_id: string; status: string; taken_by: string | null; payload: Record<string, unknown> }>
    >`SELECT feature_id, status, taken_by, payload FROM harness_shared.work_items`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ feature_id: 'WI-1', status: 'open', taken_by: null });
    expect(rows[0].payload).toMatchObject({
      _claimHold: true,
      claim_hold_by: 'system:resource-governor',
      resource_governor: { idempotencyKey: 'restart-safe', state: 'queued' },
    });

    const restarted = instance('restart');
    await expect(restarted.governor.status('restart-safe')).resolves.toMatchObject({
      state: 'queued',
      receipt: { receiptId: 'WI-1' },
    });
    await expect(restarted.governor.admit({ ...input, priority: 5 })).rejects.toBeInstanceOf(
      AdmissionIdempotencyConflictError,
    );
  });

  it('uses canonical taken_by ownership so only one concurrent worker receives a lease', async () => {
    const producer = instance('producer');
    await producer.governor.admit({ idempotencyKey: 'once', admissionClass: 'process', priority: 2 });

    const a = instance('worker-a');
    const b = instance('worker-b');
    const claims = await Promise.all([
      a.driver.leaseNext({ owner: 'worker-a', ttlMs: 5_000 }),
      b.driver.leaseNext({ owner: 'worker-b', ttlMs: 5_000 }),
    ]);
    const winners = claims.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    const winner = winners[0]!;

    const row = await db.sql<Array<{ taken_by: string | null; state: string }>>`
      SELECT taken_by, payload->'resource_governor'->>'state' AS state
        FROM harness_shared.work_items WHERE feature_id = ${winner.receiptId}`;
    expect(row[0]).toEqual({ taken_by: winner.lease.owner, state: 'leased' });

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
  });

  it('leases only the targeted durable receipt before execution starts', async () => {
    const producer = instance('producer');
    const first = await producer.governor.admit({
      idempotencyKey: 'target-first',
      admissionClass: 'agent',
    });
    const second = await producer.governor.admit({
      idempotencyKey: 'target-second',
      admissionClass: 'agent',
    });
    if (first.kind !== 'queued' || second.kind !== 'queued') throw new Error('expected durable queued receipts');

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

    const rows = await db.sql<Array<{ feature_id: string; state: string; taken_by: string | null }>>`
      SELECT feature_id, payload->'resource_governor'->>'state' AS state, taken_by
        FROM harness_shared.work_items
       ORDER BY feature_id`;
    expect(rows).toEqual([
      { feature_id: first.receipt.receiptId, state: 'queued', taken_by: null },
      { feature_id: second.receipt.receiptId, state: 'leased', taken_by: 'targeted-worker' },
    ]);
    expect(
      await restarted.driver.leaseReceipt({
        receiptId: second.receipt.receiptId,
        owner: 'other-worker',
        ttlMs: 5_000,
      }),
    ).toBeNull();
  });

  it('persists cancellation and latest-wins coalescing across driver restart', async () => {
    const first = instance('first');
    await first.governor.admit({
      idempotencyKey: 'old',
      admissionClass: 'indexing',
      coalesceKey: 'index:main',
    });
    await instance('second').governor.admit({
      idempotencyKey: 'new',
      admissionClass: 'indexing',
      coalesceKey: 'index:main',
    });

    const restarted = instance('restart');
    await expect(restarted.governor.status('old')).resolves.toMatchObject({ state: 'superseded' });
    await expect(restarted.governor.cancel('new', 'no longer needed')).resolves.toMatchObject({
      cancelled: true,
      state: 'cancelled',
    });
    await expect(instance('reader').governor.cancel('new')).resolves.toMatchObject({
      cancelled: false,
      state: 'cancelled',
    });
  });

  it('attributes a real PostgreSQL statement timeout during cancellation to the terminal UPDATE', async () => {
    const first = instance('cancel-phase');
    await first.governor.admit({ idempotencyKey: 'real-pg-cancel-phase', admissionClass: 'agent' });

    await db.sql.unsafe(`
      CREATE OR REPLACE FUNCTION harness_shared.pause_governor_cancel_probe()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.payload->'resource_governor'->>'state' = 'cancelled' THEN
          PERFORM pg_sleep(20);
        END IF;
        RETURN NEW;
      END;
      $$`).simple();
    await db.sql.unsafe(`
      CREATE TRIGGER pause_governor_cancel_probe
      BEFORE UPDATE ON harness_shared.work_items
      FOR EACH ROW EXECUTE FUNCTION harness_shared.pause_governor_cancel_probe()`).simple();

    try {
      const startedAt = Date.now();
      let timeout: unknown;
      try {
        await first.governor.cancel('real-pg-cancel-phase', 'integration probe');
      } catch (error) {
        timeout = error;
      }

      expect(timeout).toBeInstanceOf(OrgTxnTimeoutError);
      expect(timeout).toMatchObject({ pgCode: '57014' });
      expect((timeout as Error).message).toContain(
        '[phase: resource-governor.cancel.terminal-update]',
      );
    } finally {
      await db.sql.unsafe('DROP TRIGGER IF EXISTS pause_governor_cancel_probe ON harness_shared.work_items').simple();
      await db.sql.unsafe('DROP FUNCTION IF EXISTS harness_shared.pause_governor_cancel_probe()').simple();
    }
  }, 30_000);

  it('reclaims an expired lease, rejects its stale token, and expires overdue queued work', async () => {
    const clock = { now: 20_000 };
    const producer = instance('producer', () => clock.now);
    await producer.governor.admit({ idempotencyKey: 'lease-expiry', admissionClass: 'transfer' });

    const first = await producer.driver.leaseNext({ owner: 'worker-old', ttlMs: 100 });
    if (!first) throw new Error('expected first lease');
    clock.now += 101;

    const replacement = instance('replacement', () => clock.now);
    const second = await replacement.driver.leaseNext({ owner: 'worker-new', ttlMs: 100 });
    expect(second).toMatchObject({ receiptId: first.receiptId, lease: { owner: 'worker-new', generation: 3 } });
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
    await expect(instance('reader', () => clock.now).governor.status('deadline')).resolves.toMatchObject({
      state: 'expired',
    });
  });

  it('reconciles an expired running receipt before a targeted lease in the same namespace', async () => {
    const clock = { now: 30_000 };
    const producer = instance('producer', () => clock.now);
    const first = await producer.governor.admit({
      idempotencyKey: 'target-expired-running',
      admissionClass: 'inference',
    });
    const second = await producer.governor.admit({
      idempotencyKey: 'target-next',
      admissionClass: 'inference',
    });
    if (first.kind !== 'queued' || second.kind !== 'queued') throw new Error('expected queued receipts');

    const oldClaim = await producer.driver.leaseReceipt({
      receiptId: first.receipt.receiptId,
      owner: 'worker-old',
      ttlMs: 100,
    });
    if (!oldClaim) throw new Error('expected old targeted lease');
    await producer.driver.markRunning(oldClaim.receiptId, oldClaim.lease.leaseId);
    clock.now += 101;

    const nextClaim = await instance('replacement', () => clock.now).driver.leaseReceipt({
      receiptId: second.receipt.receiptId,
      owner: 'worker-new',
      ttlMs: 100,
    });
    expect(nextClaim).toMatchObject({ receiptId: second.receipt.receiptId, lease: { owner: 'worker-new' } });

    const rows = await db.sql<Array<{ feature_id: string; state: string; taken_by: string | null; reason: string }>>`
      SELECT feature_id,
             payload->'resource_governor'->>'state' AS state,
             taken_by,
             payload->'resource_governor'->'decision'->>'reason' AS reason
        FROM harness_shared.work_items
       WHERE feature_id IN (${first.receipt.receiptId}, ${second.receipt.receiptId})
       ORDER BY feature_id`;
    expect(rows).toEqual([
      { feature_id: first.receipt.receiptId, state: 'queued', taken_by: null, reason: 'lease-expired' },
      {
        feature_id: second.receipt.receiptId,
        state: 'leased',
        taken_by: 'worker-new',
        reason: 'observe-only-targeted-lease',
      },
    ]);
  });

  it('globally reconciles expired leases for idle namespaces without selecting work', async () => {
    const clock = { now: 40_000 };
    const first = instance('first', () => clock.now);
    const admitted = await first.governor.admit({
      idempotencyKey: 'idle-expired-running',
      admissionClass: 'inference',
    });
    if (admitted.kind !== 'queued') throw new Error('expected queued receipt');
    const claim = await first.driver.leaseReceipt({
      receiptId: admitted.receipt.receiptId,
      owner: 'idle-worker',
      ttlMs: 100,
    });
    if (!claim) throw new Error('expected idle targeted lease');
    await first.driver.markRunning(claim.receiptId, claim.lease.leaseId);
    clock.now += 101;

    await expect(first.store.reconcileExpiredAll(clock.now)).resolves.toEqual({
      requeued: 1,
      expired: 0,
      abandoned: 0,
      total: 1,
    });
    await expect(first.governor.status('idle-expired-running')).resolves.toMatchObject({ state: 'queued' });
    const rows = await db.sql<Array<{ taken_by: string | null }>>`
      SELECT taken_by FROM harness_shared.work_items WHERE feature_id = ${admitted.receipt.receiptId}`;
    expect(rows[0]).toEqual({ taken_by: null });
  });

  it('drives an orphaned deadline-less receipt terminal once the dwell passes (WI-1741497)', async () => {
    // Against real Postgres, because the abandonment predicate IS SQL: the jsonb_typeof
    // COALESCE guard and the `updatedAtMs` dwell cannot be proven by a TypeScript mirror.
    const clock = { now: 40_000 };
    const dwellMs = 60_000;
    const store = new PgWorkItemAdmissionQueueStore({
      sql: db.sql,
      workspaceId: 'ws-governor',
      abandonAfterMs: dwellMs,
      resolveSessionStatesFn: pinNoEndedOwners,
    });
    const first = instance('abandon', () => clock.now);

    // An `agent` admission — a class that never sets deadlineAtMs, so the payload key
    // is written as JSON null. This is the shape of the 1,509 immortal live rows.
    const admitted = await first.governor.admit({
      idempotencyKey: 'orphaned-agent-spawn',
      admissionClass: 'agent',
    });
    if (admitted.kind !== 'queued') throw new Error('expected queued receipt');
    const claim = await first.driver.leaseReceipt({
      receiptId: admitted.receipt.receiptId,
      owner: 'spawner-that-dies',
      ttlMs: 100,
    });
    if (!claim) throw new Error('expected targeted lease');
    await first.driver.markRunning(claim.receiptId, claim.lease.leaseId);

    // The spawning process dies: nothing ever calls release(). The lease lapses and
    // reconciliation requeues it — correctly, and into the state that used to be a dead end.
    clock.now += 101;
    await expect(store.reconcileExpiredAll(clock.now)).resolves.toEqual({
      requeued: 1,
      expired: 0,
      abandoned: 0,
      total: 1,
    });
    const requeued = await db.sql<Array<{ state: string; status: string; reason: string; hold: string | null }>>`
      SELECT payload->'resource_governor'->>'state' AS state,
             status,
             payload->'resource_governor'->'decision'->>'reason' AS reason,
             payload->>'_claimHold' AS hold
        FROM harness_shared.work_items WHERE feature_id = ${admitted.receipt.receiptId}`;
    expect(requeued[0]).toEqual({ state: 'queued', status: 'open', reason: 'lease-expired', hold: 'true' });

    // Inside the dwell, nothing happens — the requeue reset the clock.
    clock.now += dwellMs - 1;
    await expect(store.reconcileExpiredAll(clock.now)).resolves.toMatchObject({ abandoned: 0 });

    // Past it, the floor fires: terminal state, terminal status, and the claim-hold keys
    // stripped so the row stops being parked. Only now is it eligible for receipt-gc,
    // whose "an ACTIVE receipt is never aged out" control stays true throughout.
    clock.now += 2;
    await expect(store.reconcileExpiredAll(clock.now)).resolves.toEqual({
      requeued: 0,
      expired: 0,
      abandoned: 1,
      total: 1,
    });
    const swept = await db.sql<Array<{ state: string; status: string; reason: string; hold: string | null }>>`
      SELECT payload->'resource_governor'->>'state' AS state,
             status,
             payload->'resource_governor'->'decision'->>'reason' AS reason,
             payload->>'_claimHold' AS hold
        FROM harness_shared.work_items WHERE feature_id = ${admitted.receipt.receiptId}`;
    expect(swept[0]).toEqual({
      state: 'expired',
      status: 'dropped',
      reason: 'abandoned-without-deadline',
      hold: null,
    });
  });

  it('CONTROL: a deadline-bearing receipt is never touched by the abandonment floor (WI-1741497)', async () => {
    // The live `inference` class, which DOES set deadlineAtMs — the healthy control that
    // appeared inside the measured population. Its terminal exit is the deadline branch,
    // and the abandonment floor must leave it alone until that deadline actually passes.
    const clock = { now: 40_000 };
    const dwellMs = 60_000;
    const store = new PgWorkItemAdmissionQueueStore({
      sql: db.sql,
      workspaceId: 'ws-governor',
      abandonAfterMs: dwellMs,
      resolveSessionStatesFn: pinNoEndedOwners,
    });
    const first = instance('deadline-control', () => clock.now);
    const admitted = await first.governor.admit({
      idempotencyKey: 'inference-with-deadline',
      admissionClass: 'inference',
      deadlineAtMs: clock.now + dwellMs * 10,
    });
    if (admitted.kind !== 'queued') throw new Error('expected queued receipt');

    clock.now += dwellMs * 2;
    await expect(store.reconcileExpiredAll(clock.now)).resolves.toEqual({
      requeued: 0,
      expired: 0,
      abandoned: 0,
      total: 0,
    });
    await expect(first.governor.status('inference-with-deadline')).resolves.toMatchObject({ state: 'queued' });

    // Once its own deadline passes it terminates through the DEADLINE branch, not this one.
    clock.now += dwellMs * 10;
    await expect(store.reconcileExpiredAll(clock.now)).resolves.toEqual({
      requeued: 0,
      expired: 1,
      abandoned: 0,
      total: 1,
    });
  });

  it('persists nested receipt lineage and exact actual-cost release across restart', async () => {
    const clock = { now: 40_000 };
    const producer = instance('producer', () => clock.now);
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
    expect(child.context).toMatchObject({ receiptId: 'WI-2', parentReceiptId: 'WI-1' });

    await producer.driver.leaseNext({ owner: 'worker', ttlMs: 1_000 });
    const childClaim = await producer.driver.leaseNext({ owner: 'worker', ttlMs: 1_000 });
    if (!childClaim || childClaim.record.idempotencyKey !== 'lineage-child') throw new Error('expected child lease');
    clock.now += 10;
    await expect(producer.governor.release(childClaim.context, { databaseConnections: 3 })).resolves.toMatchObject({
      released: true,
    });
    await expect(producer.governor.release(childClaim.context, { databaseConnections: 4 })).resolves.toMatchObject({
      released: false,
    });

    const row = await db.sql<Array<{ record: Record<string, unknown> }>>`
      SELECT payload->'resource_governor' AS record
        FROM harness_shared.work_items
       WHERE feature_id = 'WI-2'`;
    expect(row[0]?.record).toMatchObject({
      state: 'completed',
      actualDemand: { databaseConnections: 3 },
      releasedAtMs: clock.now,
      context: { parentReceiptId: 'WI-1', parentRequestId: 'producer-request-1' },
    });
    await expect(instance('reader', () => clock.now).governor.status('lineage-child')).resolves.toMatchObject({
      state: 'completed',
      context: { receiptId: 'WI-2', parentReceiptId: 'WI-1', rootRequestId: 'producer-request-1' },
    });
  });

  it('clears the governor claim hold atomically when resources are released', async () => {
    const clock = { now: 50_000 };
    const producer = instance('release-hold', () => clock.now);
    const admitted = await producer.governor.admit({
      idempotencyKey: 'release-clears-claim-hold',
      admissionClass: 'inference',
      demand: { cpuWeight: 1 },
    });
    if (admitted.kind !== 'queued') throw new Error('expected queued receipt');

    const claim = await producer.driver.leaseNext({ owner: 'release-worker', ttlMs: 1_000 });
    if (!claim) throw new Error('expected governor lease');
    await producer.driver.markRunning(claim.receiptId, claim.lease.leaseId);
    clock.now += 10;

    await expect(producer.governor.release(claim.context, { cpuWeight: 2 })).resolves.toMatchObject({
      released: true,
    });

    const rows = await db.sql<
      Array<{
        status: string;
        taken_by: string | null;
        state: string;
        reason: string;
        claim_hold: string | null;
        claim_hold_by: string | null;
        claim_hold_reason: string | null;
      }>
    >`
      SELECT status,
             taken_by,
             payload->'resource_governor'->>'state' AS state,
             payload->'resource_governor'->'decision'->>'reason' AS reason,
             payload->>'_claimHold' AS claim_hold,
             payload->>'claim_hold_by' AS claim_hold_by,
             payload->>'claim_hold_reason' AS claim_hold_reason
        FROM harness_shared.work_items
       WHERE feature_id = ${claim.receiptId}`;
    expect(rows).toEqual([
      {
        status: 'done',
        taken_by: null,
        state: 'completed',
        reason: 'resources-released',
        claim_hold: null,
        claim_hold_by: null,
        claim_hold_reason: null,
      },
    ]);
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
      await instance(`producer-${idempotencyKey}`, () => enqueuedAtMs).governor.admit({
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

    const worker = instance('policy-worker', () => nowMs);
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
  });
});
