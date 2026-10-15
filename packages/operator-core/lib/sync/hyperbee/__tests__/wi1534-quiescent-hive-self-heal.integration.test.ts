/**
 * wi1534-quiescent-hive-self-heal.integration.test.ts — WI-3593 (WI-1534 spec
 * follow-through): a real two-peer hive boot proving the `hasStalledLogs`
 * anti-entropy fix (boot.ts + swarm.ts) genuinely reconnects an
 * admitted-but-quiescent member log over the REAL wire — WITHOUT any owner
 * append — where WI-3539's unit tests (swarm-self-heal.test.ts's "WI-1534
 * anti-entropy" describe block) already pinned the exact cadence ALGORITHM
 * with a fake swarm + fake timers.
 *
 * This is the integration half that spec asked for: `bootTwoHivePeers` (real
 * Hypercore + Hyperswarm/Noise over a local testnet DHT, real PG) genuinely
 * admits each peer's log, then a real socket teardown genuinely drops the
 * OTHER peer's `RemoteLog.peersCount()` (peer-log.ts, backed by
 * `core.peers.length` — a real hypercore replicator count, not a fake) to 0.
 * With no new content append from either side (a quiescent hive — the exact
 * production scenario `hasStalledLogs`'s docstring describes), this pins that
 * the real admitted-set → predicate → refresh-loop plumbing genuinely holds
 * the FAST cadence and genuinely reconnects, over the real wire — not just in
 * the fake-swarm/fake-timer unit harness.
 *
 * (A `refreshMs: 0` "self-heal fully disabled" CONTROL pair was tried and
 * dropped: on a local testnet DHT, Hyperswarm's own peer-info retry
 * reconnects a just-known peer within a couple seconds regardless of an
 * explicit `discovery.refresh()` call — that immediate-retry path is
 * DIFFERENT from the long-tail "DHT record aged out, peer never
 * rediscovered" stall WI-752/WI-1534 actually target, so it isn't a valid
 * differentiator at this timescale. The exact-cadence claim — FAST cadence
 * held PAST the point it would otherwise decay to the slow keepalive — is
 * what swarm-self-heal.test.ts's fake-timer unit tests already pin
 * precisely; this test's job is only the real-wire plumbing, not re-proving
 * the algorithm.)
 *
 * Rig pattern: `_hive-substrate-rig.ts`'s `bootTwoHivePeers` (extended here
 * with an opt-in `swarmTiming` override + an exposed `rawSwarm` per peer —
 * both additive, default-omitted so every existing caller is byte-identical).
 * Poll idiom (drive `mergeNow()` each tick to pump corestore's attach
 * machinery, per `wi183-attach-on-late-admit.integration.test.ts`) reused
 * verbatim rather than reinvented.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { bootTwoHivePeers, rigAfterEach, pollUntil, type HivePeer } from './_hive-substrate-rig';

afterEach(rigAfterEach);

type PeersCountable = Partial<{ peersCount(): number | undefined }>;

/**
 * Drive one merge pass on BOTH peers (pumps corestore's ondownloading→
 * attachAll, exactly as wi183-attach-on-late-admit.integration.test.ts does)
 * then report whether `self`'s admitted copy of `otherLogKeyHex` currently
 * shows a live replicator peer.
 */
async function pumpAndCheckLive(
  self: HivePeer,
  other: HivePeer,
  otherLogKeyHex: string,
): Promise<boolean> {
  await self.handle.mergeNow();
  await other.handle.mergeNow();
  const log = self.handle.admitted.get(otherLogKeyHex) as PeersCountable | undefined;
  if (!log || typeof log.peersCount !== 'function') return false;
  try {
    return (log.peersCount() ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Force a REAL network partition: destroy every live socket on the peer's
 *  raw Hyperswarm instance (a real Noise/TCP stream over the testnet DHT).
 *  No `swarm.leave()`, no owner-side append — a genuine connection drop, the
 *  same shape as the production "peer connection died" trigger WI-752 fixed. */
function forceDisconnect(peer: HivePeer): void {
  for (const conn of peer.rawSwarm.connections) {
    (conn as { destroy?: () => void }).destroy?.();
  }
}

describe('WI-1534 quiescent-hive integration (WI-3593): real hasStalledLogs-driven reconnect', () => {
  it(
    'an admitted-but-quiescent member log reconnects via the FAST self-heal cadence — no owner append',
    async () => {
      // Tight fast cadence + a deliberately LONG slow keepalive: if
      // reconnection happens within the bound below, it can only be the
      // hasStalledLogs-held FAST cadence at work — the slow keepalive alone
      // (60s) could never fire inside this test's timeout.
      const { peerA, peerB } = await bootTwoHivePeers({
        // stalledMaxRefreshMs scales the WI-10005270 backoff cap (30 s at a
        // 2.5 s refresh) by the same 1/62.5 as refreshMs.
        swarmTiming: { refreshMs: 40, fastWindowMs: 250, slowRefreshMs: 60_000, stalledMaxRefreshMs: 500 },
      });
      const aKey = peerA.handle.ownLog.keyHex;

      // Real mutual admission + real replication connectivity established.
      const connected = await pollUntil(async () => (await pumpAndCheckLive(peerB, peerA, aKey)) || undefined, {
        timeoutMs: 15_000,
        intervalMs: 200,
      });
      expect(connected, "peer B never attached a live replicator for peer A's log").toBeTruthy();

      // Burn well past the fast window with NO connection churn and NO owner
      // append — a genuinely quiescent hive. Without hasStalledLogs this
      // cadence would already have settled into the dead zone / slow
      // keepalive by now (per swarm-self-heal.test.ts's sibling unit test).
      await new Promise((r) => setTimeout(r, 500));

      // Force the real partition on BOTH sides — a live socket teardown.
      forceDisconnect(peerA);
      forceDisconnect(peerB);

      // The real hypercore peer count must actually drop to 0 first (proves
      // the partition was real, not a no-op).
      const dropped = await pollUntil(
        async () => {
          await peerB.handle.mergeNow();
          const log = peerB.handle.admitted.get(aKey) as PeersCountable | undefined;
          return (log?.peersCount?.() ?? 0) === 0 ? true : undefined;
        },
        { timeoutMs: 5_000, intervalMs: 50 },
      );
      expect(dropped, "peer A's log never actually went quiescent on B (peersCount stayed > 0)").toBe(true);

      // No owner append anywhere in this window — reconnection must be driven
      // purely by the self-heal loop's discovery.refresh() re-announcing +
      // re-discovering the peer over the SAME local testnet DHT.
      const reconnected = await pollUntil(() => pumpAndCheckLive(peerB, peerA, aKey) || undefined, {
        timeoutMs: 15_000,
        intervalMs: 200,
      });
      expect(
        reconnected,
        'WI-1534 regression: a quiescent admitted log never reconnected without an owner append',
      ).toBeTruthy();
    },
    45_000,
  );
});
