/** TTL wakes use a disposable cluster: never sweep the host's locks database. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import { configureLocks, locksHost } from '@papercusp/locks';
import {
  _resetForTests, ensureBootstrap, getTxPool, inWorkspaceTxn,
  registerResource, runBackgroundJanitorOnce, tryAcquireResource, pokeResource,
  acquireSharedResourceAtomic, heartbeatSharedResourceAtomic, releaseSharedResourceAtomic,
} from '../su-lock-store';
import * as events from '../../../harness/git-sync/git-sync-events';

const workspace = 'resource-expiry-test-workspace';
const resource = 'git-sync:resource-expiry-test';
const priorHost = locksHost();
let pg: DedicatedNativePg;
const emit = vi.spyOn(events, 'emitResourceReleasedEvent').mockImplementation(() => {});

async function hold(mode: 'shared' | 'exclusive' = 'exclusive', owner = 'holder', queueOnConflict = false) {
  return inWorkspaceTxn(workspace, owner, tx => tryAcquireResource(tx, {
    coordinationDomain: workspace, resource, mode, owner, ownerLabel: null,
    reason: 'expiry fixture', ttlSec: 60, queueOnConflict,
  }));
}

async function expire() {
  await getTxPool()`UPDATE agent_resource_locks SET expires_ts = clock_timestamp() - interval '1 second'
    WHERE coordination_domain = ${workspace} AND resource = ${resource}`;
}

describe('expired exclusive resource wakes', () => {
  beforeAll(async () => {
    pg = await startDedicatedNativePg();
    configureLocks({ ...priorHost, getAdminBaseUrl: () => pg.getConnectionUri() });
    await _resetForTests();
    await ensureBootstrap();
    await inWorkspaceTxn(workspace, 'fixture', tx => registerResource(tx, {
      resource, description: 'owned expiry fixture',
    }));
  });

  afterAll(async () => {
    emit.mockRestore();
    await _resetForTests();
    configureLocks(priorHost);
    await pg?.stop();
  });

  beforeEach(async () => {
    const sql = getTxPool();
    await sql`DELETE FROM agent_resource_exclusive_queue WHERE coordination_domain = ${workspace}`;
    await sql`DELETE FROM agent_resource_locks WHERE coordination_domain = ${workspace}`;
    await sql`DELETE FROM agent_resource_waiters WHERE coordination_domain = ${workspace}`;
    emit.mockClear();
  });

  it('emits once after the janitor commits an expired exclusive deletion', async () => {
    const held = await hold();
    expect(held.ok).toBe(true);
    const sql = getTxPool();
    await expire();
    emit.mockClear();
    await runBackgroundJanitorOnce();
    expect(await sql`SELECT lock_id FROM agent_resource_locks
      WHERE coordination_domain = ${workspace} AND resource = ${resource}`).toHaveLength(0);
    expect(emit).toHaveBeenCalledExactlyOnceWith(resource, workspace);
    await runBackgroundJanitorOnce();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('defers the domain poke wake until commit and deduplicates repeated sweeps', async () => {
    expect((await hold()).ok).toBe(true);
    await expire();
    await inWorkspaceTxn(workspace, 'fixture', async tx => {
      await pokeResource(tx, workspace);
      await pokeResource(tx, workspace);
      expect(emit).not.toHaveBeenCalled();
    });
    expect(emit).toHaveBeenCalledExactlyOnceWith(resource, workspace);
  });

  it('does not emit a deletion that rolls back or lose its later committed wake', async () => {
    expect((await hold()).ok).toBe(true);
    await expire();
    await expect(inWorkspaceTxn(workspace, 'fixture', async tx => {
      await pokeResource(tx, workspace);
      throw new Error('rollback fixture');
    })).rejects.toThrow('rollback fixture');
    expect(emit).not.toHaveBeenCalled();
    expect(await getTxPool()`SELECT lock_id FROM agent_resource_locks
      WHERE coordination_domain = ${workspace}`).toHaveLength(1);
    await runBackgroundJanitorOnce();
    expect(emit).toHaveBeenCalledExactlyOnceWith(resource, workspace);
  });

  it('suppresses the wake when FIFO promotes another exclusive, then wakes on its expiry', async () => {
    expect((await hold()).ok).toBe(true);
    const queued = await hold('exclusive', 'successor', true);
    expect(queued).toMatchObject({ ok: false, reason: 'held_exclusive' });
    await expire();
    await runBackgroundJanitorOnce();
    expect(await getTxPool()`SELECT owner FROM agent_resource_locks
      WHERE coordination_domain = ${workspace}`).toEqual([{ owner: 'successor' }]);
    expect(emit).not.toHaveBeenCalled();
    await expire();
    await runBackgroundJanitorOnce();
    expect(emit).toHaveBeenCalledExactlyOnceWith(resource, workspace);
  });

  it('does not report shared expiry as an exclusive release', async () => {
    expect((await hold('shared')).ok).toBe(true);
    await expire();
    await runBackgroundJanitorOnce();
    expect(emit).not.toHaveBeenCalled();
  });

  it('collects expiry from a resource-scoped SQL sweep', async () => {
    expect((await hold()).ok).toBe(true);
    await expire();
    const acquired = await inWorkspaceTxn(workspace, 'reader', tx => tryAcquireResource(tx, {
      coordinationDomain: workspace, resource, mode: 'shared', owner: 'reader', ownerLabel: null,
      reason: 'scoped expiry fixture', ttlSec: 60, scope: 'resource',
    }), { resources: [resource] });
    expect(acquired.ok).toBe(true);
    expect(emit).toHaveBeenCalledExactlyOnceWith(resource, workspace);
  });

  it('preserves successful atomic acquire, reuse, heartbeat Date and release results', async () => {
    const params = { coordinationDomain: workspace, resource, owner: 'reader', ownerLabel: null,
      reason: 'live shared fixture', ttlSec: 60 };
    const acquired = await acquireSharedResourceAtomic(params);
    expect(acquired).toMatchObject({ ok: true, reused: false, expires_ts: expect.any(Date) });
    if (!acquired.ok) throw new Error('shared fixture was not acquired');
    expect(await acquireSharedResourceAtomic(params)).toMatchObject({ ok: true, reused: true, lock_id: acquired.lock_id });
    const lease = { ...params, lockId: acquired.lock_id };
    const renewed = await heartbeatSharedResourceAtomic({ ...lease, ttlSec: 120 });
    expect(renewed).toMatchObject({ extended: true, expires_ts: expect.any(Date) });
    expect(renewed.expires_ts!.getTime()).toBeGreaterThan(acquired.expires_ts.getTime());
    expect(await releaseSharedResourceAtomic(lease)).toEqual({ released: 1, expired: false });
    expect(emit).not.toHaveBeenCalled();
  });

  it('keeps the deletion committed when the host notification fails', async () => {
    expect((await hold()).ok).toBe(true);
    await expire();
    const host = locksHost();
    const failed = vi.fn(async () => { throw new Error('notification fixture'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    configureLocks({ ...host, onResourceExpired: failed });
    try {
      await runBackgroundJanitorOnce();
      expect(failed).toHaveBeenCalledExactlyOnceWith({ coordinationDomain: workspace, resource });
      expect(await getTxPool()`SELECT lock_id FROM agent_resource_locks
        WHERE coordination_domain = ${workspace}`).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith('[su-locks] resource expiry notification failed', expect.any(Error));
    } finally {
      configureLocks(host);
      warn.mockRestore();
    }
  });

  it.each(['acquire', 'heartbeat', 'release'] as const)(
    'collects expiry from the one-statement atomic %s without adding a transaction', async operation => {
      expect((await hold()).ok).toBe(true);
      await expire();
      const params = { coordinationDomain: workspace, resource, owner: 'reader',
        lockId: '00000000-0000-0000-0000-000000000001' };
      if (operation === 'acquire') {
        expect(await acquireSharedResourceAtomic({ ...params, ownerLabel: null, reason: 'fixture', ttlSec: 60 }))
          .toMatchObject({ ok: true });
      } else if (operation === 'heartbeat') {
        expect(await heartbeatSharedResourceAtomic({ ...params, ttlSec: 60 })).toEqual({ extended: false, expires_ts: null });
      } else {
        expect(await releaseSharedResourceAtomic(params)).toMatchObject({ released: 0 });
      }
      expect(emit).toHaveBeenCalledExactlyOnceWith(resource, workspace);
    });
});
