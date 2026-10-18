/**
 * resource-lock-guard — the requiresLock enforcement primitive (Phase 8, P-025).
 *
 * guardResource acquires a named resource (drain for exclusive), runs the
 * wrapped body ONLY if acquired, and releases after (+ back-up broadcast for
 * exclusive). It is the "the body can't run without the lock" guarantee that
 * realizes the `enforced` rung — a handler HOF (withResourceLock) rather than
 * a dispatcher interceptor, so the generic tooldef lib stays domain-free
 * (D-016). Live PG; explicit identity so no tool-ctx mock is needed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  ensureBootstrap,
  getTxPool,
  _resetForTests,
  tryAcquireResource,
  tryReleaseResource,
  readResourceQueue,
} from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';
import { _resetListenersForTests } from '../workspace-listener';
import { readInbox } from '../../coordination/messages';
import type { AgentIdentity } from '../../coordination/identity';
import { guardResource } from '../resource-lock-guard';
import { resourceLockDomain } from '../coordination-domain';

async function dbLive(): Promise<boolean> {
  try {
    // A fresh private Postgres has no papercusp_su until this bootstrap runs.
    // Probing its pool first would silently skip every regression below.
    await ensureBootstrap();
    await getTxPool()`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

let seq = 0;
const uniqueWs = () => `guard-ws-${Date.now()}-${seq++}`;
const mkId = (ownerId: string): AgentIdentity => ({
  ownerId,
  ownerLabel: `res:${ownerId}`,
  source: 'static-client',
  workspaceId: null,
  userId: null,
});

describe('guardResource (requiresLock enforcement)', async () => {
  const live = await dbLive();

  beforeAll(async () => {
    if (live) await readInbox(`warmup-${Date.now()}`).catch(() => {});
  });

  it.skipIf(!live).each([
    ['staging-server', 0], ['staging-server-cooldown', 0],
    ['staging-server', 0.02], ['staging-server-cooldown', 0.02],
  ] as const)(
    'a shared %s probe excludes and cleans up a restart with drain budget %s', async (resource, maxDrainSec) => {
      await ensureBootstrap();
      const saved = process.env.PAPERCUSP_LOCK_DOMAIN;
      // Isolate the actual PG lock rows; never hold the production service.
      process.env.PAPERCUSP_LOCK_DOMAIN = uniqueWs();
      const probeDomain = resourceLockDomain(resource, '/checkouts/canonical');
      const restartDomain = resourceLockDomain(resource, '/checkouts/staging-generation');
      const owner = 'probe-' + uniqueWs();
      const restartOwner = 'restart-' + owner;
      const held = await inWorkspaceTxn(probeDomain, owner, tx => tryAcquireResource(tx, {
        coordinationDomain: probeDomain, resource, mode: 'shared', owner,
        ownerLabel: 'protected probe', reason: 'cross-checkout regression', ttlSec: 30,
      }));
      try {
        expect(held.ok).toBe(true);
        let ran = false;
        const out = await guardResource({ coordinationDomain: restartDomain, ownerId: restartOwner,
          ownerLabel: 'restart', coordIdentity: mkId(restartOwner), resource,
          mode: 'exclusive', maxDrainSec }, async () => { ran = true; });
        expect(ran).toBe(false);
        expect(out.acquired).toBe(false);
        // A declined guard has no body left to run. Its reservation must not
        // become an effective exclusive after the probe finishes.
        const declined = await readResourceQueue(getTxPool(), { coordinationDomain: restartDomain, resource });
        expect(declined.holders.some(holder => holder.owner === restartOwner)).toBe(false);
        expect(probeDomain).toBe(restartDomain);
        expect(resourceLockDomain('per-tree-fixture', '/checkouts/canonical'))
          .not.toBe(resourceLockDomain('per-tree-fixture', '/checkouts/staging-generation'));
      } finally {
        // Release the test-owned restart too when a regression assertion fails.
        await inWorkspaceTxn(restartDomain, restartOwner, tx => tryReleaseResource(tx, {
          coordinationDomain: restartDomain, owner: restartOwner, resource,
        }));
        if (held.ok) await inWorkspaceTxn(probeDomain, owner, tx => tryReleaseResource(tx, {
          coordinationDomain: probeDomain, owner, lockId: held.lock_id,
        }));
        if (saved === undefined) delete process.env.PAPERCUSP_LOCK_DOMAIN;
        else process.env.PAPERCUSP_LOCK_DOMAIN = saved;
      }
    });

  it.skipIf(!live).each([
    [3600, 60],
    [60, 3600],
  ])('nested same-owner shared guard preserves expiry with outer TTL %s and inner TTL %s', async (outerTtlSec, innerTtlSec) => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const resource = 'staging-server';
    const owner = 'outer-' + uniqueWs();
    const independentOwner = 'independent-' + uniqueWs();
    let outerLockId: string | null = null;
    let independentLockId: string | null = null;

    try {
      const outer = await inWorkspaceTxn(ws, owner, tx => tryAcquireResource(tx, {
        coordinationDomain: ws,
        resource,
        mode: 'shared',
        owner,
        ownerLabel: owner,
        reason: 'outer caller lease',
        ttlSec: outerTtlSec,
      }));
      if (!outer.ok) throw new Error('could not acquire outer shared lease: ' + outer.reason);
      outerLockId = outer.lock_id;

      const independent = await inWorkspaceTxn(ws, independentOwner, tx => tryAcquireResource(tx, {
        coordinationDomain: ws,
        resource,
        mode: 'shared',
        owner: independentOwner,
        ownerLabel: independentOwner,
        reason: 'independent shared lease',
        ttlSec: 60,
      }));
      if (!independent.ok) throw new Error('could not acquire independent shared lease: ' + independent.reason);
      independentLockId = independent.lock_id;

      const out = await guardResource({
        coordinationDomain: ws,
        ownerId: owner,
        ownerLabel: owner,
        coordIdentity: mkId(owner),
        resource,
        mode: 'shared',
        ttlSec: innerTtlSec,
      }, async fence => {
        expect(fence.lockId).toBe(outerLockId);
        const during = await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource });
        expect(during.holders.some(holder => holder.owner === owner && holder.lock_id === outerLockId)).toBe(true);
        return 'nested complete';
      });

      expect(out.acquired).toBe(true);
      if (out.acquired) expect(out.lock_id).toBe(outerLockId);
      const after = await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource });
      const retained = after.holders.find(holder => holder.owner === owner && holder.lock_id === outerLockId);
      expect(retained).toBeDefined();
      expect(new Date(retained!.expires_ts).getTime()).toBeGreaterThanOrEqual(outer.expires_ts.getTime());
      if (innerTtlSec > outerTtlSec) {
        expect(new Date(retained!.expires_ts).getTime()).toBeGreaterThan(outer.expires_ts.getTime());
      }
      const retainedIndependent = after.holders.find(holder => holder.owner === independentOwner && holder.lock_id === independentLockId);
      expect(retainedIndependent).toBeDefined();
      expect(new Date(retainedIndependent!.expires_ts).getTime()).toBe(independent.expires_ts.getTime());
    } finally {
      if (independentLockId) await inWorkspaceTxn(ws, independentOwner, tx => tryReleaseResource(tx, {
        coordinationDomain: ws,
        owner: independentOwner,
        lockId: independentLockId!,
      }));
      if (outerLockId) await inWorkspaceTxn(ws, owner, tx => tryReleaseResource(tx, {
        coordinationDomain: ws,
        owner,
        lockId: outerLockId!,
      }));
    }
  });

  it.skipIf(!live)('acquires exclusive, runs the body while held, releases after', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    let ran = false;
    let statusDuring: string | undefined;

    const out = await guardResource(
      {
        coordinationDomain: ws,
        ownerId: 'X',
        ownerLabel: 'res:X',
        coordIdentity: mkId('X'),
        resource: 'dev-server',
        mode: 'exclusive',
        maxDrainSec: 5,
      },
      async () => {
        ran = true;
        const q = await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource: 'dev-server' });
        statusDuring = q.holders.find((h) => h.owner === 'X')?.status;
        return { ok: true, body: 'done' };
      },
    );

    expect(ran).toBe(true);
    expect(statusDuring).toBe('held'); // lock held while the body ran
    expect(out.acquired).toBe(true);
    if (out.acquired) expect(out.result).toEqual({ ok: true, body: 'done' });

    // Released after.
    const q2 = await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource: 'dev-server' });
    expect(q2.holders.some((h) => h.owner === 'X')).toBe(false);
  });

  it.skipIf(!live)('does NOT run the body when another owner holds the exclusive', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    await inWorkspaceTxn(ws, 'Y', (tx) =>
      tryAcquireResource(tx, {
        coordinationDomain: ws,
        resource: 'dev-server',
        mode: 'exclusive',
        owner: 'Y',
        ownerLabel: 'res:Y',
        reason: 'held',
        ttlSec: 60,
      }),
    );

    let ran = false;
    const out = await guardResource(
      {
        coordinationDomain: ws,
        ownerId: 'X',
        ownerLabel: 'res:X',
        coordIdentity: mkId('X'),
        resource: 'dev-server',
        mode: 'exclusive',
        maxDrainSec: 1,
      },
      async () => {
        ran = true;
        return { ok: true };
      },
    );

    expect(ran).toBe(false);
    expect(out.acquired).toBe(false);

    await _resetListenersForTests();
    await _resetForTests();
  });
});
