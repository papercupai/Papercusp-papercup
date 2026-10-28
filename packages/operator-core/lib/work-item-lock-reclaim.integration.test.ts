/**
 * Work-item reclaim + file-lock cleanup integration coverage.
 *
 * The work-item claim lives in the harness database while its file locks live
 * in papercusp_su. This test drives both real stores to prove the reclaim hook
 * releases only the reclaimed item's declared paths and lets a queued waiter
 * acquire the freed path through grant_cascade. A second case covers the
 * goal_ref association used when the reclaimed item declared no paths.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// WI-6554700010029304: the reaper records fallback decisions via observeFallback, whose
// deferred flush opens the protected live org-admin pool (WI-10006585 rail), which warns
// and fails this suite under vitest-fail-on-console. Stub the observer exactly as the
// sibling reaper suites do; this file asserts lock cleanup, not fallback telemetry.
vi.mock('./degradation/fallback-observations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./degradation/fallback-observations')>()),
  observeFallback: vi.fn(() => true),
}));
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { EVENT_AWAITS_LIVENESS_MIN_DDL, HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';
import {
  ensureBootstrap,
  getTxPool,
  readQueue,
  readWaiterStatus,
  tryAcquire,
  tryInsertWaiter,
  tryRelease,
  _resetForTests,
  normalizePaths,
} from './agent-tools/locks/su-lock-store';
import { inWorkspaceTxn } from './agent-tools/locks/in-workspace-txn';
import { readWorkItemPaths } from './work-items-release-request';
import { reclaimStaleWorkItemClaims } from './work-items-stale-claims';

const PRESENCE_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.coord_presence (
    owner_id text PRIMARY KEY,
    heartbeat_at timestamptz
  )`;
const SPAWNED_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY,
    session_owner text,
    run_id text,
    status text NOT NULL,
    heartbeat_at timestamptz,
    finished_at timestamptz,
    cancelled_at timestamptz
  )`;
const AGENT_ACTIVITY_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.agent_activity (
    id BIGSERIAL PRIMARY KEY,
    owner_id text NOT NULL,
    kind text NOT NULL,
    summary text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
const TOOL_INVOCATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.tool_invocations (
    id BIGSERIAL PRIMARY KEY,
    coord_owner_id text,
    invoked_at timestamptz NOT NULL DEFAULT now()
  )`;
const ROUTINES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.routines (
    id text PRIMARY KEY, target_owner_id text,
    reschedule_interval_sec integer, active boolean NOT NULL DEFAULT true
  )`;

const WORKSPACE_ID = 'default';
const HARNESS = 'papercup';
const SUITE_PREFIX = `work-item-lock-reclaim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let db: FreshPgDb;
let sql: postgres.Sql;
let sideDbLive = false;

async function checkSideDb(): Promise<boolean> {
  try {
    await ensureBootstrap();
    await getTxPool()`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  db = await createFreshPgDb();
  sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await sql.unsafe(PRESENCE_DDL);
  await sql.unsafe(SPAWNED_DDL);
  await sql.unsafe(AGENT_ACTIVITY_DDL);
  await sql.unsafe(TOOL_INVOCATIONS_DDL);
  await sql.unsafe(ROUTINES_DDL);
  await sql.unsafe(EVENT_AWAITS_LIVENESS_MIN_DDL); // warm-dead leg reads it (EI-27232210222510304)

  sideDbLive = await checkSideDb();
}, 120_000);

afterAll(async () => {
  if (sideDbLive) {
    try {
      const side = getTxPool();
      await side`DELETE FROM agent_file_locks WHERE coordination_domain LIKE ${SUITE_PREFIX + '%'}`;
      await side`DELETE FROM agent_lock_waiters WHERE coordination_domain LIKE ${SUITE_PREFIX + '%'}`;
    } catch {
      // The side database may already be unavailable during teardown.
    }
    await _resetForTests();
  }
  await db?.cleanup();
});

describe('work-item reclaim targeted lock cleanup', async () => {
  // Resolve this before `it.skipIf` is evaluated; a flag populated by
  // beforeAll is too late and would skip the case unconditionally.
  const live = await checkSideDb();

  it.skipIf(!live)('releases declared paths, preserves an undeclared path, and grants the waiter', async () => {
    const side = getTxPool();
    const coordinationDomain = `${SUITE_PREFIX}-domain`;
    const formerOwner = `${SUITE_PREFIX}-former-owner`;
    const successor = `${SUITE_PREFIX}-successor`;
    const itemId = `${SUITE_PREFIX}-item`;
    const targetPath = 'src/reclaimed-target.ts';
    const unrelatedPath = 'src/unrelated-concurrent-item.ts';

    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, status,
         taken_by, taken_at, created_ts, updated_ts, payload)
      VALUES
        (${WORKSPACE_ID}, ${HARNESS}, ${itemId}, 'feature', ${itemId}, 'todo',
         ${formerOwner}, now() - interval '30 minutes',
         ${Date.now() - 1_800_000}, ${Date.now() - 1_800_000},
         ${sql.json({ paths: [targetPath] })})
    `;
    // A stale presence row makes the holder locally known but dead to the
    // reclaim sweep; no fresh activity or nursery row is present.
    await sql`
      INSERT INTO harness_shared.coord_presence (owner_id, heartbeat_at)
      VALUES (${formerOwner}, now() - interval '30 minutes')
    `;
    const [seeded] = await sql<{ payload: unknown }[]>`
      SELECT payload FROM harness_shared.work_items WHERE feature_id = ${itemId}
    `;
    expect(readWorkItemPaths(seeded.payload)).toEqual([targetPath]);

    const held = await inWorkspaceTxn(coordinationDomain, formerOwner, (tx) =>
      tryAcquire(tx, {
        coordinationDomain,
        owner: formerOwner,
        ownerLabel: 'former owner',
        paths: normalizePaths([targetPath, unrelatedPath]),
        intent: 'concurrent work-item edits',
        ttlSec: 600,
      }),
    );
    expect(held.ok).toBe(true);
    if (!held.ok) throw new Error('failed to seed former-owner lock');

    const queued = await inWorkspaceTxn(coordinationDomain, successor, (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain,
        owner: successor,
        ownerLabel: 'successor',
        paths: [targetPath],
        intent: 'take over reclaimed item',
        ttlSec: 600,
        maxWaitSec: 60,
      }),
    );
    expect(queued.ok).toBe(true);
    if (!queued.ok || !('ticket_id' in queued)) throw new Error('waiter was unexpectedly self-granted');

    const reclaimed = await reclaimStaleWorkItemClaims(sql, {
      graceMs: 1_000,
      parkedGraceMs: 1_000,
      unknownHolderFallbackMs: 1_000,
    });
    expect(reclaimed.released).toEqual([
      expect.objectContaining({
        feature_id: itemId,
        former_taken_by: formerOwner,
        action: 'freed-todo',
        reason: 'dead',
      }),
    ]);

    const waiterStatus = await readWaiterStatus(side, queued.ticket_id);
    expect(waiterStatus.status, JSON.stringify({
      reclaimed,
      queue: await readQueue(side, { coordinationDomain }),
    })).toBe('granted');
    expect(waiterStatus.granted_lock_id).toBeTruthy();

    const active = await readQueue(side, { coordinationDomain, owner: undefined });
    expect(active.active_locks).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: unrelatedPath, owner: formerOwner, lock_id: held.lock_id }),
      expect.objectContaining({ path: targetPath, owner: successor, lock_id: waiterStatus.granted_lock_id }),
    ]));
    expect(active.active_locks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: targetPath, owner: formerOwner }),
    ]));

    await inWorkspaceTxn(coordinationDomain, successor, (tx) =>
      tryRelease(tx, {
        coordinationDomain,
        owner: successor,
        lockId: waiterStatus.granted_lock_id!,
      }),
    );
    await inWorkspaceTxn(coordinationDomain, formerOwner, (tx) =>
      tryRelease(tx, {
        coordinationDomain,
        owner: formerOwner,
        lockId: held.lock_id,
        paths: [unrelatedPath],
      }),
    );
  }, 60_000);

  it.skipIf(!live)('releases goal-associated locks for a pathless item and copies waiter goal_ref on grant', async () => {
    const side = getTxPool();
    const coordinationDomain = `${SUITE_PREFIX}-pathless-domain`;
    const formerOwner = `${SUITE_PREFIX}-pathless-former-owner`;
    const successor = `${SUITE_PREFIX}-pathless-successor`;
    const itemId = `${SUITE_PREFIX}-pathless-item`;
    const unrelatedItemId = `${SUITE_PREFIX}-unrelated-item`;
    const successorItemId = `${SUITE_PREFIX}-successor-item`;
    const targetPath = 'src/pathless-reclaimed-target.ts';
    const unrelatedPath = 'src/pathless-unrelated.ts';

    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, status,
         taken_by, taken_at, created_ts, updated_ts, payload)
      VALUES
        (${WORKSPACE_ID}, ${HARNESS}, ${itemId}, 'feature', ${itemId}, 'todo',
         ${formerOwner}, now() - interval '30 minutes',
         ${Date.now() - 1_800_000}, ${Date.now() - 1_800_000},
         ${sql.json({ summary: 'no declared paths' })})
    `;
    await sql`
      INSERT INTO harness_shared.coord_presence (owner_id, heartbeat_at)
      VALUES (${formerOwner}, now() - interval '30 minutes')
    `;
    const [seeded] = await sql<{ payload: unknown }[]>`
      SELECT payload FROM harness_shared.work_items WHERE feature_id = ${itemId}
    `;
    expect(readWorkItemPaths(seeded.payload)).toEqual([]);

    const targetLock = await inWorkspaceTxn(coordinationDomain, formerOwner, (tx) =>
      tryAcquire(tx, {
        coordinationDomain,
        owner: formerOwner,
        ownerLabel: 'pathless former owner',
        paths: [targetPath],
        intent: 'pathless reclaimed item',
        goalRef: itemId,
        ttlSec: 600,
      }),
    );
    const unrelatedLock = await inWorkspaceTxn(coordinationDomain, formerOwner, (tx) =>
      tryAcquire(tx, {
        coordinationDomain,
        owner: formerOwner,
        ownerLabel: 'pathless former owner',
        paths: [unrelatedPath],
        intent: 'unrelated concurrent item',
        goalRef: unrelatedItemId,
        ttlSec: 600,
      }),
    );
    expect(targetLock.ok).toBe(true);
    expect(unrelatedLock.ok).toBe(true);
    if (!targetLock.ok || !unrelatedLock.ok) throw new Error('failed to seed pathless goal-associated locks');

    const queued = await inWorkspaceTxn(coordinationDomain, successor, (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain,
        owner: successor,
        ownerLabel: 'pathless successor',
        paths: [targetPath],
        intent: 'take over pathless reclaimed item',
        goalRef: successorItemId,
        ttlSec: 600,
        maxWaitSec: 60,
      }),
    );
    expect(queued.ok).toBe(true);
    if (!queued.ok || !('ticket_id' in queued)) throw new Error('pathless waiter was unexpectedly self-granted');

    const reclaimed = await reclaimStaleWorkItemClaims(sql, {
      graceMs: 1_000,
      parkedGraceMs: 1_000,
      unknownHolderFallbackMs: 1_000,
    });
    expect(reclaimed.released).toEqual([
      expect.objectContaining({
        feature_id: itemId,
        former_taken_by: formerOwner,
        action: 'freed-todo',
        reason: 'dead',
      }),
    ]);

    const waiterStatus = await readWaiterStatus(side, queued.ticket_id);
    expect(waiterStatus.status, JSON.stringify({
      reclaimed,
      queue: await readQueue(side, { coordinationDomain }),
    })).toBe('granted');

    const active = await readQueue(side, { coordinationDomain, owner: undefined });
    expect(active.active_locks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: unrelatedPath,
        owner: formerOwner,
        lock_id: unrelatedLock.lock_id,
        goal_ref: unrelatedItemId,
      }),
      expect.objectContaining({
        path: targetPath,
        owner: successor,
        goal_ref: successorItemId,
        lock_id: waiterStatus.granted_lock_id,
      }),
    ]));
    expect(active.active_locks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: targetPath, owner: formerOwner, goal_ref: itemId }),
    ]));

    await inWorkspaceTxn(coordinationDomain, successor, (tx) =>
      tryRelease(tx, {
        coordinationDomain,
        owner: successor,
        lockId: waiterStatus.granted_lock_id!,
      }),
    );
    await inWorkspaceTxn(coordinationDomain, formerOwner, (tx) =>
      tryRelease(tx, {
        coordinationDomain,
        owner: formerOwner,
        lockId: unrelatedLock.lock_id,
      }),
    );
  }, 60_000);
});
