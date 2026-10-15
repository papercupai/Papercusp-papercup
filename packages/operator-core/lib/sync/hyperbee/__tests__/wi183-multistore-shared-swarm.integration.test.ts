/**
 * wi183-multistore-shared-swarm.integration.test.ts — WI-183 M1, the MULTI-STORE
 * / SHARED-SWARM leg of the "admitted-but-never-attached" reproduction.
 *
 * The sibling probe (wi183-attach-on-late-admit.integration.test.ts) proved the
 * SINGLE-topic case green: one corestore per peer, admit-after-connect, and the
 * admitted remote log attaches a live replicator (corestore ondownloading→
 * attachAll driven by mergeOnePass's per-remote update()). So a naive
 * re-attach-on-admit fix is a no-op — the rig failure must live in structure the
 * single-topic test does not have.
 *
 * The rig's ACTUAL topology (su-35c3b's frames, confirmed from code): per-harness
 * SEPARATE corestores — cacheKey `${workspaceRoot}::${harnessSlug}`
 * (corestore.ts:50) — all replicating over ONE process-singleton shared
 * Hyperswarm (swarm.ts getSharedSwarm). hello-world's topic joins first and
 * forms the socket; hello-world-hive joins LATER, so its joinHarnessSwarm never
 * sees a 'connection' event for the existing socket and instead runs the
 * late-join loop (swarm.ts:886-903): re-running the handler over
 * swarm.connections — a SECOND store.replicate(socket) on an already-muxed
 * socket + a second openAnnounceChannel on the same muxer.
 *
 * This test reproduces THAT ordering in-process over the real testnet-DHT
 * transport: two "machines", each ONE swarm + TWO harness substrates (h1, h2 —
 * same workspaceRoot, different slug ⇒ separate corestores, exactly the rig's
 * root::slug split). h1 boots on both machines and federates (control — known
 * green). THEN h2 boots on the SAME swarm instances, exercising the topic-2
 * late-join path over the existing socket.
 *
 * RED here (h2 admitted logs stuck at peersCount 0 while h1's attach fine)
 * = the rig's WI-183 gap reproduced in-process ⇒ fix at the multi-store
 *   replicate/attach seam, then flip THIS test green before any .deb ships.
 * GREEN here = the in-process multi-store path also works ⇒ the rig failure is
 *   environmental/transport-specific and su-35c3b's live datums (#1: peers==0
 *   while replicator.downloading==true?) pick the next seam.
 */
import { afterEach, describe, it, expect } from 'vitest';
import {
  rigAfterEach,
  pollUntil,
  cleanups,
  ensureRigHivePolicyReadStub,
  makeIdentity,
  makeSwarm,
  makeTestnet,
  makeWorkspaceRoot,
} from './_cross-peer-rig';
import { bootHarnessSubstrate, type BootedHarnessHandle } from '../boot';
import type { HyperswarmLike } from '../swarm';

const WS = 'ws-ms-shared-swarm';
const H1 = 'ms-h1';
const H2 = 'ms-h2';

type AdmittedLog = { peersCount?: () => number | undefined } | undefined;

/** Boot one harness substrate onto an EXISTING (possibly shared) swarm. */
async function bootHarnessOn(opts: {
  swarm: HyperswarmLike;
  root: string;
  slug: string;
  identity: ReturnType<typeof makeIdentity>;
  /** The ONE remote userId this substrate admits (mutual-admission pairing). */
  admitUserId: number;
}): Promise<BootedHarnessHandle> {
  ensureRigHivePolicyReadStub();
  const handle = await bootHarnessSubstrate({
    workspaceRoot: opts.root,
    workspaceId: WS,
    harnessSlug: opts.slug,
    swarmBinding: { kind: 'local', workspace_id: WS, harness_slug: opts.slug },
    swarmOverride: opts.swarm,
    verifyBindingOverride: async (_pk, _login, userId) =>
      userId === opts.admitUserId ? 'verified' : 'fail',
    // Attach is the signal under test — projections are irrelevant here.
    applyOverride: async () => true,
    mergePollMs: 0,
    pendingRetryMs: 0,
    reverifyIntervalMs: 0,
    loadRevokedOverride: async () => new Set(),
    announceIdentityOverride: opts.identity.override,
    rekeyDepsOverride: null, // no re-key build through the live org-admin pool (WI-6554700010008561)
  });
  // handle.close() leaves the topic + closes/evicts the store; the shared swarm
  // itself is destroyed by makeSwarm's own cleanup entry.
  cleanups.push(() => handle.close());
  return handle;
}

