/**
 * two-hive-shared-swarm.test.ts — A-002 regression: an instance hosting TWO
 * hives must NOT stall either hive's federation. The REAL-wire proof.
 *
 * ## The A-002 topology (what this reproduces)
 * Real deployments host more than one hive per box. Every hive on an instance
 * shares ONE process-singleton Hyperswarm (`swarm.ts` `_sharedSwarm`). When two
 * instances connect, Hyperswarm establishes ONE connection per peer pair, so
 * BOTH hives' `joinHarnessSwarm` connection-handlers fire on ONE socket → ONE
 * Protomux muxer. The signed-announce exchange (`papercusp/announce`) was opened
 * with the protocol ALONE as the channel key, so the 2nd hive's `createChannel`
 * collided (protomux `unique` → null) and its announce was silently dropped →
 * that hive's log was never admitted → ZERO apply, both directions, while
 * `peer_connected` + topic-equal still looked healthy. The fix discriminates the
 * announce channel PER HIVE by its 32-byte topic id.
 *
 * This test boots TWO instances, each running ONE shared swarm that hosts TWO
 * hives (two harness slugs → two `deriveSwarmTopic` topics), in the exact
 * "stand up a 2nd hive after the 1st" order, over a local testnet DHT — the same
 * REAL transport `two-peer-swarm.test.ts` uses (DHT discovery + connect +
 * `corestore.replicate` + announce over the shared muxer + merge). It then
 * asserts BOTH hives federate BOTH directions.
 *
 * PRE-FIX this is RED on the 2nd hive (beta) — its announce never crosses, so
 * its apply spy never fires. POST-FIX all four crossings pass. Teeth-verified:
 * reverting the per-hive `id` in `swarm.ts` flips the beta assertions RED.
 *
 * Channel-2 GitHub-binding admission is bypassed (`verifyBindingOverride`), like
 * two-peer-swarm.test.ts — this validates the multi-hive TRANSPORT, not the
 * binding gate. The announce SIGNATURE check is NOT bypassed.
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
import { _resetBootHistoryForTests } from '../boot-history';
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

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* best-effort — a thrown assertion must not leak a swarm/dir */
    }
  }
  _resetCacheForTests();
  _resetBootHistoryForTests();
});

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

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

/** One device identity (faithful: one box = one device, used across its hives). */
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
        resolveAttestationGistId: async () => `gist-${login}`,
      },
      sign: async (_keychainId: string, bytes: Buffer) => nodeSign(null, bytes, privateKey),
    },
  };
}

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

