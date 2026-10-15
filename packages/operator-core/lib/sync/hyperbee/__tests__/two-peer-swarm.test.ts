/**
 * two-peer-swarm.test.ts — Model B substrate: the REAL Hyperswarm TRANSPORT
 * proof for two peers on one box.
 *
 * Plan: papercusp-substrate-model-b-impl-2026-06-01 — this is the P-079
 * "same-box transport surrogate": it boots two REAL `bootHarnessSubstrate`
 * peers, joins them to the same swarm topic over a LOCAL testnet DHT
 * (`hyperdht/testnet.js`, offline + deterministic), and proves that a write on
 * peer A lands in peer B's apply sink via the ACTUAL replication path — peers
 * discover each other on the DHT, connect, `corestore.replicate(socket)` over
 * the live secret-stream, exchange signed announces on the `papercusp/announce`
 * protomux channel, admit, and the remote log replicates.
 *
 * ## What this PROVES (the gap `two-peer.test.ts` deliberately stubbed)
 * `two-peer.test.ts` proves the read-merge / admission LOGIC but STUBS the
 * transport — it hand-pipes one store's replication stream into the other and
 * hand-feeds the merge. THIS test exercises the real wire end-to-end: two
 * independent `hyperswarm` instances, DHT discovery, the connection handler in
 * `swarm.ts` firing for real, the announce channel exchanging frames over the
 * shared muxer, and `mergeNow()` on B picking up A's op once the remote core
 * replicates. No hand-piping, no hand-fed merge.
 *
 * ## What this INTENTIONALLY does NOT prove
 * The channel-2 GitHub-binding admission gate is BYPASSED via
 * `verifyBindingOverride: async () => true`. This test validates TRANSPORT, not
 * the gate. The gate needs GitHub-published two-channel bindings (a contributor
 * file on `user/<id>` + an OAuth `GET /user`) that don't exist in an offline
 * runner, and it is already unit-tested elsewhere — see `read-admission`'s tests
 * and `two-peer.test.ts` Cases 2-3 (forged binding / tampered announce / revoke).
 * The announce SIGNATURE check (`verifyAnnounce`) is NOT bypassed: each peer
 * signs its announce with a real in-test Ed25519 key whose raw-32-byte pubkey is
 * the announced `device_pubkey`, so the sig genuinely verifies over the wire.
 *
 * ## The identity seam (why the boot override is needed)
 * `bootHarnessSubstrate`'s production announce path calls
 * `resolveLocalAnnounceIdentity()` (gh-token `GET /user` + OS keychain device
 * key) and signs via `signWithDeviceKey` (keychain private key). Both throw /
 * pollute the user's real identity in a test runner, and boot's catch would then
 * keep the harness LOCAL-ONLY (no swarm join → no replication → unprovable).
 * So we inject `announceIdentityOverride`: a fake `resolveGithubUser` + a
 * self-generated keypair (via `loadKeypair`/`keychainId`) + a `sign` that signs
 * with the matching in-test private key — no OS keychain, no `gh`, but a real
 * signable key so `verifyAnnounce` passes. This is the same crypto the rest of
 * the substrate uses (Node Ed25519, raw-32-byte-base64 pubkey, `sign(null, …)`).
 *
 * ## Why a normal `*.test.ts` (no Docker / PG)
 * Like `two-peer.test.ts`: `applyOverride` captures merged ops with a `vi.fn()`
 * spy, so the projection→PG final hop is never touched. It DOES use loopback UDP
 * for the local testnet DHT, so timeouts are generous and polling is bounded.
 *
 * Resource hygiene: both handles are closed, both swarms destroyed, the testnet
 * destroyed, the corestore cache reset, and every temp dir removed in
 * `afterEach` — no leaked timers (`mergePollMs: 0`), sockets, or DHT nodes.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import {
  bootHarnessSubstrate as bootHarnessSubstrateImpl,
  type BootedHarnessHandle,
  type BootHarnessOpts,
} from '../boot';
import { type HyperswarmLike } from '../swarm';
import type { OpEnvelope } from '../op-envelope-types';
import { listBootHistory, _resetBootHistoryForTests } from '../boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';
import { stubHivePolicyReadsForSuite } from './_hive-policy-read-stubs';

// WI-10007530: no PG here, and the merge pass no longer swallows a failed policy read.
stubHivePolicyReadsForSuite();

/**
 * Keep this suite hermetic. Production resolves re-key dependencies
 * fail-closed, but these unit cases exercise the substrate with no real PG.
 * Individual tests can still override this default through the existing seam.
 */
