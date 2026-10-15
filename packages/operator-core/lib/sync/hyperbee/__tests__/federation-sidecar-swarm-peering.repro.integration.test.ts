/**
 * federation-sidecar-swarm-peering.repro.test.ts
 *
 * Plan: shared-hive-member-content-federation-2026-06-20 (D-040, D-043).
 *
 * ## Why this test exists (the live blocker, 2-machine rig run 12)
 * In SUBSTRATE_SIDECAR mode the per-harness substrate engine — Corestore + own
 * log + merge/projection loop + the Hyperswarm join/announce/admission — runs in
 * the SIDECAR process (D-040 routes EVERY boot through the sidecar host). On the
 * live 2-cloud-machine rig, BOTH machines logged
 *   `[substrate-sidecar] [swarm] joined topic cc26bc7d… harness=…`
 * but then `⚠ no peer_connected in ~90s` → federation = 0. The PRIOR run
 * (in-process boot, same .deb minus the D-040 routing) peered fine in the SAME
 * ~90s window. So the question this test settles, FREE + DETERMINISTICALLY:
 *
 *   Does the substrate swarm, when its boot/merge/append are driven THROUGH the
 *   real substrate sidecar HOST (createSubstrateSidecarHost + the REAL
 *   bootHarnessImpl = real joinHarnessSwarm), still discover a peer, connect,
 *   exchange signed announces, admit, and federate BOTH content + coord ops —
 *   OR is moving the engine into the host the regression?
 *
 * If YES (it peers + federates here, same as the in-process control) → the
 * engine relocation is NOT the regression; the live failure is PUBLIC-DHT
 * discovery timing from a freshly-spawned child (not reproducible offline).
 * If NO (it fails here while in-process passes) → the host path itself broke
 * peering and this test red-flags exactly where.
 *
 * ## How it stays deterministic + free
 * Two LOCAL testnet DHTs are NOT needed — both peers share ONE `createTestnet`
 * bootstrap (offline, ephemeral 127.0.0.1 ports → no public DHT, no collision
 * with a sibling test's testnet). Each peer gets its OWN sidecar HOST object
 * (createSubstrateSidecarHost) modelling that machine's sidecar PROCESS; the
 * host's REAL `bootHarnessImpl` is a thin wrapper over `bootHarnessSubstrate`
 * that injects ONLY the offline test seams (a testnet-bootstrapped Hyperswarm,
 * a self-generated Ed25519 identity, a capturing apply sink, the channel-2 gate
 * stub) — the swarm join, announce exchange, admission, replication and merge
 * are all the REAL code paths. Boot / append / merge are driven through the
 * host's JSON-RPC method table (`substrate:bootHarness` / `substrate:appendOp` /
 * `substrate:triggerMergeNow`) so the sidecar RPC surface is on the path, not
 * bypassed.
 *
 * ## Control
 * The SECOND test boots the SAME two peers IN-PROCESS (calling
 * `bootHarnessSubstrate` directly — the known-good path) as the comparison.
 *
 * RUN:
 *   cd packages/operator-core && \
 *     npx vitest run lib/sync/hyperbee/__tests__/federation-sidecar-swarm-peering.repro.test.ts
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import {
  bootHarnessSubstrate,
  type BootedHarnessHandle,
  type BootHarnessOpts,
} from '../boot';
import {
  createSubstrateSidecarHost,
  type SubstrateSidecarHost,
} from '../substrate-sidecar-host';
import { type HyperswarmLike } from '../swarm';
import type { OpEnvelope } from '../op-envelope-types';
import { listBootHistory, _resetBootHistoryForTests } from '../boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';
import { stubHivePolicyReadsForSuite } from './_hive-policy-read-stubs';

// Before this file's own afterEach, so the stub outlives substrate teardown (WI-6554700010008561).
stubHivePolicyReadsForSuite();

// ── Async resource teardown (newest-first, mirrors two-peer-swarm-bidi.test.ts). ──
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      // best-effort — a thrown assertion must not leak a swarm / dir / host
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
 * self-generated Ed25519 keypair: a fake gh user (distinct per peer), an injected
 * keypair, and a signer that signs with the matching private key — so no OS
 * keychain / `gh` is touched and `verifyAnnounce` still passes over the wire.
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
        resolveAttestationGistId: async () => `gist-${login}`,
      },
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

/** Poll `fn()` until it returns truthy or `timeoutMs` elapses. Bounded. */
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

