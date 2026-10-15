/**
 * federation-revocation-kcut-sidecar.repro.test.ts
 *
 * Plan: shared-hive-member-content-federation-2026-06-20.
 *
 * ## What this proves — the REVOCATION read-cut (K-CUT) in SUBSTRATE_SIDECAR mode
 * The in-process K-CUT witness (`hive-epoch-read-cut-witness.test.ts`, D-014 on the
 * shared-hive-rekey plan) proved the C-001 read cut over the REAL crypto + op-gate, but
 * HAND-COMPOSED every step (no swarm, no PG, no boot). The receive-side sidecar
 * federation only landed with D-053 (a topic-bound joiner bootstrap-admits the owner's
 * log + applies the owner's content origin=remote — see
 * `sidecar-joiner-owner-bootstrap-admit.repro.test.ts`). This repro RE-PROVES the K-CUT
 * end-to-end through that SAME real sidecar transport, so the revocation cut is a
 * permanent SIDECAR-mode regression guard, not just an in-process unit witness.
 *
 * THE WITNESSED SEQUENCE (real wire, real testcontainer PG, real XChaCha20-Poly1305 +
 * sealed-box crypto):
 *   1. EPOCH 0 (BASELINE) — owner + member B federate. Epoch 0 is the PRE-re-key baseline:
 *      per WI-2102 (`buildEpochEncryptCapability` returns null at `BASELINE_EPOCH`), baseline
 *      content federates PLAINTEXT (no epoch stamp) — a never-rekeyed hive does NOT demand an
 *      epoch-0 key on every drain. So the owner still grants epoch-0 keys to {owner, B} (real
 *      `grantEpochKeysToMembers`) and authors epoch-0 content, but that content crosses the
 *      real swarm as PLAINTEXT; B admits the owner (D-053 bootstrap-admit), federates the
 *      wrapped epoch-0 key row, and reads the plaintext plan into its own Postgres
 *      (origin='remote'). The READ CUT proper lands at the first ENCRYPTED epoch (epoch 1,
 *      post-ban) below — epoch 0 is the readable pre-boundary content.
 *      (Pre-WI-2102 this baseline epoch was itself encrypted; the plaintext-baseline bypass
 *      is the deliberate live production path — see `hive-epoch-op-gate.ts`.)
 *   2. BAN — the owner advances the epoch 0→1 EXCLUDING B (real `advanceEpochOnHiveBoundary`
 *      with `cutOffPubkeys:[B]`, the boundary the `pot:ban_member` / revoke path drives):
 *      the epoch-1 key is wrapped to the REMAINING device (owner) ONLY — never to B.
 *   3. EPOCH 1 — the owner authors POST-boundary content encrypted under epoch 1. B still
 *      REPLICATES the ciphertext (it stays swarm-connected) AND federates the owner-only
 *      epoch-1 key row, yet B holds NO epoch-1 key for ITS device, so the decrypt gate
 *      DEFERS the op FOREVER — B never decrypts it. Meanwhile the PRE-boundary epoch-0
 *      content stays readable (forward cut, not retroactive). That is the C-001 K-CUT.
 *
 * ## What is REAL vs composed (and WHY)
 * REAL: two `createSubstrateSidecarHost` + `bootHarnessSubstrate` peers over a loopback
 * testnet DHT (announce / admission / D-053 owner-bootstrap-admit / replication /
 * read-merge); two migrated testcontainer Postgres org DBs; the real CDC capture triggers
 * + outbox drain; the real epoch crypto (`resolveHiveEpochCrypto(true)`); the real encrypt
 * capability, decrypt gate + pending-content defer/drain, member EpochKeyProvider + PG
 * wrapped-key loader; the real grant-on-join + boundary-advance helpers; the real
 * harness-plans + hive-epoch-keys PG projections.
 *
 * COMPOSED (not boot-auto-wired): the per-peer epoch identity. `buildHiveRekeyBootDeps`
 * (boot's auto-wiring) resolves ONE process-global device identity + owner-ness via
 * `resolveLocalGithubIdentity` / `loadHivePubkey`, so it CANNOT give two distinct peers in
 * ONE process their own device + owner/member role. The faithful in-process choice — the
 * same one `hive-late-join-epoch-decrypt-federation.integration.test.ts` makes — is to
 * compose the gate / capability per peer with explicit devices, while letting the SWARM +
 * the FEDERATION (content ops AND the wrapped-key rows) cross the real wire. Every
 * component is the production component; only the wiring is explicit. The keychain (OS
 * secret store) is the SAME in-memory stand-in the witness uses, so the real crypto runs
 * without OS I/O. The papercusp-hive-rekey flag is left OFF (boot's rekeyDeps stay null);
 * we drive the crypto at the call site exactly as the witness drives `resolveHiveEpochCrypto(true)`.
 *
 * RUN (real testcontainer PG):
 *   cd packages/operator-core && VITEST_UNIT_TIMEOUT_MS=180000 \
 *     npx vitest run lib/sync/hyperbee/__tests__/federation-revocation-kcut-sidecar.repro.test.ts
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';

// ── In-memory keychain stand-in (vi.mock factories are hoisted) — the SAME stand-in the
//    read-cut witness + late-join integration test use, so the REAL crypto runs without OS
//    secret I/O. Namespaced by serviceName so the per-device keypairs
//    (papercusp-device-keypair) and the per-(hive,epoch) content keys
//    (papercusp-hive-epoch-key) coexist. The boot path itself imports no keychain export
//    beyond these three (boot.ts/announce use the announce-identity override; only
//    hive-epoch-crypto-impl uses keychainLoad/Store), so the mock is complete + safe. ──
const { mem } = vi.hoisted(() => ({ mem: new Map<string, Buffer>() }));
const DEVICE_SVC = 'papercusp-device-keypair';
// WI-4075: spread the REAL module first, then override ONLY the three functions
// this test needs faked. A hand-listed factory silently strands every export it
// omits — `identity/keychain` exports 8, this test faked 3, and when production
// added `isRequestOnlyIdentityProcess` the swarm-join path began throwing
// [vitest] No "isRequestOnlyIdentityProcess" export is defined on the ... mock,
// so `handle.swarm` came back null and the epoch K-CUT assertion at ~line 570
// failed BEFORE any crypto ran — a stranded-mock failure wearing a crypto
// failure's clothes. importOriginal keeps this mock correct as the module grows.
vi.mock('../../../identity/keychain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../identity/keychain')>()),
  keychainStore: async (id: string, der: Buffer, serviceName: string = DEVICE_SVC) => {
    mem.set(serviceName + ':' + id, Buffer.from(der));
  },
  keychainLoad: async (id: string, serviceName: string = DEVICE_SVC) => {
    const v = mem.get(serviceName + ':' + id);
    return v ? { kind: 'ok', value: v } : { kind: 'error', error: { kind: 'not_found' } };
  },
  keychainDelete: async (id: string, serviceName: string = DEVICE_SVC) => {
    mem.delete(serviceName + ':' + id);
  },
}));

import {
  bootHarnessSubstrate,
  type BootedHarnessHandle,
  type BootHarnessOpts,
} from '../boot';
import { deriveSwarmTopic, type SwarmBinding } from '../derive-swarm-topic';
import {
  createSubstrateSidecarHost,
  type SubstrateSidecarHost,
} from '../substrate-sidecar-host';
import { type HyperswarmLike } from '../swarm';
import type { OpEnvelope } from '../op-envelope-types';
import { _resetBootHistoryForTests } from '../boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';
import { drainOutboxOnce, type EpochEncryptCapability } from '../outbox-drain';
import { applyOpVia, type ProjectionLookup, type TableProjection } from '../projection';
import { buildHarnessPlansProjection } from '../projections/harness-plans';
import { buildHiveEpochKeysProjection } from '../projections/hive-epoch-keys';
import { resolveHiveEpochCrypto } from '../hive-epoch-serving';
import type { HiveEpochCrypto } from '../hive-epoch-crypto';
import {
  buildEpochEncryptCapability,
  buildEpochDecryptGate,
  buildEpochKeyResolver,
  drainQueuedEpochContent,
  type DrainedEpoch,
} from '../hive-epoch-op-gate';
import { createEpochKeyProvider } from '../hive-epoch-key-provider';
import { createPgWrappedKeyLoader } from '../hive-epoch-keys-store';
import { PendingEpochContent } from '../pending-epoch-content';
import { getHiveEpoch } from '../hive-epoch-state';
import {
  advanceEpochOnHiveBoundary,
  grantEpochKeysToMembers,
} from '../hive-epoch-boundary-wiring';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../../identity/ed25519';
import {
  _resetForTests as resetDbOrgPools,
  _resetStoreIdentityForTests,
} from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache the pool resolver memoizes
import { _resetUrlCacheForTests } from '../../../../../../libs/papercusp/libs/db/src/connection';
import { _resetHarnessAdminUrlCacheForTests } from '../../../embedded-pg-discovery';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { mutateHarnessRegistry } from '../../../harness-registry';
import { _clearHiveMemberDeviceSetCacheForTest } from '../hive-member-identity-set';

const WORKSPACE_ID = 'ws-kcut-sidecar';
const HIVE_HOME = 'kcut-owner-hive';
const JOINER_SLUG = 'kcut-joined-hive';
const OWNER_SIBLING_SLUG = 'kcut-owner-member';
const B_SIBLING_SLUG = 'kcut-joined-member';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      // best-effort — a thrown assertion must not leak a swarm/dir/db/DHT node
    }
  }
  // This file deliberately rotates the process-level org DB from the ambient store to a
  // throwaway testcontainer and back. The production identity latch must survive endpoint
  // changes, so test isolation has to release that pin explicitly once every routed pool has
  // been closed; otherwise the next ambient pool is correctly (but spuriously for the test)
  // diagnosed as a foreign cluster and vitest-fail-on-console turns a green witness red.
  _resetStoreIdentityForTests();
  _resetCacheForTests();
  _resetBootHistoryForTests();
  mem.clear();
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

/** A unified per-peer identity: ONE Ed25519 keypair used for BOTH the announce
 *  (sign/loadKeypair override) AND the epoch crypto (device key in the keychain for
 *  unwrapEpochKey + the device pubkey wrapped-to). This is what lets the announce-admitted
 *  device and the epoch-key device be the SAME identity per peer. */
