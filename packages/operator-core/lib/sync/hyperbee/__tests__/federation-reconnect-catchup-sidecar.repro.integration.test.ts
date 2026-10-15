/**
 * federation-reconnect-catchup-sidecar.repro.test.ts
 *
 * Plan: shared-hive-member-content-federation-2026-06-20 (D-052, D-053).
 *
 * ## What this repro proves — DURABLE OFFLINE-CATCHUP across a RECONNECT (sidecar mode)
 * Receive-side federation now works in SUBSTRATE_SIDECAR mode (D-053): a fresh
 * TOPIC-bound joiner bootstrap-admits the owner, federates the roster, and applies
 * owner-authored content (origin='remote'). The full-chain bootstrap-admit repro
 * proves that for content authored WHILE BOTH PEERS ARE CONNECTED. This repro adds
 * the missing temporal dimension: content authored WHILE THE MEMBER IS OFFLINE must
 * still reach it on RECONNECT — no permanent gap.
 *
 * Hypercore is append-only, so a reconnecting peer replicates the DELTA from its
 * last replicated length. This test exercises that end-to-end through the REAL
 * substrate sidecar HOST + real boot/swarm/announce/admission/merge path:
 *
 *   1. OWNER + MEMBER federate — the owner authors its roster + an INITIAL feature;
 *      the member bootstrap-admits, federates the roster, and applies it (origin=remote).
 *   2. MEMBER GOES OFFLINE — `member.handle.swarm.close()` (swarm.ts close(): leave
 *      topic + stop the self-heal refresh loop + detach the connection handler) AND
 *      the member's Hyperswarm is DESTROYED, killing the live socket. `swarm.close()`
 *      ALONE is NOT enough: it leaves the topic but the EXISTING `store.replicate`
 *      stream stays live, so an op authored after a bare close would still cross. The
 *      destroy is what makes the member genuinely offline.
 *   3. OWNER authors NEW content while the member is offline (drains to its log; the
 *      member cannot receive it — proven: a merge during the offline window applies
 *      NOTHING new and the member's replica of the owner log does NOT grow).
 *   4. MEMBER COMES BACK — a FRESH Hyperswarm is swapped in and `member.handle.rekey()`
 *      (boot.ts rekey() → joinForBinding, which re-reads `opts.swarmOverride` LIVE)
 *      re-pairs onto the SAME topic WITHOUT tearing down the store / own-log /
 *      admitted-set / merge-cursor. The member then CATCHES UP the missed op
 *      (origin='remote') — durable catch-up, no permanent gap.
 *
 * The swappable-swarm seam (mutating the SAME `BootHarnessOpts` object boot.ts closes
 * over, so `joinForBinding` reads the new transport on the rekey) is how we model a
 * peer that loses its network and re-pairs on a new connection while keeping its
 * store alive — the faithful in-process analogue of a sidecar that lost connectivity.
 *
 * RUN (real testcontainer PG):
 *   cd packages/operator-core && VITEST_UNIT_TIMEOUT_MS=180000 \
 *     npx vitest run lib/sync/hyperbee/__tests__/federation-reconnect-catchup-sidecar.repro.test.ts
 */

import { afterEach, describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
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
import { drainOutboxOnce } from '../outbox-drain';
import { applyOpVia, type ProjectionLookup, type TableProjection } from '../projection';
import { buildHarnessFeaturesProjection } from '../projections/harness-features';
import { buildIssuesProjection } from '../projections/issues';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  SUBSTRATE_OUTBOX_DDL,
  FILL_WORKSPACE_ID_DDL,
  HARNESS_ISSUES_CONSOLIDATED_FED_DDL,
} from '../../../../test/_work-items-schema';
import { _resetForTests as resetDbOrgPools } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache the pool resolver memoizes
import { _resetUrlCacheForTests } from '../../../../../../libs/papercusp/libs/db/src/connection';
import { _resetHarnessAdminUrlCacheForTests } from '../../../embedded-pg-discovery';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { mutateHarnessRegistry } from '../../../harness-registry';
import { _clearHiveMemberDeviceSetCacheForTest } from '../hive-member-identity-set';
import { applyPot557RenameAndFixups } from './_hive-substrate-rig';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

