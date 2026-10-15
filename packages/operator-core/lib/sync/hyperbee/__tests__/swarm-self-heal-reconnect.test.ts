/**
 * swarm-self-heal-reconnect.test.ts — WI-752 / FED-2 real-transport proof:
 * federation RE-ESTABLISHES after a connection drop with NO manual refresh and
 * NO operator restart, driven solely by the PRODUCTION self-heal loop now in
 * `joinHarnessSwarm`.
 *
 * Sibling to two-peer-swarm.test.ts (the same real-Hyperswarm-over-offline-
 * testnet rig + offline identity seam) and swarm-chaos.test.ts. The crucial
 * difference: swarm-chaos.test.ts drives reconnect by calling
 * `discovery.refresh()` from the TEST harness (`forceReconnectAll`) — it proves
 * the wire can recover, not that production recovers ITSELF. This test NEVER
 * touches refresh: it kills the live connection, then waits for the substrate's
 * own two-speed re-peer loop (booted with a fast `swarmRefreshMs`) to rediscover
 * + reconnect + re-replicate so a SECOND write crosses. That is exactly the
 * "induce a swarm drop → federation re-establishes within a bounded time with NO
 * manual restart" deliverable.
 *
 * Why a normal `*.test.ts` (no Docker/PG): apply sinks are `vi.fn()` spies, the
 * DHT is the offline loopback testnet, every wait is a BOUNDED poll, and all
 * resources (handles, swarms, testnet, stores, dirs) are torn down in afterEach.
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
import { _setSwarmGuardForTests, type SwarmGuard } from '../swarm-guard';
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

/**
 * On a one-box rig every peer shares 127.0.0.1, so kill→reconnect churn would
 * trip the DoS guard's per-IP connection-rate limit and cross-ban the honest
 * peers (the swarm-chaos rig hit the same EI-272 red). This test does a single
 * kill, but swap in an allow-all guard for robustness — it exercises the
 * REPLICATION self-heal, not the DoS ceiling (which has its own unit suite).
 */
const RIG_GUARD: SwarmGuard = {
  firewall: () => false,
  isBannedKey: () => false,
  isBannedIp: () => false,
  banKey: () => {},
  banIp: () => {},
  recordConnection: async () => ({ allow: true }),
};

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* best-effort */
    }
  }
  _setSwarmGuardForTests(null);
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

function makeSwarm(bootstrap: unknown): HyperswarmLike & { destroy(): Promise<void> } {
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

/** Destroy every live connection on a swarm (the mid-replication kill). */
function killConnections(swarm: HyperswarmLike): number {
  let killed = 0;
  for (const sock of (swarm.connections ?? []) as Iterable<{ destroy(): void }>) {
    try {
      sock.destroy();
      killed++;
    } catch {
      /* best-effort */
    }
  }
  return killed;
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

describe('FED-2 self-heal — substrate re-peers after a connection drop with NO manual refresh', () => {
  it(
    'a write made AFTER the live connection is killed still crosses once the self-heal loop reconnects',
    async () => {
      _setSwarmGuardForTests(RIG_GUARD);

      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      const workspaceId = 'ws-self-heal';
      const harnessSlug = 'sheets';
      const binding = { kind: 'local' as const, workspace_id: workspaceId, harness_slug: harnessSlug };

      const idA = makeIdentityOverride('alice', 4242, 'test-keychain-alice');
      const idB = makeIdentityOverride('bob', 7, 'test-keychain-bob');

      const swarmA = makeSwarm(testnet.bootstrap);
      const swarmB = makeSwarm(testnet.bootstrap);

      const applyA = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);
      const applyB = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);

      const rootA = makeWorkspaceRoot('shr-A-');
      const rootB = makeWorkspaceRoot('shr-B-');

      // FAST self-heal cadence so the test reconnects in ~1s, not the 2.5s
      // production default; keep the fast window open the whole test.
      const SELF_HEAL = { swarmRefreshMs: 300, swarmFastWindowMs: 60_000, swarmSlowRefreshMs: 5_000 };

      const handleA = await bootHarnessSubstrate({
        workspaceRoot: rootA,
        workspaceId,
        harnessSlug,
        swarmBinding: binding,
        swarmOverride: swarmA,
        verifyBindingOverride: async () => 'verified',
        applyOverride: applyA,
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idA.override,
        ...SELF_HEAL,
      });
      cleanups.push(async () => {
        await handleA?.close();
        await closeHarnessStore({ workspaceRoot: rootA, harnessSlug });
      });

      const handleB = await bootHarnessSubstrate({
        workspaceRoot: rootB,
        workspaceId,
        harnessSlug,
        swarmBinding: binding,
        swarmOverride: swarmB,
        verifyBindingOverride: async () => 'verified',
        applyOverride: applyB,
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idB.override,
        ...SELF_HEAL,
      });
      cleanups.push(async () => {
        await handleB?.close();
        await closeHarnessStore({ workspaceRoot: rootB, harnessSlug });
      });

      expect(handleA.swarm).not.toBeNull();
      expect(handleB.swarm).not.toBeNull();

      // ── Phase 1: federation establishes (op #1 crosses A → B). ──
      await handleA.append({
        type: 'put',
        table: 'features_consolidated',
        hbKey: 'F-before-drop',
        value: { status: 'todo' },
        ts: 1000,
        schema_version: 1,
        writerPubkey: idA.devicePubkey,
      });
      const first = await pollUntil(
        async () => {
          await handleB.mergeNow();
          return applyB.mock.calls.find((c) => c[0].hbKey === 'F-before-drop')?.[0];
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(first, 'federation never established before the drop').toBeTruthy();

      const connectsBeforeKill = listBootHistory({
        workspaceId,
        harnessSlug,
        kinds: ['peer_connected'],
        limit: 100,
      }).length;

      // ── Phase 2: KILL the live connection (no manual refresh anywhere). ──
      const killed = killConnections(swarmA) + killConnections(swarmB);
      expect(killed, 'expected at least one live connection to kill').toBeGreaterThan(0);

      // ── Phase 3: a write made AFTER the kill must still cross — proving the
      //    PRODUCTION self-heal loop rediscovered + reconnected on its own. ──
      await handleA.append({
        type: 'put',
        table: 'features_consolidated',
        hbKey: 'F-after-drop',
        value: { status: 'done' },
        ts: 2000,
        schema_version: 1,
        writerPubkey: idA.devicePubkey,
      });
      const second = await pollUntil(
        async () => {
          await handleB.mergeNow();
          return applyB.mock.calls.find((c) => c[0].hbKey === 'F-after-drop')?.[0];
        },
        { timeoutMs: 40_000, intervalMs: 300 },
      );

      expect(
        second,
        'federation did NOT self-heal: the post-drop write never reached B without a manual refresh/restart',
      ).toBeTruthy();
      expect(second).toMatchObject({ hbKey: 'F-after-drop', value: { status: 'done' }, ts: 2000 });

      // The reconnect actually re-fired the connection handler (a NEW
      // peer_connected after the kill), not just a still-warm socket.
      const connectsAfterHeal = listBootHistory({
        workspaceId,
        harnessSlug,
        kinds: ['peer_connected'],
        limit: 100,
      }).length;
      expect(connectsAfterHeal).toBeGreaterThan(connectsBeforeKill);
    },
    90_000,
  );
});