async function makeUnifiedIdentity(login: string, userId: number, keychainId: string) {
  const { keychainStore } = await import('../../../identity/keychain'); // the mock
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  await keychainStore(keychainId, privateKeyDer); // DEVICE service (default)
  return {
    devicePubkey: pubkeyBase64,
    keychainId,
    userId,
    override: {
      resolveOpts: {
        keychainId,
        resolveGithubUser: async () => ({ id: userId, login }),
        loadKeypair: async (id: string) => ({ keychainId: id, pubkeyBase64 }),
        resolveAttestationGistId: async () => `gist-${login}`,
      },
      sign: async (_keychainId: string, bytes: Buffer) => signWithPrivateKeyDer(privateKeyDer, bytes),
    },
  };
}

interface PeerControl {
  handle: BootedHarnessHandle;
  storeId: string;
  mergeNow(): Promise<number>;
}

/** Boot one peer THROUGH a dedicated substrate sidecar HOST (its own "process") — the
 *  faithful sidecar boot the bootstrap-admit repro exercises. */
async function bootViaSidecarHost(args: {
  root: string;
  swarm: HyperswarmLike;
  harnessSlug: string;
  binding: SwarmBinding;
  bootExtra: Partial<BootHarnessOpts>;
}): Promise<PeerControl> {
  let captured: BootedHarnessHandle | undefined;
  const host: SubstrateSidecarHost = createSubstrateSidecarHost({
    bootHarnessImpl: async (bootOpts: BootHarnessOpts) => {
      const handle = await bootHarnessSubstrate({
        ...bootOpts,
        swarmOverride: args.swarm,
        mergePollMs: 0,
        pendingRetryMs: 0,
        swarmJoinRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        ...args.bootExtra,
      });
      captured = handle;
      return handle;
    },
    wireOutbox: async () => {},
    wirePresence: async () => {},
  });
  cleanups.push(async () => {
    await host.closeAll();
    await closeHarnessStore({ workspaceRoot: args.root, harnessSlug: args.harnessSlug });
  });

  const booted = (await host.methods['substrate:bootHarness']({
    workspaceId: WORKSPACE_ID,
    harnessSlug: args.harnessSlug,
    workspaceRoot: args.root,
    swarmBinding: args.binding,
  })) as { storeId: string };
  if (!captured) throw new Error('bootHarnessImpl did not run (host boot failed)');

  return {
    handle: captured,
    storeId: booted.storeId,
    mergeNow: async () => {
      const r = (await host.methods['substrate:triggerMergeNow']({
        storeId: booted.storeId,
      })) as { mergedOps: number };
      return r.mergedOps;
    },
  };
}