const WORKSPACE_ID = 'ws-sidecar-reconnect';

const FRAMEWORK_ROLES_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
      CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
      CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd';
    END IF;
  END $pg$;
`;

/** Strip psql meta + bare BEGIN/COMMIT so a migration file applies via sql.unsafe(). */
function stripMig(s: string): string {
  return s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('\\') && !/^(begin|commit);$/i.test(t);
    })
    .join('\n');
}

/**
 * The OWNER author's content-origin schema: harness_features_consolidated + the
 * CDC capture (375) PLUS the Hive schema (184 hives + 185 pot_members + 189
 * federation-cols) so the owner can author its ROSTER + features and have them
 * drain to its log (the member federates from there).
 */
async function setupOwnerSchema(sql: postgres.Sql, hiveHome: string, hivePubkeyB64: string): Promise<void> {
  await sql.unsafe(FRAMEWORK_ROLES_DDL);
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await sql.unsafe(`
    CREATE TABLE harness_shared.projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, slug TEXT,
      workspace_id TEXT, created_ts BIGINT NOT NULL, updated_ts BIGINT NOT NULL
    );
  `);
  await sql`
    INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id, created_ts, updated_ts)
    VALUES ('p-fed', 'Fed', 'active', ${hiveHome}, ${WORKSPACE_ID}, 0, 0)
  `;
  await sql.unsafe(SUBSTRATE_OUTBOX_DDL);
  await sql.unsafe(FILL_WORKSPACE_ID_DDL);
  await sql.unsafe(HARNESS_ISSUES_CONSOLIDATED_FED_DDL);
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '375-work-items-cdc-capture.sql'), 'utf8')));
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '184-hives-table.sql'), 'utf8')));
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '185-hive-members-admission.sql'), 'utf8')));
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '189-hive-members-federation-cols.sql'), 'utf8')));
  await applyPot557RenameAndFixups(sql);
  await sql`
    INSERT INTO harness_shared.pots
      (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
    VALUES (${WORKSPACE_ID}, ${hiveHome}, decode(${hivePubkeyB64}, 'base64'),
            'kc-owner-home', 'Owner Home', null, 1, 1)
  `;
}

/** The OWNER's throwaway per-peer apply (its own content origin DB). */
function buildOwnerApply(sql: postgres.Sql, hiveHome: string, ownLogKeyHex: string): (op: OpEnvelope) => Promise<boolean> {
  const opts = { workspaceId: WORKSPACE_ID, harnessSlug: hiveHome, sql };
  const scoped = new Map<string, TableProjection<unknown>>();
  for (const p of [buildHarnessFeaturesProjection(opts), buildIssuesProjection(opts)] as TableProjection<unknown>[]) {
    scoped.set(p.tableTag, p);
  }
  const lookup: ProjectionLookup = (tag) => scoped.get(tag) ?? null;
  return (op: OpEnvelope) => applyOpVia(lookup, op, { ownLogKeyHex });
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      // best-effort — a thrown assertion must not leak a swarm/dir/db
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

/** Build a fresh Hyperswarm on the testnet bootstrap, registered for cleanup. */
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
  handle: BootedHarnessHandle;
  storeId: string;
  mergeNow(): Promise<number>;
  /** Swap the transport boot.ts re-reads on the next join (used by `rekey` to
   *  reconnect on a FRESH swarm after the offline swarm is destroyed). */
  setSwarm(swarm: HyperswarmLike): void;
  /** Re-key onto a binding (here: the SAME topic) IN PLACE — boot.ts rekey(). */
  rekey(binding: SwarmBinding): Promise<void>;
}

/**
 * Boot one peer THROUGH a dedicated substrate sidecar HOST (its own "process").
 *
 * The final boot-opts object is captured in `bootOptsRef` and passed by REFERENCE
 * to `bootHarnessSubstrate`, so mutating `bootOptsRef.swarmOverride` LATER is read
 * by boot.ts `joinForBinding` on the next `rekey()` — the swappable-transport seam
 * the reconnect step relies on (offline swarm destroyed → fresh swarm swapped in).
 */
async function bootViaSidecarHost(args: {
  root: string;
  initialSwarm: HyperswarmLike;
  harnessSlug: string;
  binding: SwarmBinding;
  bootExtra: Partial<BootHarnessOpts>;
}): Promise<PeerControl> {
  let captured: BootedHarnessHandle | undefined;
  let bootOptsRef: (BootHarnessOpts & { storagePath?: string }) | undefined;
  const host: SubstrateSidecarHost = createSubstrateSidecarHost({
    bootHarnessImpl: async (bootOpts: BootHarnessOpts) => {
      bootOptsRef = {
        ...bootOpts,
        swarmOverride: args.initialSwarm,
        mergePollMs: 0,
        pendingRetryMs: 0,
        swarmJoinRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        ...args.bootExtra,
      };
      captured = await bootHarnessSubstrate(bootOptsRef);
      return captured;
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
  if (!captured || !bootOptsRef) throw new Error('bootHarnessImpl did not run (host boot failed)');
  const ref = bootOptsRef;
  const handle = captured;

  return {
    handle,
    storeId: booted.storeId,
    mergeNow: async () => {
      const r = (await host.methods['substrate:triggerMergeNow']({
        storeId: booted.storeId,
      })) as { mergedOps: number };
      return r.mergedOps;
    },
    setSwarm: (swarm: HyperswarmLike) => {
      ref.swarmOverride = swarm;
    },
    rekey: (binding: SwarmBinding) => handle.rekey(binding),
  };
}

/** Read one feature row for a slug from the member's (env-routed) org DB. */
async function readFeature(orgSql: postgres.Sql, slug: string, featureId: string) {
  const rows = await orgSql<
    Array<{ feature_id: string; title: string | null; status: string | null; origin: string }>
  >`
    SELECT feature_id, title, status, origin
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${slug} AND feature_id = ${featureId}
  `;
  return rows[0];
}

describe('SIDECAR offline-catchup / reconnect federation (D-053) — owner authors while member OFFLINE, member CATCHES UP on rejoin', () => {
  it(
    'member federates an initial owner op, goes OFFLINE while the owner authors NEW content, then CATCHES UP the missed op on rekey-reconnect (origin=remote, no permanent gap)',
    async () => {
      const HIVE_HOME = 'owner-hive';
      const MEMBER_SLUG = 'joined-owner-hive';

      // ── env-route getOrgPg at a migrated org DB = the MEMBER's PG view. ──
      const orgDb: OrgTestDb = await createOrgTestDb();
      const prev = {
        adminUrl: process.env.HARNESS_ADMIN_DATABASE_URL,
        appUrl: process.env.HARNESS_DATABASE_URL,
        ws: process.env.PAPERCUSP_WORKSPACE_ID,
        skip: process.env.PAPERCUSP_SKIP_PG_DISCOVERY,
        pgb: process.env.PAPERCUSP_PGBOUNCER,
      };
      process.env.HARNESS_ADMIN_DATABASE_URL = orgDb.adminDsn;
      process.env.HARNESS_DATABASE_URL = orgDb.appDsn;
      process.env.PAPERCUSP_WORKSPACE_ID = WORKSPACE_ID;
      process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
      process.env.PAPERCUSP_PGBOUNCER = '0';
      _resetUrlCacheForTests();
      _resetHarnessAdminUrlCacheForTests();
      await resetDbOrgPools();
      _clearHiveMemberDeviceSetCacheForTest();
      cleanups.push(async () => {
        if (prev.adminUrl === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL; else process.env.HARNESS_ADMIN_DATABASE_URL = prev.adminUrl;
        if (prev.appUrl === undefined) delete process.env.HARNESS_DATABASE_URL; else process.env.HARNESS_DATABASE_URL = prev.appUrl;
        if (prev.ws === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID; else process.env.PAPERCUSP_WORKSPACE_ID = prev.ws;
        if (prev.skip === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY; else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = prev.skip;
        if (prev.pgb === undefined) delete process.env.PAPERCUSP_PGBOUNCER; else process.env.PAPERCUSP_PGBOUNCER = prev.pgb;
        _resetUrlCacheForTests();
        _resetHarnessAdminUrlCacheForTests();
        _clearHiveMemberDeviceSetCacheForTest();
        await resetDbOrgPools();
        await orgDb?.cleanup();
      });

      const idOwner = makeIdentityOverride('owner', 99, 'kc-owner');
      const idMember = makeIdentityOverride('member', 7, 'kc-member');
      const { publicKey: hivePub } = generateKeyPairSync('ed25519');
      const hivePubkeyB64 = rawPubkeyBase64(hivePub);

      // MEMBER's PG: a hives row for HIVE_HOME (home resolution) + the VERIFIED
      // directory-cache owner binding. NO pot_members rows → EMPTY roster (fresh join).
      await orgDb.adminSql`
        INSERT INTO harness_shared.pots
          (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, decode(${hivePubkeyB64}, 'base64'),
                'kc-owner-home', 'Owner Home', null, 1, 1)
      `;
      await orgDb.adminSql`
        INSERT INTO harness_shared.pot_directory_cache (workspace_id, payload, updated_at)
        VALUES (${WORKSPACE_ID}, ${JSON.stringify({
          hives: [{ hivePubkey: hivePubkeyB64, ownerDevicePubkey: idOwner.devicePubkey }],
        })}::text::jsonb, 1)
      `;
      await mutateHarnessRegistry(
        (r) => ({
          ...r,
          projects: [
            ...r.projects,
            { slug: HIVE_HOME, path: '/tmp/owner-hive', harness_kind: 'hive', remote_hive: true },
            { slug: MEMBER_SLUG, path: '/tmp/member', hive_slug: HIVE_HOME },
          ],
        }),
        WORKSPACE_ID,
      );

      // OWNER's content-origin DB (its slug IS the hive home) + the hive schema.
      const dbOwner: FreshPgDb = await createFreshPgDb('reconnectOwner');
      cleanups.push(() => dbOwner.cleanup());
      await setupOwnerSchema(dbOwner.sql, HIVE_HOME, hivePubkeyB64);

      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      const swarmOwner = makeSwarm(testnet.bootstrap);
      const swarmMember1 = makeSwarm(testnet.bootstrap); // member's FIRST (online) transport
      const rootOwner = makeWorkspaceRoot('reconnect-owner-');
      const rootMember = makeWorkspaceRoot('reconnect-member-');

      const hiveBinding: SwarmBinding = { kind: 'hive', hive_pubkey: hivePubkeyB64 };
      // The MEMBER boots on a TOPIC binding (the real invite/link join, D-053): it
      // learns the hive's TOPIC HASH, not its pubkey, and must bootstrap-admit the
      // owner via the directory-cache owner binding.
      const memberBinding: SwarmBinding = {
        kind: 'topic',
        topic_hex: deriveSwarmTopic(hiveBinding).toString('hex'),
      };

      // OWNER = AUTHOR: throwaway per-peer apply on its own content-origin DB.
      let ownerApply: ((op: OpEnvelope) => Promise<boolean>) | undefined;
      let owner: PeerControl;
      owner = await bootViaSidecarHost({
        root: rootOwner,
        initialSwarm: swarmOwner,
        harnessSlug: HIVE_HOME,
        binding: hiveBinding,
        bootExtra: {
          announceIdentityOverride: idOwner.override,
          verifyBindingOverride: async (_pk, _login, userId) =>
            userId === idMember.userId ? 'verified' : 'fail',
          applyOverride: (op, ctx) => {
            ownerApply ??= buildOwnerApply(dbOwner.sql, HIVE_HOME, ctx.ownLogKeyHex);
            return ownerApply(op);
          },
        },
      });

      // MEMBER = RECEIVER: REAL apply (no applyOverride → getOrgPg/orgDb), TOPIC
      // binding, EMPTY pot_members → real bootstrap-admit (D-053).
      const member = await bootViaSidecarHost({
        root: rootMember,
        initialSwarm: swarmMember1,
        harnessSlug: MEMBER_SLUG,
        binding: memberBinding,
        bootExtra: { announceIdentityOverride: idMember.override },
      });

      expect(owner.handle.swarm, 'owner did not join a swarm').not.toBeNull();
      expect(member.handle.swarm, 'member did not join a swarm').not.toBeNull();
      expect(owner.handle.swarm!.topicHex).toBe(member.handle.swarm!.topicHex);

      const ownerLogKey = owner.handle.ownLog.keyHex;

      // ── STEP 1: OWNER authors its ROSTER (owner + member) + an INITIAL feature →
      //    outbox → drain → owner log. ──
      const memberAtt = (login: string, pk: string) =>
        JSON.stringify([
          { device_pubkey: pk, gist_id: `gist-${login}`, gist_url: `https://gist.github.com/${login}`, device_label: `${login}-dev`, created_at: 1, signature_by_device: 'sig' },
        ]);
      await dbOwner.sql`
        INSERT INTO harness_shared.pot_members
          (workspace_id, pot_home_slug, github_user_id, github_username, device_attestations, revoked_pubkeys, binding_status)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${idOwner.userId}, 'owner', ${memberAtt('owner', idOwner.devicePubkey)}::text::jsonb, '{}'::text[], 'verified')
      `;
      await dbOwner.sql`
        INSERT INTO harness_shared.pot_members
          (workspace_id, pot_home_slug, github_user_id, github_username, device_attestations, revoked_pubkeys, binding_status)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${idMember.userId}, 'member', ${memberAtt('member', idMember.devicePubkey)}::text::jsonb, '{}'::text[], 'verified')
      `;
      await dbOwner.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${HIVE_HOME}, 'F-init', 'Initial owner feature', 'before offline', 'todo', 0, 'local', 6001, 6001, 6001)
      `;
      const drained1 = await drainOutboxOnce(owner.handle, dbOwner.sql);
      expect(drained1, 'owner outbox (roster + initial feature) did not drain to its log').toBeGreaterThanOrEqual(3);

      // Member catches up: ADMIT owner → FEDERATE roster → APPLY F-init (origin=remote).
      const caughtUpInitial = await pollUntil(
        async () => {
          await Promise.all([owner.mergeNow(), member.mergeNow()]);
          const admitted = member.handle.admitted.has(ownerLogKey);
          const members = await orgDb.adminSql<Array<{ n: number }>>`
            SELECT COUNT(*)::int AS n FROM harness_shared.pot_members
             WHERE workspace_id = ${WORKSPACE_ID} AND pot_home_slug = ${HIVE_HOME}
          `;
          const feat = await readFeature(orgDb.adminSql, HIVE_HOME, 'F-init');
          return admitted && Number(members[0]?.n ?? 0) >= 2 && feat
            ? { feat }
            : undefined;
        },
        { timeoutMs: 30_000, intervalMs: 300 },
      );
      expect(
        caughtUpInitial?.feat,
        'STEP 1: the member never admitted + federated + applied the INITIAL owner feature',
      ).toMatchObject({ feature_id: 'F-init', origin: 'remote', title: 'Initial owner feature' });

      // Snapshot the member's replicated length of the OWNER log after the initial sync.
      const memberOwnerLenOnline = member.handle.admitted.get(ownerLogKey)!.length;
      expect(memberOwnerLenOnline, 'member should have replicated the owner log past empty').toBeGreaterThan(0);

      // ── STEP 2: MEMBER GOES OFFLINE. swarm.close() leaves the topic + stops the
      //    self-heal refresh loop + detaches the handler; DESTROY kills the live
      //    socket so no further replication can cross (a bare close leaves the
      //    existing store.replicate stream alive). ──
      await member.handle.swarm!.close();
      await swarmMember1.destroy();

      // ── STEP 3: OWNER authors NEW content WHILE THE MEMBER IS OFFLINE. ──
      await dbOwner.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${HIVE_HOME}, 'F-offline', 'Authored while member offline', 'gap content', 'todo', 0, 'local', 7001, 7001, 7001)
      `;
      const drained2 = await drainOutboxOnce(owner.handle, dbOwner.sql);
      expect(drained2, 'owner outbox (offline-window feature) did not drain to its log').toBeGreaterThanOrEqual(1);
      // The owner's log grew; the member must NOT have it yet.
      expect(owner.handle.ownLog.length, 'owner log should grow when authoring offline-window content')
        .toBeGreaterThan(memberOwnerLenOnline);

      // Offline GUARD: a merge while offline applies NOTHING new — F-offline absent,
      // and the member's replica of the owner log has NOT grown (genuinely offline,
      // not merely un-merged).
      await member.mergeNow();
      expect(
        await readFeature(orgDb.adminSql, HIVE_HOME, 'F-offline'),
        'member must NOT have the offline-window feature while disconnected',
      ).toBeUndefined();
      expect(
        member.handle.admitted.get(ownerLogKey)!.length,
        'member replica of the owner log must NOT grow while offline (no data path)',
      ).toBe(memberOwnerLenOnline);

      // ── STEP 4: MEMBER COMES BACK — swap in a FRESH transport + rekey onto the
      //    SAME topic IN PLACE (store/own-log/admitted-set/merge-cursor kept alive). ──
      const swarmMember2 = makeSwarm(testnet.bootstrap);
      member.setSwarm(swarmMember2);
      await member.rekey(memberBinding);
      expect(member.handle.swarm, 'member did not rejoin a swarm on reconnect').not.toBeNull();
      expect(member.handle.swarm!.topicHex).toBe(owner.handle.swarm!.topicHex);

      // ── STEP 5: CATCH UP — the missed op now replicates (delta from last length)
      //    and applies (origin=remote). No permanent gap. ──
      const caughtUpGap = await pollUntil(
        async () => {
          await Promise.all([owner.mergeNow(), member.mergeNow()]);
          return await readFeature(orgDb.adminSql, HIVE_HOME, 'F-offline');
        },
        { timeoutMs: 30_000, intervalMs: 300 },
      );
      expect(
        caughtUpGap,
        'STEP 5: the offline-window feature never caught up after reconnect — a PERMANENT federation gap',
      ).toMatchObject({ feature_id: 'F-offline', origin: 'remote', title: 'Authored while member offline' });

      // The member's replica of the owner log grew past its pre-offline length —
      // it replicated the append-only DELTA on reconnect.
      expect(
        member.handle.admitted.get(ownerLogKey)!.length,
        'member replica of the owner log should grow past its pre-offline length after catch-up',
      ).toBeGreaterThan(memberOwnerLenOnline);

      // The INITIAL op is still present (catch-up did not regress earlier content).
      expect(await readFeature(orgDb.adminSql, HIVE_HOME, 'F-init')).toMatchObject({
        feature_id: 'F-init',
        origin: 'remote',
      });
    },
    180_000,
  );
});