function bootHarnessSubstrate(opts: BootHarnessOpts) {
  return bootHarnessSubstrateImpl({ rekeyDepsOverride: null, ...opts });
}

// ── Async resource teardown (mirrors two-peer.test.ts's `cleanups`, async). ──
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  // Tear down newest-first so handles close before their stores/dirs vanish.
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      // best-effort — a thrown assertion must not leak a swarm/dir
    }
  }
  _resetCacheForTests();
  _resetBootHistoryForTests();
});

/** A fresh tmp workspace root, registered for teardown. Distinct roots → distinct
 *  corestores → distinct per-peer log cores → two genuinely distinct peers. */
function makeWorkspaceRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return dir;
}

/** Raw 32-byte Ed25519 pubkey, base64 — the binding's `device_pubkey` convention. */
function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

/**
 * Build a `bootHarnessSubstrate` `announceIdentityOverride` for a peer with a
 * self-generated Ed25519 keypair: a fake gh user (distinct per peer), an
 * injected keypair, and a signer that signs with the matching private key — so
 * no OS keychain / `gh` is touched and `verifyAnnounce` still passes.
 */
function makeIdentityOverride(login: string, userId: number, keychainId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = rawPubkeyBase64(publicKey);
  return {
    devicePubkey,
    override: {
      resolveOpts: {
        keychainId,
        resolveGithubUser: async () => ({ id: userId, login }),
        loadKeypair: async (id: string) => ({ keychainId: id, pubkeyBase64: devicePubkey }),
        // Transport test: admission is stubbed; the announce just needs a
        // (signed-over) gist id present — a fake suffices.
        resolveAttestationGistId: async () => `gist-${login}`,
      },
      // Sign with the in-test private key (NOT the keychain) — the matching key
      // for `devicePubkey`, so the announce sig verifies over the wire.
      sign: async (_keychainId: string, bytes: Buffer) => nodeSign(null, bytes, privateKey),
    },
  };
}

/** A real `hyperswarm` bootstrapped to the local testnet DHT (offline). Destroyed in teardown. */
function makeSwarm(bootstrap: unknown): HyperswarmLike {
  const swarm = new Hyperswarm({ bootstrap }) as unknown as HyperswarmLike & {
    destroy(): Promise<void>;
  };
  cleanups.push(async () => {
    try {
      await swarm.destroy();
    } catch {
      /* ignore */
    }
  });
  return swarm;
}

/** Poll `fn()` until it returns truthy or `timeoutMs` elapses. Bounded — never
 *  an unbounded await. Returns the truthy value, or undefined on timeout. */