describe('SIDECAR revocation K-CUT — a banned member CANNOT decrypt post-boundary content while pre-boundary stays readable (re-proves D-014 over the real sidecar wire)', () => {
  it(
    'epoch0 owner→B content decrypts; owner BANS B (epoch 0→1, key wrapped to remaining only); epoch1 content NEVER decrypts on B, epoch0 stays readable',
    async () => {
      // ── env-route getOrgPg at a migrated org DB = the shared metadata DB + B's PG view
      //    (the same routing the bootstrap-admit repro uses). ──
      const orgDb: OrgTestDb = await createOrgTestDb();
      cleanups.push(async () => orgDb.cleanup());
      // The OWNER's content-origin DB — a SEPARATE migrated org DB (so what B can / cannot
      // read is genuinely B's own projection write, the meaningfulness precondition). The
      // owner authors here via explicit `sql` (never getOrgPg), exactly as the bootstrap-admit
      // owner authors into its own dbOwner.
      const dbOwner: OrgTestDb = await createOrgTestDb();
      cleanups.push(async () => dbOwner.cleanup());

      const [{ d: nameOrg }] = await orgDb.adminSql<Array<{ d: string }>>`SELECT current_database() AS d`;
      const [{ d: nameOwner }] = await dbOwner.adminSql<Array<{ d: string }>>`SELECT current_database() AS d`;
      expect(nameOrg, 'owner + B must be genuinely different databases').not.toBe(nameOwner);

      const prev = {
        adminUrl: process.env.HARNESS_ADMIN_DATABASE_URL,
        appUrl: process.env.HARNESS_DATABASE_URL,
        ws: process.env.PAPERCUSP_WORKSPACE_ID,
        skip: process.env.PAPERCUSP_SKIP_PG_DISCOVERY,
        pgb: process.env.PAPERCUSP_PGBOUNCER,
        rekeyFlag: process.env.PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY,
      };
      process.env.HARNESS_ADMIN_DATABASE_URL = orgDb.adminDsn;
      process.env.HARNESS_DATABASE_URL = orgDb.appDsn;
      process.env.PAPERCUSP_WORKSPACE_ID = WORKSPACE_ID;
      process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
      process.env.PAPERCUSP_PGBOUNCER = '0';
      // Force papercusp-hive-rekey OFF so boot's `buildHiveRekeyBootDeps` does NOT auto-wire
      // its own epoch gate. That auto-wiring resolves ONE process-global device identity
      // (resolveLocalGithubIdentity + loadOrGenerateDeviceKeypair) for BOTH in-process peers,
      // so its member gate would look up the WRONG device's wrapped key and defer forever —
      // it cannot serve two distinct peers in one process. With the flag off, boot's rekeyDeps
      // stay null and the per-peer gate/capability this test composes (with explicit idOwner /
      // idB devices) is the only crypto on the path — the same composition the late-join
      // integration test uses, and built from the identical production components.
      process.env.PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY = '0';
      _resetUrlCacheForTests();
      _resetHarnessAdminUrlCacheForTests();
      await resetDbOrgPools();
      _clearHiveMemberDeviceSetCacheForTest();
      cleanups.push(async () => {
        // Retire the testcontainer-routed pools while their env pins are still authoritative.
        // Restoring the ambient URLs first lets surviving sidecar work build a localhost:5432
        // pool while the throwaway cluster is still the process identity pin, manufacturing a
        // false foreign-store alarm during teardown (EI-20321995598569419).
        _resetUrlCacheForTests();
        _resetHarnessAdminUrlCacheForTests();
        _clearHiveMemberDeviceSetCacheForTest();
        await resetDbOrgPools();
        _resetStoreIdentityForTests();

        if (prev.adminUrl === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL; else process.env.HARNESS_ADMIN_DATABASE_URL = prev.adminUrl;
        if (prev.appUrl === undefined) delete process.env.HARNESS_DATABASE_URL; else process.env.HARNESS_DATABASE_URL = prev.appUrl;
        if (prev.ws === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID; else process.env.PAPERCUSP_WORKSPACE_ID = prev.ws;
        if (prev.skip === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY; else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = prev.skip;
        if (prev.pgb === undefined) delete process.env.PAPERCUSP_PGBOUNCER; else process.env.PAPERCUSP_PGBOUNCER = prev.pgb;
        if (prev.rekeyFlag === undefined) delete process.env.PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY; else process.env.PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY = prev.rekeyFlag;
        // Drop URL-only caches after the env restore so any later caller resolves the ambient
        // target afresh. The routed pools themselves were already closed above.
        _resetUrlCacheForTests();
        _resetHarnessAdminUrlCacheForTests();
        _clearHiveMemberDeviceSetCacheForTest();
      });

      const idOwner = await makeUnifiedIdentity('kcut-owner', 99, 'kc-kcut-owner');
      const idB = await makeUnifiedIdentity('kcut-member-b', 7, 'kc-kcut-member-b');

      // The hive identity pubkey IS the swarm-topic seed. Seeded into the env-routed orgDb
      // so the boot reads (home resolution) + D-053 owner-bootstrap-admit resolve. The hive
      // PRIVATE key is never needed here — epoch keys derive off the HIVE_HOME slug id, and
      // the announce signs with each peer's own device key (announceIdentityOverride).
      const { pubkeyBase64: hivePubkeyB64 } = generateEd25519KeypairDer();

      await orgDb.adminSql`
        INSERT INTO harness_shared.pots
          (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, decode(${hivePubkeyB64}, 'base64'),
                'kc-kcut-home', 'KCut Owner Home', null, 1, 1)
      `;
      // The owner's content-origin DB also needs the hives row: advanceHiveEpoch →
      // setHiveSetting refuses to write a setting for a Hive that doesn't exist in the DB it
      // writes to (the epoch lives in pot_settings, scoped to a real hive).
      await dbOwner.adminSql`
        INSERT INTO harness_shared.pots
          (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, decode(${hivePubkeyB64}, 'base64'),
                'kc-kcut-home', 'KCut Owner Home', null, 1, 1)
      `;
      // The live WI-40905 topology had already admitted B before the owner
      // revoked it. Seed that same owner-side membership authority explicitly;
      // without it this repro's owner stays on `membership_miss`, never opens
      // B's remote log, and handle.revoke(B) cannot exercise session retirement.
      await orgDb.adminSql`
        INSERT INTO harness_shared.pot_members
          (workspace_id, pot_home_slug, github_user_id, github_username,
           device_attestations, revoked_pubkeys, binding_status)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${idB.userId}, 'kcut-member-b',
                ${JSON.stringify([{ device_pubkey: idB.devicePubkey }])}::text::jsonb,
                '{}'::text[], 'verified')
      `;
      // pot_directory_cache: the VERIFIED owner binding (hivePubkey → ownerDevicePubkey) —
      // the SOLE source D-053's loadHiveOwnerDevicePubkey reads for the bootstrap admit.
      await orgDb.adminSql`
        INSERT INTO harness_shared.pot_directory_cache (workspace_id, payload, updated_at)
        VALUES (${WORKSPACE_ID}, ${JSON.stringify({
          hives: [{ hivePubkey: hivePubkeyB64, ownerDevicePubkey: idOwner.devicePubkey }],
        })}::text::jsonb, 1)
      `;
      // Registry: HIVE_HOME is a remote_hive VIEW; JOINER_SLUG is its member harness (the
      // member B boots this — exactly the D-053 topic-bound invite/link join shape).
      await mutateHarnessRegistry(
        (r) => ({
          ...r,
          projects: [
            ...r.projects,
            { slug: HIVE_HOME, path: '/tmp/kcut-owner-hive', harness_kind: 'hive', remote_hive: true },
            { slug: JOINER_SLUG, path: '/tmp/kcut-joiner', hive_slug: HIVE_HOME },
            { slug: OWNER_SIBLING_SLUG, path: '/tmp/kcut-owner-member', hive_slug: HIVE_HOME },
            { slug: B_SIBLING_SLUG, path: '/tmp/kcut-joined-member', hive_slug: HIVE_HOME },
          ],
        }),
        WORKSPACE_ID,
      );

      // The REAL v1 epoch crypto (XChaCha20-Poly1305 + Ed25519→X25519 sealed box) — the
      // exact path the prod papercusp-hive-rekey flip enables.
      const crypto: HiveEpochCrypto = await resolveHiveEpochCrypto(true);

      // ── OWNER encrypt side: derives the epoch key (holds the hive key, never unwraps). ──
      const ownerResolveKey = buildEpochKeyResolver({
        crypto,
        provider: { keyForEpoch: async () => { throw new Error('owner never unwraps'); } },
        isOwner: async () => true,
      });
      const ownerEpochEncrypt: EpochEncryptCapability = buildEpochEncryptCapability({
        crypto,
        resolveKey: ownerResolveKey,
        potId: HIVE_HOME,
        getCurrentEpoch: () => getHiveEpoch(WORKSPACE_ID, HIVE_HOME, dbOwner.adminSql),
        // WI-4075: without this, the epoch-0 drain a few lines below populates the
        // capability's 5s TTL cache; the epoch-1 drain right after the ban (well inside
        // that window) would then re-use the STALE cached epoch 0 == BASELINE_EPOCH and
        // federate the post-boundary plan in the CLEAR instead of stamping epoch 1 — this
        // is the real production boundary-trigger path (boot-deps wires the same field),
        // reproduced here.
        workspaceId: WORKSPACE_ID,
      });

      // ── MEMBER B apply side: the REAL decrypt gate over the REAL member EpochKeyProvider
      //    (PG wrapped-key loader on B's DB + B's device key) wrapping the REAL harness-plans
      //    + hive-epoch-keys projections; the keys projection's onEpochKeyApplied feeds the
      //    drain queue that re-runs deferred content. Built once, lazily (needs ownLog.keyHex). ──
      const bPending = new PendingEpochContent();
      const bDrainQueue: DrainedEpoch[] = [];
      let bHandle: BootedHarnessHandle | undefined;
      let bHomeApply: ((op: OpEnvelope) => Promise<boolean>) | undefined;
      let bMemberApply: ((op: OpEnvelope) => Promise<boolean>) | undefined;
      function buildBHomeApply(ownLogKeyHex: string): (op: OpEnvelope) => Promise<boolean> {
        const keysProj = buildHiveEpochKeysProjection({
          workspaceId: WORKSPACE_ID,
          harnessSlug: HIVE_HOME,
          sql: orgDb.adminSql,
          onEpochKeyApplied: (h, e) => bDrainQueue.push({ potHomeSlug: h, epoch: e }),
        });
        const lookup: ProjectionLookup = (tag) =>
          tag === keysProj.tableTag ? (keysProj as TableProjection<unknown>) : null;
        return (op) =>
          op.table === keysProj.tableTag ? applyOpVia(lookup, op, { ownLogKeyHex }) : Promise.resolve(true);
      }
      function buildBMemberApply(ownLogKeyHex: string): (op: OpEnvelope) => Promise<boolean> {
        const provider = createEpochKeyProvider(
          crypto,
          createPgWrappedKeyLoader(WORKSPACE_ID, HIVE_HOME, orgDb.adminSql),
          { keychainId: idB.keychainId, pubkeyBase64: idB.devicePubkey },
        );
        const resolveKey = buildEpochKeyResolver({ crypto, provider, isOwner: async () => false });
        const plansProj = buildHarnessPlansProjection({
          workspaceId: WORKSPACE_ID,
          harnessSlug: OWNER_SIBLING_SLUG,
          sql: orgDb.adminSql,
          isFlagOn: async () => false, // authoritative whole-blob upsert path
        });
        const lookup: ProjectionLookup = (tag) =>
          tag === plansProj.tableTag ? (plansProj as TableProjection<unknown>) : null;
        const inner = (op: OpEnvelope) => applyOpVia(lookup, op, { ownLogKeyHex });
        const gate = buildEpochDecryptGate({ crypto, resolveKey, potId: HIVE_HOME, pending: bPending });
        return (op) => (op.table === plansProj.tableTag ? gate(inner)(op) : Promise.resolve(true));
      }
      const drainB = () =>
        drainQueuedEpochContent({ pending: bPending, drainQueue: bDrainQueue, applyImpl: bMemberApply! });

      // ── Two real sidecar hosts on a loopback testnet DHT. ──
      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });
      const swarmOwner = makeSwarm(testnet.bootstrap);
      const swarmB = makeSwarm(testnet.bootstrap);
      const rootOwner = makeWorkspaceRoot('kcut-owner-');
      const rootB = makeWorkspaceRoot('kcut-b-');
      const ownerPublishedRevoked = new Set<string>();
      const bPublishedRevoked = new Set<string>();

      const hiveBinding: SwarmBinding = { kind: 'hive', hive_pubkey: hivePubkeyB64 };
      const bBinding: SwarmBinding = {
        kind: 'topic',
        topic_hex: deriveSwarmTopic(hiveBinding).toString('hex'),
      };

      const owner = await bootViaSidecarHost({
        root: rootOwner,
        swarm: swarmOwner,
        harnessSlug: HIVE_HOME,
        binding: hiveBinding,
        bootExtra: {
          announceIdentityOverride: idOwner.override,
          loadRevokedOverride: async () => new Set(ownerPublishedRevoked),
          verifyBindingOverride: async (_pk, _login, userId) =>
            userId === idB.userId ? 'verified' : 'fail',
          // The owner authors its content directly into dbOwner + drains it; it receives no
          // content from B (B authors nothing), so its apply is an inert accept.
          applyOverride: async () => true,
        },
      });

      const bPeer = await bootViaSidecarHost({
        root: rootB,
        swarm: swarmB,
        harnessSlug: JOINER_SLUG,
        binding: bBinding,
        bootExtra: {
          announceIdentityOverride: idB.override,
          loadRevokedOverride: async () => new Set(bPublishedRevoked),
          applyOverride: (op, ctx) => {
            bHomeApply ??= buildBHomeApply(ctx.ownLogKeyHex);
            bMemberApply ??= buildBMemberApply(ctx.ownLogKeyHex);
            return op.table === 'plans-by-slug' ? bMemberApply(op) : bHomeApply(op);
          },
        },
      });
      bHandle = bPeer.handle;
      bHomeApply ??= buildBHomeApply(bHandle.ownLog.keyHex);
      bMemberApply ??= buildBMemberApply(bHandle.ownLog.keyHex);

      // WI-40905's real topology has TWO harness handles per machine on the
      // same Hive topic (home + member). Keep the siblings' projection paths
      // inert; their purpose is to reproduce the shared-socket/session shape in
      // which every handle independently processes the same published revoke.
      const ownerSibling = await bootViaSidecarHost({
        root: rootOwner,
        swarm: swarmOwner,
        harnessSlug: OWNER_SIBLING_SLUG,
        binding: hiveBinding,
        bootExtra: {
          announceIdentityOverride: idOwner.override,
          loadRevokedOverride: async () => new Set(ownerPublishedRevoked),
          verifyBindingOverride: async (_pk, _login, userId) =>
            userId === idB.userId ? 'verified' : 'fail',
          applyOverride: async () => true,
        },
      });
      const bSibling = await bootViaSidecarHost({
        root: rootB,
        swarm: swarmB,
        harnessSlug: B_SIBLING_SLUG,
        binding: bBinding,
        bootExtra: {
          announceIdentityOverride: idB.override,
          loadRevokedOverride: async () => new Set(bPublishedRevoked),
          applyOverride: async () => true,
        },
      });

      expect(owner.handle.swarm, 'owner did not join a swarm').not.toBeNull();
      expect(bPeer.handle.swarm, 'member B did not join a swarm').not.toBeNull();
      expect(owner.handle.swarm!.topicHex).toBe(bPeer.handle.swarm!.topicHex);
      expect(ownerSibling.handle.swarm!.topicHex).toBe(owner.handle.swarm!.topicHex);
      expect(bSibling.handle.swarm!.topicHex).toBe(bPeer.handle.swarm!.topicHex);

      // ── EPOCH 0: grant epoch-0 keys to {owner, B} + author epoch-0 content, then drain
      //    (the content is ENCRYPTED on the way out under the real epochEncrypt capability). ──
      const grant0 = await grantEpochKeysToMembers(
        {
          workspaceId: WORKSPACE_ID,
          potHomeSlug: HIVE_HOME,
          enabled: true,
          newMemberPubkeys: [idOwner.devicePubkey, idB.devicePubkey],
          sql: dbOwner.adminSql,
        },
        { resolveCrypto: async () => crypto, resolveAuthorPubkey: async () => idOwner.devicePubkey },
      );
      expect(grant0.applied, 'epoch-0 grant ran').toBe(true);
      expect(grant0.distributed, 'epoch-0 key wrapped to BOTH owner + B').toBe(2);

      const EPOCH0_BODY = 'SECRET epoch-0 body — B keeps reading this after the ban';
      await dbOwner.adminSql`
        INSERT INTO harness_shared.harness_plans
          (workspace_id, harness_slug, plan_slug, title, content, status)
        VALUES (${WORKSPACE_ID}, ${OWNER_SIBLING_SLUG}, 'plan-epoch0', 'Epoch0 plan', ${EPOCH0_BODY}, 'active')
      `;
      const drainedKeys0 = await drainOutboxOnce(owner.handle, dbOwner.adminSql, {
        epochEncrypt: ownerEpochEncrypt,
      });
      const drained0 = await drainOutboxOnce(ownerSibling.handle, dbOwner.adminSql, { epochEncrypt: ownerEpochEncrypt });
      expect(drainedKeys0, 'owner home drained the epoch-0 key rows').toBeGreaterThanOrEqual(2);
      expect(drained0, 'owner member drained the (baseline-plaintext) plan').toBeGreaterThanOrEqual(1);

      // WI-2102: epoch 0 is the pre-re-key BASELINE — `buildEpochEncryptCapability` returns
      // null at `BASELINE_EPOCH`, so the epoch-0 plan federates PLAINTEXT with NO epoch stamp
      // (a never-rekeyed hive must not demand an epoch-0 key on every drain). So the epoch-0
      // plan op is genuinely plaintext on the wire — B reads it WITHOUT needing to decrypt.
      // The read CUT (the security core of this repro) lands at the first ENCRYPTED epoch —
      // the post-ban epoch 1 below — not here.
      const wireOps0 = await readOwnLogOps(ownerSibling.handle);
      const planWire0 = wireOps0.find((o) => o.table === 'plans-by-slug' && o.hbKey === 'plan-epoch0');
      expect(planWire0, 'epoch-0 plan op federated on the owner log').toBeTruthy();
      expect(planWire0?.epoch, 'epoch-0 (baseline) plan op carries NO epoch stamp — it federates plaintext (WI-2102)')
        .toBeUndefined();
      expect(JSON.stringify(planWire0?.value ?? {}), 'epoch-0 (baseline) plan federates as PLAINTEXT (WI-2102 baseline bypass)')
        .toContain('SECRET epoch-0');

      // B admits the owner (D-053 bootstrap-admit), federates the epoch-0 key row + the
      // (baseline-PLAINTEXT, WI-2102) plan, and reads the plan into its own PG (origin='remote').
      // The epoch-0 key row still federates (the grant wrapped it) — it just isn't needed to
      // read baseline-plaintext content; it is the wrapped-key path B would use for an
      // encrypted epoch it remains a member of.
      const epoch0 = await pollUntil(
        async () => {
          await Promise.all([owner.mergeNow(), ownerSibling.mergeNow(), bPeer.mergeNow(), bSibling.mergeNow()]);
          await drainB();
          const plan = await readPlanOnB(orgDb, 'plan-epoch0');
          const keyB0 = await hasKeyRowOnB(orgDb, 0, idB.devicePubkey);
          return plan && keyB0 ? { plan } : undefined;
        },
        { timeoutMs: 40_000, intervalMs: 300 },
      );
      if (!epoch0) {
        const { listBootHistory } = await import('../boot-history');
        const admittedOwner = bPeer.handle.admitted.has(owner.handle.ownLog.keyHex);
        const anyKeys = await orgDb.adminSql`SELECT epoch, member_device_pubkey FROM harness_shared.pot_epoch_keys WHERE workspace_id = ${WORKSPACE_ID}`;
        const anyPlans = await orgDb.adminSql`SELECT plan_slug, origin FROM harness_shared.harness_plans WHERE workspace_id = ${WORKSPACE_ID}`;
        const ownerOps = await readOwnLogOps(owner.handle);
         
        console.log('[KCUT-DIAG] admittedOwner=', admittedOwner,
          'ownLogLen=', owner.handle.ownLog.length,
          'ownerOpTables=', ownerOps.map((o) => `${o.table}/${o.hbKey}/e${o.epoch ?? '-'}`),
          'B.keys=', anyKeys, 'B.plans=', anyPlans,
          'pending=', bPending.size(), 'drainQueue=', bDrainQueue.length,
          'idB.dev=', idB.devicePubkey.slice(0, 12));
         
        console.log('[KCUT-DIAG] B boot events:',
          listBootHistory({ workspaceId: WORKSPACE_ID, harnessSlug: JOINER_SLUG, limit: 60 })
            .map((e) => `${e.kind}:${e.message ?? ''}`).join(' | '));
      }
      expect(epoch0, 'EPOCH-0: B never federated its epoch-0 key / never decrypted the owner plan').toBeTruthy();
      expect(epoch0!.plan).toMatchObject({ plan_slug: 'plan-epoch0', origin: 'remote' });
      expect(epoch0!.plan.content, 'B read the real epoch-0 (baseline-plaintext) plan body').toContain('SECRET epoch-0');

      // ── BAN: the owner advances the epoch 0→1 EXCLUDING B (the revoke boundary). The
      //    epoch-1 key is wrapped to the REMAINING device (owner) ONLY — never to B. ──
      const boundary = await advanceEpochOnHiveBoundary(
        {
          workspaceId: WORKSPACE_ID,
          potHomeSlug: HIVE_HOME,
          enabled: true,
          cutOffPubkeys: [idB.devicePubkey],
          sql: dbOwner.adminSql,
        },
        {
          resolveCrypto: async () => crypto,
          resolveAuthorPubkey: async () => idOwner.devicePubkey,
          // remaining = all members − cut(B) = {owner}; explicit so the boundary needs no
          // pot_members read (the cut is who gets wrapped, not a roster lookup).
          loadAllMemberPubkeys: async () => [idOwner.devicePubkey, idB.devicePubkey],
        },
      );
      expect(boundary.applied, 'the ban boundary advanced the epoch').toBe(true);
      expect(boundary.newEpoch, 'epoch advanced 0→1').toBe(1);
      expect(boundary.distributed, 'epoch-1 key wrapped to the REMAINING device (owner) ONLY').toBe(1);

      // Structural forever-cut at the source: owner has the epoch-1 key row, B never will.
      const ownerHasKey1 = await dbOwner.adminSql<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM harness_shared.pot_epoch_keys
         WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${HIVE_HOME}
           AND epoch = 1 AND member_device_pubkey = ${idOwner.devicePubkey}`;
      const dbOwnerHasBKey1 = await dbOwner.adminSql<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM harness_shared.pot_epoch_keys
         WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${HIVE_HOME}
           AND epoch = 1 AND member_device_pubkey = ${idB.devicePubkey}`;
      expect(Number(ownerHasKey1[0]?.n ?? 0), 'owner minted its own epoch-1 key row').toBe(1);
      expect(Number(dbOwnerHasBKey1[0]?.n ?? 0), 'the revoked B was NEVER wrapped an epoch-1 key').toBe(0);

      // WI-40905: exercise the LIVE revoke seam too. The original version of this
      // guard advanced the cryptographic boundary but never called handle.revoke(),
      // so it bypassed the production action that retires B's admitted log session.
      // That made the test incapable of catching the exact live red: A correctly
      // stopped reading B, but closing B's replica session also froze A's own-log
      // serving on the shared connection, so B never received the post-boundary
      // ciphertext to defer. The security contract is asymmetric: A must refuse
      // B's future writes while B still receives A's encrypted bytes.
      expect(
        owner.handle.admitted.has(bPeer.handle.ownLog.keyHex),
        'precondition: owner admitted B before the live revoke',
      ).toBe(true);
      expect(
        ownerSibling.handle.admitted.has(bPeer.handle.ownLog.keyHex) ||
          ownerSibling.handle.admitted.has(bSibling.handle.ownLog.keyHex),
        'precondition: the owner sibling admitted at least one B log before revoke',
      ).toBe(true);
      // Production discovers the published revoked_pubkeys union at the top of
      // mergeOnePass; it does not call these handles' explicit revoke() method.
      // Drive that exact refresh path on every same-topic handle on both peers.
      ownerPublishedRevoked.add(idB.devicePubkey);
      bPublishedRevoked.add(idB.devicePubkey);
      await Promise.all([
        owner.mergeNow(),
        ownerSibling.mergeNow(),
        bPeer.mergeNow(),
        bSibling.mergeNow(),
      ]);
      expect(
        owner.handle.admitted.has(bPeer.handle.ownLog.keyHex),
        'live revoke must remove B from the owner read set',
      ).toBe(false);

      // ── EPOCH 1: the owner authors POST-boundary content (encrypted under epoch 1). ──
      const EPOCH1_BODY = 'SECRET epoch-1 body — the revoked member must NOT be able to read this';
      await dbOwner.adminSql`
        INSERT INTO harness_shared.harness_plans
          (workspace_id, harness_slug, plan_slug, title, content, status)
        VALUES (${WORKSPACE_ID}, ${OWNER_SIBLING_SLUG}, 'plan-epoch1', 'Epoch1 plan', ${EPOCH1_BODY}, 'active')
      `;
      const drainedBoundary = await drainOutboxOnce(owner.handle, dbOwner.adminSql, {
        epochEncrypt: ownerEpochEncrypt,
      });
      const drained1 = await drainOutboxOnce(ownerSibling.handle, dbOwner.adminSql, { epochEncrypt: ownerEpochEncrypt });
      expect(drainedBoundary, 'owner home drained the epoch advance + epoch-1 key').toBeGreaterThanOrEqual(1);
      expect(drained1, 'owner member drained the encrypted post-boundary plan').toBeGreaterThanOrEqual(1);

      const wireOps1 = await readOwnLogOps(ownerSibling.handle);
      const planWire1 = wireOps1.find((o) => o.table === 'plans-by-slug' && o.hbKey === 'plan-epoch1');
      expect(planWire1?.epoch, 'epoch-1 plan op carries the epoch-1 stamp').toBe(1);
      expect(JSON.stringify(planWire1?.value ?? {}), 'epoch-1 plan federates as ciphertext')
        .not.toContain('SECRET epoch-1');

      // Poll until the OWNER's epoch-1 key row has federated to B — proving the epoch-1 ops
      // (which precede the plan in the log) genuinely CROSSED to B, so B has truly REPLICATED
      // + tried + DEFERRED the post-boundary ciphertext (not merely "not arrived yet").
      const epoch1Reached = await pollUntil(
        async () => {
          await Promise.all([owner.mergeNow(), ownerSibling.mergeNow(), bPeer.mergeNow(), bSibling.mergeNow()]);
          await drainB();
          return (await hasKeyRowOnB(orgDb, 1, idOwner.devicePubkey)) ? true : undefined;
        },
        { timeoutMs: 40_000, intervalMs: 300 },
      );
      expect(epoch1Reached, 'epoch-1 federation never reached B (owner epoch-1 key row absent on B)').toBe(true);

      // Extra passes: give the epoch-1 ciphertext every chance to (wrongly) decrypt/apply.
      for (let i = 0; i < 8; i++) {
        await Promise.all([owner.mergeNow(), ownerSibling.mergeNow(), bPeer.mergeNow(), bSibling.mergeNow()]);
        await drainB();
      }

      // ── THE K-CUT ASSERTIONS ──
      // (1) The revoked B CANNOT decrypt/apply the POST-boundary epoch-1 content.
      expect(
        await readPlanOnB(orgDb, 'plan-epoch1'),
        'C-001 BREACH: the revoked member decrypted POST-boundary (epoch-1) content',
      ).toBeUndefined();
      // (2) B never federated an epoch-1 key for ITS device (structural forever-cut), even
      //     though the owner-only epoch-1 key row DID reach B — so the cut is the SELECTIVE
      //     non-wrapping (C-001), not "B simply got no keys".
      expect(
        await hasKeyRowOnB(orgDb, 1, idB.devicePubkey),
        'the revoked B must hold NO epoch-1 key row for its own device',
      ).toBe(false);
      // (3) Not retroactive: the PRE-boundary epoch-0 content stays readable on B.
      const plan0Still = await readPlanOnB(orgDb, 'plan-epoch0');
      expect(plan0Still, 'B lost its PRE-boundary epoch-0 content (a retroactive cut — wrong)').toBeTruthy();
      expect(plan0Still!.content).toContain('SECRET epoch-0');
      // (4) The undecryptable epoch-1 op is buffered FOREVER on B (the C-001 read cut: it holds
      //     the ciphertext bytes but no key row for its device will ever arrive).
      expect(
        bPending.size(),
        'the epoch-1 ciphertext must remain deferred on B (held bytes, no decryptable key)',
      ).toBeGreaterThanOrEqual(1);
    },
    180_000,
  );
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function readPlanOnB(orgDb: OrgTestDb, planSlug: string) {
  const rows = await orgDb.adminSql<
    Array<{ plan_slug: string; content: string; status: string | null; origin: string }>
  >`
    SELECT plan_slug, content, status, origin FROM harness_shared.harness_plans
     WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${OWNER_SIBLING_SLUG} AND plan_slug = ${planSlug}
  `;
  return rows[0];
}

async function hasKeyRowOnB(orgDb: OrgTestDb, epoch: number, memberDevicePubkey: string): Promise<boolean> {
  const rows = await orgDb.adminSql<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM harness_shared.pot_epoch_keys
     WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${HIVE_HOME}
       AND epoch = ${epoch} AND member_device_pubkey = ${memberDevicePubkey}
  `;
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Read every op currently on a peer's own writable log (for ciphertext-on-the-wire
 *  assertions). The own log is an AdmittedLog: keyHex + length + get(i). */
async function readOwnLogOps(handle: BootedHarnessHandle): Promise<OpEnvelope[]> {
  const log = handle.ownLog;
  const out: OpEnvelope[] = [];
  for (let i = 0; i < log.length; i++) {
    const op = await log.get(i);
    if (op) out.push(op as unknown as OpEnvelope);
  }
  return out;
}