describe('A-002 — two hives on ONE shared swarm both federate (multi-hive transport)', () => {
  it(
    'a 2nd hive on an instance does NOT stall the 1st: both hives federate both directions',
    async () => {
      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      const workspaceId = 'ws-multihive';
      // Two hives = two distinct harness slugs → two distinct swarm topics.
      const ALPHA = 'hive-alpha';
      const BETA = 'hive-beta';
      const bindAlpha = { kind: 'local' as const, workspace_id: workspaceId, harness_slug: ALPHA };
      const bindBeta = { kind: 'local' as const, workspace_id: workspaceId, harness_slug: BETA };

      const idA = makeIdentityOverride('alice', 4242, 'kc-alice');
      const idB = makeIdentityOverride('bob', 7, 'kc-bob');

      // ONE shared singleton swarm per INSTANCE — the A-002 crux. Both of an
      // instance's hives join this same swarm, so a peer connection lands BOTH
      // hive handlers on ONE muxer.
      const swarmA = makeSwarm(testnet.bootstrap);
      const swarmB = makeSwarm(testnet.bootstrap);

      const rootA = makeWorkspaceRoot('mh-A-');
      const rootB = makeWorkspaceRoot('mh-B-');

      const applyA_alpha = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);
      const applyA_beta = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);
      const applyB_alpha = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);
      const applyB_beta = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);

      async function bootHive(
        root: string,
        swarm: HyperswarmLike,
        binding: { kind: 'local'; workspace_id: string; harness_slug: string },
        id: ReturnType<typeof makeIdentityOverride>,
        apply: ReturnType<typeof vi.fn>,
      ): Promise<BootedHarnessHandle> {
        const h = await bootHarnessSubstrate({
          workspaceRoot: root,
          workspaceId,
          harnessSlug: binding.harness_slug,
          swarmBinding: binding,
          swarmOverride: swarm,
          verifyBindingOverride: async () => 'verified',
          applyOverride: apply,
          mergePollMs: 0,
          pendingRetryMs: 0,
          loadRevokedOverride: async () => new Set(),
          announceIdentityOverride: id.override,
        });
        cleanups.push(async () => {
          await h.close();
          await closeHarnessStore({ workspaceRoot: root, harnessSlug: binding.harness_slug });
        });
        return h;
      }

      // Stand up hive-1 (alpha) on BOTH instances FIRST, then hive-2 (beta) on
      // both — the exact "add a 2nd hive after the 1st" sequence A-002 breaks
      // (beta boots onto a muxer that already holds alpha's announce channel).
      const aAlpha = await bootHive(rootA, swarmA, bindAlpha, idA, applyA_alpha);
      const bAlpha = await bootHive(rootB, swarmB, bindAlpha, idB, applyB_alpha);
      const aBeta = await bootHive(rootA, swarmA, bindBeta, idA, applyA_beta);
      const bBeta = await bootHive(rootB, swarmB, bindBeta, idB, applyB_beta);

      // Each hive joined a swarm; same hive across instances shares a topic.
      for (const [x, y] of [
        [aAlpha, bAlpha],
        [aBeta, bBeta],
      ] as const) {
        expect(x.swarm).not.toBeNull();
        expect(y.swarm).not.toBeNull();
        expect(x.swarm!.topicHex).toBe(y.swarm!.topicHex);
      }
      // The two hives are genuinely distinct topics (else it isn't "two hives").
      expect(aAlpha.swarm!.topicHex).not.toBe(aBeta.swarm!.topicHex);

      // Append on `from`, poll `to.mergeNow()` until `applySpy` captures the op.
      async function crosses(
        from: BootedHarnessHandle,
        to: BootedHarnessHandle,
        applySpy: ReturnType<typeof vi.fn>,
        hbKey: string,
        writerPubkey: string,
      ): Promise<OpEnvelope | undefined> {
        await from.append({
          type: 'put',
          table: 'features_consolidated',
          hbKey,
          value: { status: 'todo' },
          ts: 1000,
          schema_version: 1,
          writerPubkey,
        });
        return pollUntil(
          async () => {
            await to.mergeNow();
            return applySpy.mock.calls.find((c) => c[0].hbKey === hbKey)?.[0] as
              | OpEnvelope
              | undefined;
          },
          { timeoutMs: 25_000, intervalMs: 250 },
        );
      }

      // hive-1 (alpha) A→B — the 1st hive must federate.
      expect(
        await crosses(aAlpha, bAlpha, applyB_alpha, 'F-alpha-AB', idA.devicePubkey),
        'hive-alpha A→B did not cross',
      ).toBeTruthy();

      // hive-2 (beta) A→B — THE A-002 ASSERTION. Pre-fix this STALLS: beta's
      // announce channel collides with alpha's on the shared muxer, so beta is
      // never admitted on B → applyB_beta never fires.
      expect(
        await crosses(aBeta, bBeta, applyB_beta, 'F-beta-AB', idA.devicePubkey),
        'A-002: hive-beta A→B did not cross (2nd hive stalled on the shared muxer)',
      ).toBeTruthy();

      // hive-2 (beta) B→A — the other direction also crosses.
      expect(
        await crosses(bBeta, aBeta, applyA_beta, 'F-beta-BA', idB.devicePubkey),
        'A-002: hive-beta B→A did not cross',
      ).toBeTruthy();

      // hive-1 (alpha) B→A — the 1st hive is not stalled by the 2nd.
      expect(
        await crosses(bAlpha, aAlpha, applyA_alpha, 'F-alpha-BA', idB.devicePubkey),
        'hive-alpha B→A did not cross',
      ).toBeTruthy();
    },
    90_000,
  );
});