describe('WI-183 — multi-store shared-swarm: a topic joined AFTER the socket exists must still attach admitted logs', () => {
  afterEach(rigAfterEach);

  it(
    'h2 (late topic, second corestore on the SAME socket) admitted logs attach a live replicator on both sides',
    async () => {
      const testnet = await makeTestnet();
      const idA = makeIdentity('alice', 42, 'kc-ms-alice');
      const idB = makeIdentity('bob', 7, 'kc-ms-bob');
      // ONE swarm per machine — the process-singleton stand-in. Both harnesses
      // on a machine share it, exactly like getSharedSwarm() in production.
      const swarmA = makeSwarm(testnet.bootstrap);
      const swarmB = makeSwarm(testnet.bootstrap);
      // ONE workspaceRoot per machine — h1/h2 get SEPARATE corestores via the
      // root::slug cache split, matching the rig.
      const rootA = makeWorkspaceRoot('wi183-msA-');
      const rootB = makeWorkspaceRoot('wi183-msB-');

      // ── Phase 1 (control): h1 boots on both machines; its topic forms the socket.
      const a1 = await bootHarnessOn({ swarm: swarmA, root: rootA, slug: H1, identity: idA, admitUserId: idB.userId });
      const b1 = await bootHarnessOn({ swarm: swarmB, root: rootB, slug: H1, identity: idB, admitUserId: idA.userId });

      const h1Admitted = await pollUntil(
        async () => {
          await a1.mergeNow();
          await b1.mergeNow();
          const aOnB = b1.admitted.get(a1.ownLog.keyHex) as AdmittedLog;
          const bOnA = a1.admitted.get(b1.ownLog.keyHex) as AdmittedLog;
          return aOnB && bOnA ? { aOnB, bOnA } : undefined;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(h1Admitted, 'CONTROL failed: h1 (first topic) never mutually admitted').toBeTruthy();

      const h1Attached = await pollUntil(
        async () => {
          await a1.mergeNow();
          await b1.mergeNow();
          const pa = h1Admitted!.aOnB!.peersCount?.() ?? 0;
          const pb = h1Admitted!.bOnA!.peersCount?.() ?? 0;
          return pa > 0 && pb > 0 ? { pa, pb } : undefined;
        },
        { timeoutMs: 15_000, intervalMs: 250 },
      );
      expect(
        h1Attached,
        'CONTROL failed: h1 admitted logs never attached (single-topic attach is known-green — rig fault?)',
      ).toBeTruthy();

      // ── Phase 2: h2 boots on the SAME swarms — its join finds the socket
      // already open, so replication+announce for topic-2 ride the late-join
      // loop (swarm.ts:886-903) onto the EXISTING muxer.
      const a2 = await bootHarnessOn({ swarm: swarmA, root: rootA, slug: H2, identity: idA, admitUserId: idB.userId });
      const b2 = await bootHarnessOn({ swarm: swarmB, root: rootB, slug: H2, identity: idB, admitUserId: idA.userId });

      // Sanity: h2 is a genuinely distinct topic shared by both machines.
      expect(a2.swarm!.topicHex).toBe(b2.swarm!.topicHex);
      expect(a2.swarm!.topicHex).not.toBe(a1.swarm!.topicHex);

      // h2 admission: announce frames for topic-2 must cross the SHARED muxer.
      const h2Admitted = await pollUntil(
        async () => {
          await a2.mergeNow();
          await b2.mergeNow();
          const aOnB = b2.admitted.get(a2.ownLog.keyHex) as AdmittedLog;
          const bOnA = a2.admitted.get(b2.ownLog.keyHex) as AdmittedLog;
          return aOnB && bOnA ? { aOnB, bOnA } : undefined;
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(
        h2Admitted,
        'h2 (late topic) never mutually admitted — the topic-2 announce channel is dead on the shared muxer ' +
          '(NOTE: this is an ADMISSION-layer failure, upstream of the WI-183 attach signal)',
      ).toBeTruthy();

      // ── THE WI-183 SIGNAL: the admitted h2 logs (second corestore, same
      // socket) must show a LIVE replicator peer after repeated merge passes.
      const h2Attached = await pollUntil(
        async () => {
          await a2.mergeNow();
          await b2.mergeNow();
          const pa = h2Admitted!.aOnB!.peersCount?.() ?? 0;
          const pb = h2Admitted!.bOnA!.peersCount?.() ?? 0;
          return pa > 0 && pb > 0 ? { pa, pb } : undefined;
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(
        h2Attached,
        'WI-183 multi-store gap REPRODUCED: the LATE topic’s admitted logs (second corestore replicating ' +
          'over the SAME already-muxed socket) show 0 live replicator peers after repeated merge passes, ' +
          'while the FIRST topic’s logs attached fine — the attach/serve seam loses the second store',
      ).toBeTruthy();
      expect(h2Attached!.pa, "A's h2 log on B has no live replicator peer").toBeGreaterThan(0);
      expect(h2Attached!.pb, "B's h2 log on A has no live replicator peer").toBeGreaterThan(0);
    },
    150_000,
  );
});
