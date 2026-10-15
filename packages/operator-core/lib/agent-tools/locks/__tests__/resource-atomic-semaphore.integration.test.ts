/**
 * resource-atomic-semaphore — one-round-trip shared-semaphore operations
 * (locks sql/030; papercusp-log-performance-remediation-2026-09-23 P-014(e),
 * WI-10004964).
 *
 * The host-wide optional-memory admission used to hold the domain-global
 * exclusive advisory key across ~10 client round trips per operation, so the
 * semaphore serialized against itself (measured 2026-10-01: 543k waits at a
 * 35ms mean). The atomic ops take the shared domain gate + an exclusive
 * per-resource key inside ONE statement. These tests pin the properties the
 * change must keep (capacity, writer priority, drain completion, expiry
 * reporting) and the two it adds: a domain-global holder still blocks them,
 * and a different resource's key does not.
 *
 * Live papercusp_su (or the throwaway one under scripts/with-test-pg.mjs); a
 * unique resource name + coordination domain per run keeps state isolated.
 */

import { describe, it, expect } from 'vitest';
import {
  ensureBootstrap,
  getTxPool,
  tryAcquireResource,
  upsertResource,
  acquireSharedResourceAtomic,
  heartbeatSharedResourceAtomic,
  releaseSharedResourceAtomic,
  SU_LOCKS_FEATURE_KEY,
  stampResourceCoordinationDomainKind,
} from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';

async function dbLive(): Promise<boolean> {
  try {
    // A disposable main database has no locks side database until bootstrap.
    // Probe the initialized store, and never silently skip a broken private run.
    await ensureBootstrap();
    await getTxPool()`SELECT 1`;
    return true;
  } catch (error) {
    if (process.env.HOME?.includes('papercusp-test-runtime-')) throw error;
    return false;
  }
}

let seq = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${process.pid}-${seq++}`;

async function registered(ws: string, maxHolders: number | null): Promise<string> {
  const resource = unique('atomic-sem');
  await inWorkspaceTxn(ws, 'admin', (tx) =>
    upsertResource(tx, { resource, description: 'atomic semaphore test', max_holders: maxHolders }),
  );
  return resource;
}

const acquire = (ws: string, resource: string, owner: string, lockTimeoutMs?: number) =>
  acquireSharedResourceAtomic({
    coordinationDomain: ws,
    resource,
    owner,
    ownerLabel: `atomic:${owner}`,
    reason: 'atomic semaphore test',
    ttlSec: 60,
    lockTimeoutMs,
  });

/** Hold `key` (within SU_LOCKS_FEATURE_KEY) in an open transaction until the
 *  returned release() is called. */
async function holdAdvisoryKey(key: string): Promise<{ release: () => Promise<void> }> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let held!: () => void;
  const isHeld = new Promise<void>((resolve) => (held = resolve));
  const txn = getTxPool().begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${SU_LOCKS_FEATURE_KEY}::int, hashtext(${key}))`;
    held();
    await gate;
  });
  await isHeld;
  return {
    release: async () => {
      open();
      await txn;
    },
  };
}

