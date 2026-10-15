/**
 * resource-broadcast-resume — the end-to-end broadcast→resume cycle (P-021).
 *
 * Exercises the WHOLE named-resource drain cycle through the real helpers, not
 * the broadcast/wait halves in isolation:
 *
 *   1. Two shared holders hold `dev-server`.
 *   2. A requester takes the exclusive via acquireResourceExclusiveWithWait
 *      (wired exactly like locks:acquire_resource — onDrainStart fires
 *      broadcastResourceDrainStart). It parks in `draining`.
 *   3. The drain-start broadcast lands a targeted "release" MESSAGE in each
 *      shared holder's inbox.
 *   4. The shared holders release → resource_grant_cascade NOTIFYs the parked
 *      waiter, which RE-ACQUIRES (flips to `held`). This is the "resume".
 *   5. The requester releases its exclusive → broadcastResourceBackUp lands a
 *      "back up" broadcast MESSAGE.
 *
 * (The old path-glob `fireNotifications(resource:<name>)` watcher-notify was
 * retired with coord:watch — coordination-substrate Phase 3; locks are
 * control-plane, D-007 — so the cycle is asserted through the kept coord
 * messages + the real cascade NOTIFY resume.) Live PG + real NOTIFY; unique
 * owner ids isolate assertions from the shared coord stream.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  ensureBootstrap,
  getTxPool,
  _resetForTests,
  tryAcquireResource,
  tryReleaseResource,
} from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';
import { _resetListenersForTests } from '../workspace-listener';
import { acquireResourceExclusiveWithWait } from '../resource-acquire-wait';
import {
  broadcastResourceDrainStart,
  broadcastResourceBackUp,
} from '../resource-broadcast';
import { readInbox } from '../../coordination/messages';
import type { AgentIdentity } from '../../coordination/identity';

const RESOURCE = 'dev-server';

async function dbLive(): Promise<boolean> {
  try {
    await getTxPool()`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

let seq = 0;
const uniq = () => `${Date.now()}-${seq++}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mkIdentity = (ownerId: string): AgentIdentity => ({
  ownerId,
  ownerLabel: `res:${ownerId}`,
  source: 'static-client',
  workspaceId: null,
  userId: null,
});

const acqShared = (ws: string, owner: string) =>
  inWorkspaceTxn(ws, owner, (tx) =>
    tryAcquireResource(tx, {
      coordinationDomain: ws,
      resource: RESOURCE,
      mode: 'shared',
      owner,
      ownerLabel: `res:${owner}`,
      reason: 'test',
      ttlSec: 60,
    }),
  );

const rel = (ws: string, owner: string, lockId: string) =>
  inWorkspaceTxn(ws, owner, (tx) =>
    tryReleaseResource(tx, { coordinationDomain: ws, owner, lockId }),
  );

describe('resource broadcast→resume cycle (P-021)', async () => {
  const live = await dbLive();

  // Prime the org PG handle (first getOrgPg() can race drizzle load).
  beforeAll(async () => {
    if (live) await readInbox(`warmup-${Date.now()}`).catch(() => {});
  });

  afterAll(async () => {
    if (live) {
      await _resetListenersForTests();
      await _resetForTests();
    }
  });

  it.skipIf(!live)(
    'drain-start messages the holders, the parked waiter resumes on release, and back-up broadcasts',
    async () => {
      await ensureBootstrap();
      const ws = `res-bcast-resume-ws-${uniq()}`;
      const u = uniq();

      const reqId = `bcr-R-${u}`;
      const srcR = mkIdentity(reqId);
      const reader = `bcr-rdr-${u}`;
      const holderA = `bcr-A-${u}`;
      const holderB = `bcr-B-${u}`;

      // Two shared holders occupy dev-server.
      const a = await acqShared(ws, holderA);
      const b = await acqShared(ws, holderB);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;

      // Requester takes the exclusive — parks in `draining`, fires drain-start
      // (wired exactly like locks:acquire_resource).
      const pending = acquireResourceExclusiveWithWait({
        coordinationDomain: ws,
        owner: reqId,
        ownerLabel: srcR.ownerLabel,
        resource: RESOURCE,
        reason: 'restart',
        ttlSec: 60,
        maxWaitSec: 15,
        onDrainStart: (holders) =>
          broadcastResourceDrainStart({
            source: srcR,
            resource: RESOURCE,
            holders,
            reason: 'restart',
          }),
      });

      // Let it acquire (draining) + fire the drain-start broadcast. Poll instead of
      // a fixed sleep: the broadcast is async, and under a concurrent suite it
      // landed after a fixed 500ms, which read as a missing message (WI-10004964).
      let inboxA = await readInbox(holderA);
      const sawDrainStart = () =>
        inboxA.some((m) => m.from === reqId && /draining/i.test(m.summary ?? ''));
      for (const deadline = Date.now() + 10_000; !sawDrainStart() && Date.now() < deadline; ) {
        await sleep(100);
        inboxA = await readInbox(holderA);
      }

      // BROADCAST HALF — the drain-start targeted "release" message reached the holders.
      expect(sawDrainStart()).toBe(true);

      // Drain both shared holders → the grant cascade flips R to held + NOTIFYs it.
      await rel(ws, holderA, a.lock_id);
      await rel(ws, holderB, b.lock_id);

      // RESUME HALF — the parked waiter re-acquires after release.
      const r = await pending;
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.status).toBe('held');
      if (r.status !== 'held') return;

      const exclusiveLockId = r.lock_id;

      // Release the exclusive → broadcastResourceBackUp (mirrors locks:release_resource,
      // which passes the freed resource's waiters from the release result — A4).
      const released = await rel(ws, reqId, exclusiveLockId);
      expect(released.exclusiveResources).toContain(RESOURCE);
      await broadcastResourceBackUp({ source: srcR, resource: RESOURCE, waiters: [reader] });

      // BACK-UP HALF — the "back up" broadcast reached the waiting reader.
      const inboxReader = await readInbox(reader);
      expect(inboxReader.some((m) => m.from === reqId && /back up/i.test(m.summary ?? ''))).toBe(true);
    },
  );
});