interface PeerControl {
  /** The booted handle — captured for swarm/admitted/close observation. */
  handle: BootedHarnessHandle;
  /** The capturing apply sink — assert which remote ops merged in. */
  apply: ReturnType<typeof vi.fn<(op: OpEnvelope) => Promise<boolean>>>;
  /** The sidecar host RPC store id (sidecar mode only). */
  storeId?: string;
  /** Append a local op via the chosen path (host RPC or direct). */
  append(op: Record<string, unknown>): Promise<void>;
  /** Run one merge pass via the chosen path (host RPC or direct). */
  mergeNow(): Promise<number>;
}

const workspaceId = 'ws-sidecar-peering';
const harnessSlug = 'sheets';
// Same binding on both peers → same deriveSwarmTopic → same topic. `local` keeps
// the boot PG-free (no hive-home registry resolution), like two-peer-swarm-bidi.
const binding = { kind: 'local' as const, workspace_id: workspaceId, harness_slug: harnessSlug };

/**
 * Boot ONE peer THROUGH a dedicated substrate sidecar HOST (its own host object
 * = its own "sidecar process"). The host's REAL bootHarnessImpl wraps
 * `bootHarnessSubstrate`, injecting only the offline seams. Boot / append / merge
 * are driven through the host's JSON-RPC method table.
 */
async function bootPeerViaSidecarHost(args: {
  root: string;
  swarm: HyperswarmLike;
  identity: ReturnType<typeof makeIdentityOverride>;
  admitsUserId: number;
}): Promise<PeerControl> {
  const apply = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);
  let captured: BootedHarnessHandle | undefined;

  const host: SubstrateSidecarHost = createSubstrateSidecarHost({
    // REAL bootHarnessImpl: the genuine bootHarnessSubstrate (real swarm join /
    // announce / admission / merge), with ONLY the offline test seams injected.
    bootHarnessImpl: async (bootOpts: BootHarnessOpts) => {
      const handle = await bootHarnessSubstrate({
        ...bootOpts,
        swarmOverride: args.swarm,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === args.admitsUserId ? 'verified' : 'fail',
        applyOverride: apply,
        mergePollMs: 0, // drive mergeNow() by hand — no leaked timer
        pendingRetryMs: 0, // disable retry timer — not under test
        swarmJoinRetryMs: 0, // join is one-shot here (testnet discovery is instant)
        loadRevokedOverride: async () => new Set(), // avoid real PG
        announceIdentityOverride: args.identity.override,
        rekeyDepsOverride: null, // no re-key build through the live org-admin pool (WI-6554700010008561)
      });
      captured = handle;
      return handle;
    },
    // The relocated send-side wiring (outbox drain + presence) is timer/PG-driven
    // in production; here we no-op it and drive merge/append by hand for
    // determinism (it is not what gates peering).
    wireOutbox: async () => {},
    wirePresence: async () => {},
  });
  cleanups.push(async () => {
    await host.closeAll();
    await closeHarnessStore({ workspaceRoot: args.root, harnessSlug });
  });

  const booted = (await host.methods['substrate:bootHarness']({
    workspaceId,
    harnessSlug,
    workspaceRoot: args.root,
    swarmBinding: binding,
  })) as { storeId: string };

  if (!captured) throw new Error('bootHarnessImpl did not run (host boot failed)');

  return {
    handle: captured,
    apply,
    storeId: booted.storeId,
    append: async (op) => {
      await host.methods['substrate:appendOp']({ storeId: booted.storeId, op });
    },
    mergeNow: async () => {
      const r = (await host.methods['substrate:triggerMergeNow']({
        storeId: booted.storeId,
      })) as { mergedOps: number };
      return r.mergedOps;
    },
  };
}