async function pollUntil<T>(
  fn: () => T | Promise<T>,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('Model B substrate — two peers over REAL Hyperswarm (transport, channel-2 gate bypassed)', () => {
  it(
    "replicates over the wire: peer A's write reaches peer B's apply sink via real Hyperswarm + announce + merge",
    async () => {
      // ── Local testnet DHT (offline, deterministic). 3 nodes is the testnet default
      //    for a stable bootstrap; both swarms join it instead of the public DHT. ──
      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      // Same binding on both peers → same `deriveSwarmTopic` → same swarm topic.
      const workspaceId = 'ws-transport-test';
      const harnessSlug = 'sheets';
      const binding = { kind: 'local' as const, workspace_id: workspaceId, harness_slug: harnessSlug };

      const idA = makeIdentityOverride('alice', 4242, 'test-keychain-alice');
      const idB = makeIdentityOverride('bob', 7, 'test-keychain-bob');

      const swarmA = makeSwarm(testnet.bootstrap);
      const swarmB = makeSwarm(testnet.bootstrap);

      // Capturing apply spies — assert which ops merge into each peer, no PG.
      const applyA = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);
      const applyB = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);

      const rootA = makeWorkspaceRoot('mb2sw-A-');
      const rootB = makeWorkspaceRoot('mb2sw-B-');

      let handleA: BootedHarnessHandle | undefined;
      let handleB: BootedHarnessHandle | undefined;

      // Boot both peers with the real swarm injected + the offline identity seam.
      handleA = await bootHarnessSubstrate({
        workspaceRoot: rootA,
        workspaceId,
        harnessSlug,
        swarmBinding: binding,
        swarmOverride: swarmA,
        verifyBindingOverride: async () => 'verified',
        applyOverride: applyA,
        mergePollMs: 0, // drive mergeNow() by hand — no leaked timer
        pendingRetryMs: 0, // disable retry timer — not under test here
        loadRevokedOverride: async () => new Set(), // avoid real PG in tests
        announceIdentityOverride: idA.override,
      });
      cleanups.push(async () => {
        await handleA?.close();
        await closeHarnessStore({ workspaceRoot: rootA, harnessSlug });
      });

      handleB = await bootHarnessSubstrate({
        workspaceRoot: rootB,
        workspaceId,
        harnessSlug,
        swarmBinding: binding,
        swarmOverride: swarmB,
        verifyBindingOverride: async () => 'verified',
        applyOverride: applyB,
        mergePollMs: 0,
        pendingRetryMs: 0, // disable retry timer — not under test here
        loadRevokedOverride: async () => new Set(), // avoid real PG in tests
        announceIdentityOverride: idB.override,
      });
      cleanups.push(async () => {
        await handleB?.close();
        await closeHarnessStore({ workspaceRoot: rootB, harnessSlug });
      });

      // Both must have joined a swarm (not fallen back to local-only).
      expect(handleA.swarm).not.toBeNull();
      expect(handleB.swarm).not.toBeNull();
      expect(handleA.swarm!.topicHex).toBe(handleB.swarm!.topicHex);

      // ── Peer A appends one op to its OWN log. ──
      await handleA.append({
        type: 'put',
        table: 'features_consolidated',
        hbKey: 'F-wire-1',
        value: { status: 'todo' },
        ts: 1000,
        schema_version: 1,
        writerPubkey: idA.devicePubkey,
      });

      // ── THE PROOF: with NO hand-piping, A's op crosses to B over the real
      //    Hyperswarm transport. We poll B's mergeNow() (which update()s the
      //    remote log + re-merges) until B's apply spy captures A's op. The
      //    bound is generous (DHT discovery + connect + replicate is seconds). ──
      const captured = await pollUntil(
        async () => {
          await handleB!.mergeNow();
          return applyB.mock.calls.find((c) => c[0].hbKey === 'F-wire-1')?.[0];
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );

      expect(captured, "peer B never received peer A's op over the wire").toBeTruthy();
      expect(captured).toMatchObject({
        table: 'features_consolidated',
        hbKey: 'F-wire-1',
        value: { status: 'todo' },
        ts: 1000,
        writerPubkey: idA.devicePubkey,
      });

      // ── SECONDARY: B recorded a `peer_connected` boot-history event — proves
      //    the swarm connection handler fired (not just an in-process read). ──
      const connectedEvents = listBootHistory({
        workspaceId,
        harnessSlug,
        kinds: ['peer_connected'],
        limit: 10,
      });
      expect(connectedEvents.length).toBeGreaterThan(0);

      // ── B admitted A's log (announce exchanged + admission passed over the
      //    real wire). A's log core key is in B's admitted set. ──
      expect(handleB.admitted.size).toBeGreaterThanOrEqual(2); // own + A's remote
    },
    35_000,
  );
});
