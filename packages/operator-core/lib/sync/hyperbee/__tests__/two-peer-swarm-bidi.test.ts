/**
 * two-peer-swarm-bidi.test.ts — Phase-1b BIDIRECTIONAL federation gate-active
 * equivalent (the P-079 surrogate with two DISTINCT real identities admitting
 * each other over the REAL Hyperswarm transport).
 *
 * ## What this proves
 * Alice and Bob are two genuinely distinct peers — distinct Ed25519 keypairs,
 * distinct GitHub-user ids/logins, distinct corestores → distinct log cores.
 * They discover each other on a LOCAL testnet DHT (offline + deterministic),
 * connect over the real Hyperswarm / Noise transport, exchange signed announces
 * on the `papercusp/announce` protomux channel, each ADMITS the other peer, and
 * data flows BOTH ways: Alice's op reaches Bob's apply sink AND Bob's op reaches
 * Alice's apply sink.
 *
 * ## What is stood in for (offline-deterministic)
 * The real write-free binding gate (`verifyAttestation` over the announced
 * attestation gist, via `buildVerifyBindingAdapter`) is replaced by
 * `verifyBindingOverride` — a pure predicate that admits the other peer by
 * `userId`. This is the same offline seam used in `two-peer-swarm.test.ts` for
 * the gate; the admission logic itself is already covered in `two-peer.test.ts`
 * Cases 2-3 + `read-admission` unit tests.
 *
 * ## What IS real and exercised BOTH ways
 * - Distinct signed Ed25519 identities (each peer signs its own announce; the
 *   sig is verified by `verifyAnnounce` over the wire).
 * - DHT discovery + connection (two real `hyperswarm` instances, local testnet).
 * - Noise encrypted streams + `corestore.replicate(socket)`.
 * - The `papercusp/announce` channel (with freshness `ts`).
 * - 3-state admission (`verifyBindingOverride` returns `'verified'`/`'fail'`).
 * - Corestore replication of the remote log.
 * - The read-merge (`mergeNow()`) picking up the remote log's ops.
 * - BOTH directions: A→B and B→A.
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

// ── Async resource teardown (newest-first, mirrors two-peer-swarm.test.ts). ──
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
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

/** A fresh tmp workspace root, registered for teardown. Distinct roots →
 *  distinct corestores → distinct log cores → two genuinely distinct peers. */
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
    userId,
    override: {
      resolveOpts: {
        keychainId,
        resolveGithubUser: async () => ({ id: userId, login }),
        loadKeypair: async (id: string) => ({ keychainId: id, pubkeyBase64: devicePubkey }),
        // Channel-2 gate is stood in for by verifyBindingOverride; the announce
        // just needs a (signed-over) gist id present — a fake suffices here.
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

describe(
  'Phase-1b bidirectional federation — two DISTINCT identities over REAL Hyperswarm (channel-2 gate stood in for by verifyBindingOverride)',
  () => {
    it(
      'A→B and B→A: Alice and Bob each admit the other and each receive the other\'s op',
      async () => {
        // ── Local testnet DHT (offline, deterministic). 3 nodes for a stable
        //    bootstrap; both swarms join it instead of the public DHT. ──
        const testnet = await createTestnet(3);
        cleanups.push(async () => {
          try {
            await testnet.destroy();
          } catch {
            /* ignore */
          }
        });

        // Same binding on both peers → same `deriveSwarmTopic` → same topic.
        const workspaceId = 'ws-bidi-test';
        const harnessSlug = 'sheets';
        const binding = { kind: 'local' as const, workspace_id: workspaceId, harness_slug: harnessSlug };

        // ── Two DISTINCT identities: Alice (userId=42) and Bob (userId=7). ──
        const idAlice = makeIdentityOverride('alice', 42, 'kc-alice');
        const idBob = makeIdentityOverride('bob', 7, 'kc-bob');

        const swarmAlice = makeSwarm(testnet.bootstrap);
        const swarmBob = makeSwarm(testnet.bootstrap);

        // Capturing apply spies — assert which ops merge into each peer, no PG.
        const applyAlice = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);
        const applyBob = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);

        const rootAlice = makeWorkspaceRoot('mb-bidi-Alice-');
        const rootBob = makeWorkspaceRoot('mb-bidi-Bob-');

        let handleAlice: BootedHarnessHandle | undefined;
        let handleBob: BootedHarnessHandle | undefined;

        // ── Boot Alice: admits Bob (userId=7), rejects everyone else. ──
        // The 3-state verifyBindingOverride stands in for channel-2 GitHub-binding
        // admission: in production this fetches/verifies the OTHER peer's published
        // contributor file; here we key off userId to admit exactly Bob.
        handleAlice = await bootHarnessSubstrate({
          workspaceRoot: rootAlice,
          workspaceId,
          harnessSlug,
          swarmBinding: binding,
          swarmOverride: swarmAlice,
          verifyBindingOverride: async (_devicePubkey, _login, userId) =>
            userId === idBob.userId ? 'verified' : 'fail',
          applyOverride: applyAlice,
          mergePollMs: 0, // drive mergeNow() by hand — no leaked timer
          pendingRetryMs: 0, // disable retry timer — not under test
          loadRevokedOverride: async () => new Set(), // avoid real PG in tests
          announceIdentityOverride: idAlice.override,
        });
        cleanups.push(async () => {
          await handleAlice?.close();
          await closeHarnessStore({ workspaceRoot: rootAlice, harnessSlug });
        });

        // ── Boot Bob: admits Alice (userId=42), rejects everyone else. ──
        handleBob = await bootHarnessSubstrate({
          workspaceRoot: rootBob,
          workspaceId,
          harnessSlug,
          swarmBinding: binding,
          swarmOverride: swarmBob,
          verifyBindingOverride: async (_devicePubkey, _login, userId) =>
            userId === idAlice.userId ? 'verified' : 'fail',
          applyOverride: applyBob,
          mergePollMs: 0,
          pendingRetryMs: 0,
          loadRevokedOverride: async () => new Set(), // avoid real PG in tests
          announceIdentityOverride: idBob.override,
        });
        cleanups.push(async () => {
          await handleBob?.close();
          await closeHarnessStore({ workspaceRoot: rootBob, harnessSlug });
        });

        // Both must have joined a swarm (not fallen back to local-only).
        expect(handleAlice.swarm).not.toBeNull();
        expect(handleBob.swarm).not.toBeNull();
        expect(handleAlice.swarm!.topicHex).toBe(handleBob.swarm!.topicHex);

        // ── Alice appends her op to her OWN log. ──
        await handleAlice.append({
          type: 'put',
          table: 'features_consolidated',
          hbKey: 'F-alice-1',
          value: { status: 'in-progress', author: 'alice' },
          ts: 1001,
          schema_version: 1,
          writerPubkey: idAlice.devicePubkey,
        });

        // ── Bob appends his op to his OWN log. ──
        await handleBob.append({
          type: 'put',
          table: 'features_consolidated',
          hbKey: 'F-bob-1',
          value: { status: 'done', author: 'bob' },
          ts: 1002,
          schema_version: 1,
          writerPubkey: idBob.devicePubkey,
        });

        // ── THE BIDIRECTIONAL PROOF ─────────────────────────────────────────────
        // We poll BOTH handles concurrently with bounded retries. On each tick we
        // call mergeNow() on BOTH peers. The poll resolves when BOTH directions
        // have been confirmed. No hand-piping — data crosses via the real
        // Hyperswarm transport (DHT discover → connect → corestore.replicate →
        // remote log update → merge).
        //
        // Direction A→B: Alice's op (F-alice-1) must appear in Bob's apply sink.
        // Direction B→A: Bob's op (F-bob-1) must appear in Alice's apply sink.
        // ────────────────────────────────────────────────────────────────────────

        let capturedByBob: OpEnvelope | undefined;
        let capturedByAlice: OpEnvelope | undefined;

        const bidiResult = await pollUntil(
          async () => {
            // Drive both merge passes every poll tick.
            await Promise.all([handleAlice!.mergeNow(), handleBob!.mergeNow()]);

            // Check what each apply sink has captured so far.
            capturedByBob ??= applyBob.mock.calls.find((c) => c[0].hbKey === 'F-alice-1')?.[0];
            capturedByAlice ??= applyAlice.mock.calls.find((c) => c[0].hbKey === 'F-bob-1')?.[0];

            // Both directions confirmed → truthy sentinel.
            return capturedByBob && capturedByAlice ? { capturedByBob, capturedByAlice } : undefined;
          },
          { timeoutMs: 25_000, intervalMs: 250 },
        );

        // ── ASSERTION: A→B direction (Alice's op reached Bob) ──
        expect(
          bidiResult?.capturedByBob,
          "Bob never received Alice's op over the wire (A→B direction failed)",
        ).toBeTruthy();
        expect(bidiResult!.capturedByBob).toMatchObject({
          table: 'features_consolidated',
          hbKey: 'F-alice-1',
          value: { status: 'in-progress', author: 'alice' },
          ts: 1001,
          writerPubkey: idAlice.devicePubkey,
        });

        // ── ASSERTION: B→A direction (Bob's op reached Alice) ──
        expect(
          bidiResult?.capturedByAlice,
          "Alice never received Bob's op over the wire (B→A direction failed)",
        ).toBeTruthy();
        expect(bidiResult!.capturedByAlice).toMatchObject({
          table: 'features_consolidated',
          hbKey: 'F-bob-1',
          value: { status: 'done', author: 'bob' },
          ts: 1002,
          writerPubkey: idBob.devicePubkey,
        });

        // ── ASSERTION: admitted sets — each peer recorded the other's log core. ──
        // Each admitted set contains at least: own log + the remote peer's log (≥2).
        expect(
          handleAlice.admitted.size,
          "Alice's admitted set should contain at least own + Bob's log",
        ).toBeGreaterThanOrEqual(2);
        expect(
          handleBob.admitted.size,
          "Bob's admitted set should contain at least own + Alice's log",
        ).toBeGreaterThanOrEqual(2);

        // ── SECONDARY: peer_connected boot-history events prove the real
        //    swarm connection handler fired (not just an in-process read). ──
        const connectedEvents = listBootHistory({
          workspaceId,
          harnessSlug,
          kinds: ['peer_connected'],
          limit: 10,
        });
        expect(connectedEvents.length, 'expected at least one peer_connected event').toBeGreaterThan(0);
      },
      40_000,
    );
  },
);