/** Boot ONE peer IN-PROCESS (the known-good control path) — bootHarnessSubstrate direct. */
async function bootPeerInProcess(args: {
  root: string;
  swarm: HyperswarmLike;
  identity: ReturnType<typeof makeIdentityOverride>;
  admitsUserId: number;
}): Promise<PeerControl> {
  const apply = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);
  const handle = await bootHarnessSubstrate({
    workspaceRoot: args.root,
    workspaceId,
    harnessSlug,
    swarmBinding: binding,
    swarmOverride: args.swarm,
    verifyBindingOverride: async (_pk, _login, userId) =>
      userId === args.admitsUserId ? 'verified' : 'fail',
    applyOverride: apply,
    mergePollMs: 0,
    pendingRetryMs: 0,
    swarmJoinRetryMs: 0,
    loadRevokedOverride: async () => new Set(),
    announceIdentityOverride: args.identity.override,
    rekeyDepsOverride: null, // see the sidecar-hosted boot above (WI-6554700010008561)
  });
  cleanups.push(async () => {
    await handle.close();
    await closeHarnessStore({ workspaceRoot: args.root, harnessSlug });
  });
  return {
    handle,
    apply,
    append: (op) => handle.append(op as never),
    mergeNow: () => handle.mergeNow(),
  };
}

/**
 * The shared body: boot Alice + Bob via `boot`, then assert
 *   (i)  peer_connected fires on BOTH peers,
 *   (ii) each peer admits the other's log,
 *   (iii) a CONTENT op AND a COORD op authored on each peer materialize on the
 *         other (BOTH directions).
 */