describe('one-round-trip shared semaphore (locks sql/030, P-014(e))', async () => {
  const live = await dbLive();

  it.skipIf(!live)('never admits more than max_holders under concurrent atomic acquires', async () => {
    await ensureBootstrap();
    const ws = unique('atomic-ws');
    const res = await registered(ws, 2);

    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => acquire(ws, res, `o${i}`)));
    const grantedIdx = results.flatMap((r, i) => (r.ok ? [i] : []));
    expect(grantedIdx).toHaveLength(2);
    expect(results.filter((r) => !r.ok && r.reason === 'at_capacity')).toHaveLength(10);
    const [rows] = await getTxPool()<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM agent_resource_locks
       WHERE coordination_domain = ${ws} AND resource = ${res} AND expires_ts > clock_timestamp()`;
    expect(rows.n).toBe(2);

    // A holder's refresh does not consume a fresh slot.
    const holder = `o${grantedIdx[0]}`;
    expect((await acquire(ws, res, holder)).ok).toBe(true);

    // An atomic release frees the slot for a newcomer.
    const first = results[grantedIdx[0]];
    if (!first.ok) throw new Error('unreachable');
    expect(
      await releaseSharedResourceAtomic({ coordinationDomain: ws, resource: res, owner: holder, lockId: first.lock_id }),
    ).toEqual({ released: 1, expired: false });
    expect((await acquire(ws, res, 'late')).ok).toBe(true);
  });

  it.skipIf(!live)('keeps writer priority, lets an incumbent renew, and completes the drain on release', async () => {
    await ensureBootstrap();
    const ws = unique('atomic-ws');
    const res = await registered(ws, null);

    const incumbent = await acquire(ws, res, 'incumbent');
    expect(incumbent.ok).toBe(true);
    if (!incumbent.ok) return;

    const writer = await inWorkspaceTxn(ws, 'writer', (tx) =>
      tryAcquireResource(tx, {
        coordinationDomain: ws,
        resource: res,
        mode: 'exclusive',
        owner: 'writer',
        ownerLabel: 'writer',
        reason: 'atomic semaphore test',
        ttlSec: 60,
      }),
    );
    expect(writer.ok && writer.status).toBe('draining');

    expect(await acquire(ws, res, 'newcomer')).toEqual({ ok: false, reason: 'exclusive_pending' });
    expect((await acquire(ws, res, 'incumbent')).ok).toBe(true); // EI-23229103052811419

    await releaseSharedResourceAtomic({ coordinationDomain: ws, resource: res, owner: 'incumbent', lockId: incumbent.lock_id });
    const [row] = await getTxPool()<Array<{ status: string; fence_seq: number }>>`
      SELECT status, fence_seq::int AS fence_seq FROM agent_resource_locks
       WHERE coordination_domain = ${ws} AND resource = ${res} AND owner = 'writer'`;
    expect(row.status).toBe('held');
    expect(row.fence_seq).toBeGreaterThan(0);
  });

  it.skipIf(!live)('reports an expired lease on release and refuses to heartbeat it', async () => {
    await ensureBootstrap();
    const ws = unique('atomic-ws');
    const res = await registered(ws, 2);
    const a = await acquire(ws, res, 'a');
    const b = await acquire(ws, res, 'b');
    if (!a.ok || !b.ok) throw new Error('setup acquire failed');
    await getTxPool()`
      UPDATE agent_resource_locks SET expires_ts = clock_timestamp() - interval '1 second'
       WHERE coordination_domain = ${ws} AND resource = ${res}`;

    expect(await releaseSharedResourceAtomic({ coordinationDomain: ws, resource: res, owner: 'a', lockId: a.lock_id })).toEqual({
      released: 0,
      expired: true,
    });
    expect(
      (await heartbeatSharedResourceAtomic({ coordinationDomain: ws, resource: res, owner: 'b', lockId: b.lock_id, ttlSec: 60 }))
        .extended,
    ).toBe(false);

    const fresh = await acquire(ws, res, 'c');
    if (!fresh.ok) throw new Error('fresh acquire refused');
    const beat = await heartbeatSharedResourceAtomic({ coordinationDomain: ws, resource: res, owner: 'c', lockId: fresh.lock_id, ttlSec: 60 });
    expect(beat.extended).toBe(true);
    expect(beat.expires_ts!.getTime()).toBeGreaterThan(Date.now());
  });

  it.skipIf(!live)('waits for a domain-global holder but not for another resource key', async () => {
    await ensureBootstrap();
    const ws = unique('atomic-ws');
    const res = await registered(ws, 2);
    const other = await registered(ws, 2);

    // Rolling compatibility: an operation holding the exclusive domain key (the
    // inWorkspaceTxn scope with no paths, including older processes) blocks.
    const domainHolder = await holdAdvisoryKey(`su:${ws}`);
    try {
      await expect(acquire(ws, res, 'blocked', 200)).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await domainHolder.release();
    }

    // Per-resource independence: holding one resource's key blocks only it.
    const resourceHolder = await holdAdvisoryKey(`su-resource:${ws}:${res}`);
    try {
      expect((await acquire(ws, other, 'free', 200)).ok).toBe(true);
      await expect(acquire(ws, res, 'blocked', 200)).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await resourceHolder.release();
    }
    expect((await acquire(ws, res, 'after', 200)).ok).toBe(true);
  });
});

describe('host-global resource exclusion across legacy coordination domains', async () => {
  const live = await dbLive();

  async function hostResource(): Promise<string> {
    const resource = await registered(unique('host-admin'), null);
    await inWorkspaceTxn(unique('host-registration'), 'admin', tx =>
      stampResourceCoordinationDomainKind(tx, resource, 'host-global'));
    return resource;
  }

  const legacyExclusive = (domain: string, resource: string, owner: string) =>
    inWorkspaceTxn(domain, owner, tx => tryAcquireResource(tx, {
      coordinationDomain: domain, resource, owner, ownerLabel: owner,
      mode: 'exclusive', reason: 'legacy caller regression', ttlSec: 60,
    }));

  const crossDomainError = { code: '23P01', constraint_name: 'resource_host_global_exclusion' };

  it.skipIf(!live)('rejects a legacy exclusive over a shared lease in another domain', async () => {
    const resource = await hostResource();
    expect((await acquire(unique('reader-domain'), resource, 'reader')).ok).toBe(true);
    await expect(legacyExclusive(unique('legacy-domain'), resource, 'writer'))
      .rejects.toMatchObject(crossDomainError);
  });

  it.skipIf(!live)('rejects an atomic shared acquire over a foreign-domain exclusive', async () => {
    const resource = await hostResource();
    expect((await legacyExclusive(unique('legacy-domain'), resource, 'writer')).ok).toBe(true);
    await expect(acquire(unique('reader-domain'), resource, 'reader'))
      .rejects.toMatchObject(crossDomainError);
  });

  it.skipIf(!live)('serializes concurrent legacy exclusives even though their domain gates differ', async () => {
    const resource = await hostResource();
    const results = await Promise.allSettled([
      legacyExclusive(unique('legacy-a'), resource, 'writer-a'),
      legacyExclusive(unique('legacy-b'), resource, 'writer-b'),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find(r => r.status === 'rejected');
    expect(refused?.status === 'rejected' && refused.reason).toMatchObject(crossDomainError);
    const [row] = await getTxPool()<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM agent_resource_locks
       WHERE resource = ${resource} AND expires_ts > clock_timestamp()`;
    expect(row.n).toBe(1);
  });

  it.skipIf(!live)('does not permit a same-owner upgrade through a different domain', async () => {
    const resource = await hostResource();
    expect((await acquire(unique('reader-domain'), resource, 'same-owner')).ok).toBe(true);
    await expect(legacyExclusive(unique('legacy-domain'), resource, 'same-owner'))
      .rejects.toMatchObject(crossDomainError);
  });

  it.skipIf(!live)('fences raw legacy writes and waits for an uncommitted foreign lease', async () => {
    const resource = await hostResource();
    const readerDomain = unique('raw-reader');
    let unblock!: () => void;
    let inserted!: () => void;
    const hold = new Promise<void>(resolve => { unblock = resolve; });
    const ready = new Promise<void>(resolve => { inserted = resolve; });
    const reader = getTxPool().begin(async tx => {
      await tx`INSERT INTO agent_resource_locks
        (coordination_domain, resource, owner, mode, expires_ts)
        VALUES (${readerDomain}, ${resource}, 'raw-reader', 'shared',
          clock_timestamp() + interval '60 seconds')`;
      inserted();
      await hold;
    });
    // Propagate setup failure rather than leave a readiness promise hanging.
    await Promise.race([ready, reader]);
    try {
      await expect(getTxPool().begin(async tx => {
        await tx`SET LOCAL lock_timeout = '100ms'`;
        await tx`INSERT INTO agent_resource_locks
          (coordination_domain, resource, owner, mode, expires_ts)
          VALUES (${unique('raw-writer')}, ${resource}, 'raw-writer', 'exclusive',
            clock_timestamp() + interval '60 seconds')`;
      })).rejects.toMatchObject({ code: '55P03' });
      // The gate is per registry row, so another physical resource stays usable.
      const other = await hostResource();
      expect((await legacyExclusive(unique('other-resource'), other, 'other-writer')).ok).toBe(true);
    } finally {
      unblock();
      await reader;
    }
    await expect(legacyExclusive(unique('after-commit'), resource, 'writer'))
      .rejects.toMatchObject(crossDomainError);
  });

  it.skipIf(!live)('checks lease renewal as well as insertion after a foreign writer is admitted', async () => {
    const resource = await hostResource();
    const domain = unique('expired-reader');
    const reader = await acquire(domain, resource, 'reader');
    if (!reader.ok) throw new Error('setup reader refused');
    await getTxPool()`UPDATE agent_resource_locks
      SET expires_ts = clock_timestamp() - interval '1 second' WHERE resource = ${resource}`;
    expect((await legacyExclusive(unique('writer-domain'), resource, 'writer')).ok).toBe(true);
    await expect(getTxPool()`UPDATE agent_resource_locks
      SET expires_ts = clock_timestamp() + interval '60 seconds'
      WHERE lock_id = ${reader.lock_id}::uuid`).rejects.toMatchObject(crossDomainError);
  });

  it.skipIf(!live).each(['repeatable read', 'serializable'])(
    'fences a stale %s snapshot that predates a foreign writer', async isolation => {
      const resource = await hostResource();
      await expect(getTxPool().begin(`isolation level ${isolation}`, async tx => {
        const [empty] = await tx<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM agent_resource_locks WHERE resource = ${resource}`;
        expect(empty.n).toBe(0); // Pin the old transaction snapshot.
        expect((await legacyExclusive(unique('committed-writer'), resource, 'writer')).ok).toBe(true);
        await tx`INSERT INTO agent_resource_locks
          (coordination_domain, resource, owner, mode, expires_ts)
          VALUES (${unique('stale-writer')}, ${resource}, 'stale-writer', 'exclusive',
            clock_timestamp() + interval '60 seconds')`;
      })).rejects.toMatchObject({ code: '40001' });
      const [row] = await getTxPool()<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM agent_resource_locks
         WHERE resource = ${resource} AND expires_ts > clock_timestamp()`;
      expect(row.n).toBe(1);
    },
  );

  it.skipIf(!live)('allows shared readers across domains and ignores expired foreign leases', async () => {
    const resource = await hostResource();
    expect((await acquire(unique('reader-a'), resource, 'reader-a')).ok).toBe(true);
    expect((await acquire(unique('reader-b'), resource, 'reader-b')).ok).toBe(true);
    await getTxPool()`UPDATE agent_resource_locks
      SET expires_ts = clock_timestamp() - interval '1 second' WHERE resource = ${resource}`;
    expect((await legacyExclusive(unique('legacy-domain'), resource, 'writer')).ok).toBe(true);
  });

  it.skipIf(!live)('preserves independent domains for resources declared as tree-scoped', async () => {
    const resource = await registered(unique('tree-admin'), null);
    expect((await legacyExclusive(unique('tree-a'), resource, 'writer-a')).ok).toBe(true);
    expect((await legacyExclusive(unique('tree-b'), resource, 'writer-b')).ok).toBe(true);
  });
});