async function runBidiPeeringScenario(
  boot: (args: {
    root: string;
    swarm: HyperswarmLike;
    identity: ReturnType<typeof makeIdentityOverride>;
    admitsUserId: number;
  }) => Promise<PeerControl>,
): Promise<void> {
  const testnet = await createTestnet(3);
  cleanups.push(async () => {
    try {
      await testnet.destroy();
    } catch {
      /* ignore */
    }
  });

  const idAlice = makeIdentityOverride('alice', 42, 'kc-alice');
  const idBob = makeIdentityOverride('bob', 7, 'kc-bob');

  const swarmAlice = makeSwarm(testnet.bootstrap);
  const swarmBob = makeSwarm(testnet.bootstrap);
  const rootAlice = makeWorkspaceRoot('mb-sidecar-Alice-');
  const rootBob = makeWorkspaceRoot('mb-sidecar-Bob-');

  const alice = await boot({
    root: rootAlice,
    swarm: swarmAlice,
    identity: idAlice,
    admitsUserId: idBob.userId,
  });
  const bob = await boot({
    root: rootBob,
    swarm: swarmBob,
    identity: idBob,
    admitsUserId: idAlice.userId,
  });

  // Both must have joined a swarm (not fallen back to local-only) on the SAME topic.
  expect(alice.handle.swarm, 'Alice did not join a swarm (fell back to local-only)').not.toBeNull();
  expect(bob.handle.swarm, 'Bob did not join a swarm (fell back to local-only)').not.toBeNull();
  expect(alice.handle.swarm!.topicHex).toBe(bob.handle.swarm!.topicHex);

  // ── Alice authors a CONTENT op + a COORD op on her OWN log. ──
  await alice.append({
    type: 'put',
    table: 'features_consolidated',
    hbKey: 'F-alice-content',
    value: { status: 'in-progress', author: 'alice' },
    ts: 1001,
    schema_version: 1,
    writerPubkey: idAlice.devicePubkey,
  });
  await alice.append({
    type: 'put',
    table: 'coord-messages',
    hbKey: 'M-alice-coord',
    value: { body: 'hello from alice', author: 'alice' },
    ts: 1003,
    schema_version: 1,
    writerPubkey: idAlice.devicePubkey,
  });

  // ── Bob authors a CONTENT op + a COORD op on his OWN log. ──
  await bob.append({
    type: 'put',
    table: 'features_consolidated',
    hbKey: 'F-bob-content',
    value: { status: 'done', author: 'bob' },
    ts: 1002,
    schema_version: 1,
    writerPubkey: idBob.devicePubkey,
  });
  await bob.append({
    type: 'put',
    table: 'coord-messages',
    hbKey: 'M-bob-coord',
    value: { body: 'hello from bob', author: 'bob' },
    ts: 1004,
    schema_version: 1,
    writerPubkey: idBob.devicePubkey,
  });

  // ── THE BIDIRECTIONAL PROOF — data crosses via the REAL Hyperswarm transport
  //    (DHT discover → connect → corestore.replicate → remote log update → merge).
  //    Each tick drives BOTH peers' merge pass; resolves once BOTH directions, for
  //    BOTH a content op AND a coord op, are confirmed. ──
  const found = (
    apply: PeerControl['apply'],
    hbKey: string,
  ): OpEnvelope | undefined => apply.mock.calls.find((c) => c[0].hbKey === hbKey)?.[0];

  const result = await pollUntil(
    async () => {
      await Promise.all([alice.mergeNow(), bob.mergeNow()]);
      const bobGotAliceContent = found(bob.apply, 'F-alice-content');
      const bobGotAliceCoord = found(bob.apply, 'M-alice-coord');
      const aliceGotBobContent = found(alice.apply, 'F-bob-content');
      const aliceGotBobCoord = found(alice.apply, 'M-bob-coord');
      return bobGotAliceContent && bobGotAliceCoord && aliceGotBobContent && aliceGotBobCoord
        ? { bobGotAliceContent, bobGotAliceCoord, aliceGotBobContent, aliceGotBobCoord }
        : undefined;
    },
    { timeoutMs: 30_000, intervalMs: 250 },
  );

  // ── A→B: Alice's content op reached Bob. ──
  expect(
    result?.bobGotAliceContent,
    "Bob never received Alice's CONTENT op over the wire (A→B content failed)",
  ).toBeTruthy();
  expect(result!.bobGotAliceContent).toMatchObject({
    table: 'features_consolidated',
    hbKey: 'F-alice-content',
    value: { status: 'in-progress', author: 'alice' },
  });
  // ── A→B: Alice's coord op reached Bob. ──
  expect(
    result?.bobGotAliceCoord,
    "Bob never received Alice's COORD op over the wire (A→B coord failed)",
  ).toBeTruthy();
  expect(result!.bobGotAliceCoord).toMatchObject({
    table: 'coord-messages',
    hbKey: 'M-alice-coord',
  });

  // ── B→A: Bob's content op reached Alice. ──
  expect(
    result?.aliceGotBobContent,
    "Alice never received Bob's CONTENT op over the wire (B→A content failed)",
  ).toBeTruthy();
  expect(result!.aliceGotBobContent).toMatchObject({
    table: 'features_consolidated',
    hbKey: 'F-bob-content',
    value: { status: 'done', author: 'bob' },
  });
  // ── B→A: Bob's coord op reached Alice. ──
  expect(
    result?.aliceGotBobCoord,
    "Alice never received Bob's COORD op over the wire (B→A coord failed)",
  ).toBeTruthy();

  // ── Admitted sets: each peer recorded the other's log core (own + remote ≥2). ──
  expect(
    alice.handle.admitted.size,
    "Alice's admitted set should contain at least own + Bob's log",
  ).toBeGreaterThanOrEqual(2);
  expect(
    bob.handle.admitted.size,
    "Bob's admitted set should contain at least own + Alice's log",
  ).toBeGreaterThanOrEqual(2);

  // ── peer_connected boot-history fired on BOTH peers (the real swarm connection
  //    handler ran — this is the EXACT event the live rig never saw in ~90s). ──
  const connected = listBootHistory({
    workspaceId,
    harnessSlug,
    kinds: ['peer_connected'],
    limit: 20,
  });
  expect(
    connected.length,
    'expected at least one peer_connected event (the live-rig blocker symptom)',
  ).toBeGreaterThan(0);
}

describe('SUBSTRATE_SIDECAR swarm peering — does the sidecar-HOSTED substrate engine peer + federate? (testnet DHT, D-040/D-043)', () => {
  it(
    'SIDECAR HOST boot: two peers booted THROUGH createSubstrateSidecarHost peer_connect + federate content & coord BOTH ways',
    async () => {
      await runBidiPeeringScenario(bootPeerViaSidecarHost);
    },
    60_000,
  );

  it(
    'CONTROL — IN-PROCESS boot: the same two peers peer_connect + federate content & coord BOTH ways',
    async () => {
      await runBidiPeeringScenario(bootPeerInProcess);
    },
    60_000,
  );
});
