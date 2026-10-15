/**
 * federation-security-drops-sidecar.repro.test.ts
 *
 * Plan: shared-hive-member-content-federation-2026-06-20 (D-053, D-054).
 *
 * ## What this proves — the SHARED-HIVE SECURITY DROPS in SUBSTRATE_SIDECAR mode
 * Receive-side member-content federation works end-to-end through the real sidecar
 * transport (D-053: a topic-bound joiner bootstrap-admits the owner's log and applies
 * its content origin='remote' — see `sidecar-joiner-owner-bootstrap-admit.repro.test.ts`,
 * and the multi-member fan-out in `federation-multimember-sidecar.repro.test.ts`). This
 * repro is the NEGATIVE counterpart: it proves the DROPS — a malicious / unauthorised
 * frame must NOT be applied. Each case asserts the bad op never materialises (the
 * receiver's Postgres has no such row AND the bad log is never admitted).
 *
 * The three drops, each at the gate that owns it:
 *   1. BAD-SIG announce (read-admission.ts `makeAdmissionDecider`, precedence
 *      revoked→bad_sig→verifyBinding). A peer presents an announce whose Ed25519
 *      signature does NOT verify against its announced `device_pubkey` (it signs with the
 *      WRONG key). `swarm`'s `verifyAnnounce` → false → the admission decider returns
 *      `bad_sig` → the receiver NEVER admits its log → its content never replicates,
 *      let alone applies. Proven through the REAL announce/admission path (full 2-peer
 *      sidecar swarm), and crucially even when the bad-sig device IS in the hive roster:
 *      the signature gate sits ABOVE membership, so a rostered identity with a forged
 *      signature is still dropped.
 *   2. UNAUTHORISED device (member-content-guard.ts `decideMemberContentOp` — D-002 by
 *      author IDENTITY). A device that authenticates a REAL GitHub identity (valid sig +
 *      `verifyBinding === 'verified'`) but is NOT a hive member authors content. Through
 *      the real path its log is NEVER admitted as a member (admission's same-hive resolver
 *      returns a membership-miss → buffered, never merged) AND, as the second line of
 *      defence, `decideMemberContentOp` refuses it (its source-log device ∉ the federated
 *      member device set) → not applied. So authentication passing is NOT authorisation.
 *   3. REVOKED member (the admission `revoked` precedence + the content-plane membership
 *      cut). `makeAdmissionDecider` refuses a revoked device FIRST — over a valid sig AND a
 *      `'verified'` binding (the documented revoked→bad_sig→binding precedence), so a
 *      banned member's subsequent announce is refused. And once a member is removed from
 *      the roster (the ban), `resolveHiveMemberDeviceSet` no longer returns its device, so
 *      `decideMemberContentOp` drops its SUBSEQUENT content. The K-CUT epoch read-cut (the
 *      banned member also loses epoch-key access to post-boundary ciphertext) is proven
 *      over the real wire in `federation-revocation-kcut-sidecar.repro.test.ts`; here we
 *      prove the admission + content-plane drops with the REAL deciders (D-054 permits
 *      driving `makeAdmissionDecider` / `decideMemberContentOp` with real inputs + real
 *      testcontainer PG when a full 2-peer per case is redundant with the K-CUT repro).
 *
 * ## What is REAL
 * Cases 1 + 2 boot two/three `createSubstrateSidecarHost` + `bootHarnessSubstrate` peers
 * over a loopback testnet DHT (real swarm / announce / `verifyAnnounce` / D-004 admission /
 * D-053 owner-bootstrap / merge / member-content guard) against migrated testcontainer
 * Postgres org DBs (real CDC capture + outbox drain + the real federated `pot_members`
 * read). Every case carries a POSITIVE control on the SAME path (the owner's legitimate
 * content DOES apply) so a green negative can never be a false "nothing federated at all".
 * `verifyBinding` is overridden only to stand in for the unreachable GitHub gist-attestation
 * I/O — the SAME infra stub the faithful 2-peer repros use; the admission + membership LOGIC
 * is the real path. Cases 3.b/3.c drive the REAL `makeAdmissionDecider` /
 * `decideMemberContentOp` against a real testcontainer roster.
 *
 * RUN (real testcontainer PG):
 *   cd packages/operator-core && VITEST_UNIT_TIMEOUT_MS=180000 \
 *     npx vitest run lib/sync/hyperbee/__tests__/federation-security-drops-sidecar.repro.test.ts
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
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
import { listBootHistory, _resetBootHistoryForTests } from '../boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';
import { drainOutboxOnce } from '../outbox-drain';
import { makeAdmissionDecider } from '../read-admission';
import {
  decideMemberContentOp,
  type MemberContentDecision,
} from '../member-content-guard';
import {
  resolveHiveMemberDeviceSet,
  _clearHiveMemberDeviceSetCacheForTest,
} from '../hive-member-identity-set';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  SUBSTRATE_OUTBOX_DDL,
  FILL_WORKSPACE_ID_DDL,
  HARNESS_ISSUES_CONSOLIDATED_FED_DDL,
} from '../../../../test/_work-items-schema';
import {
  _resetForTests as resetDbOrgPools,
  _resetStoreIdentityForTests,
  pinnedStoreIdentity,
} from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache the pool resolver memoizes
import { _resetUrlCacheForTests } from '../../../../../../libs/papercusp/libs/db/src/connection';
import { _resetHarnessAdminUrlCacheForTests } from '../../../embedded-pg-discovery';
import {
  _resetLongLivedAdminPoolsForTests,
  boundAdminPoolUrl,
  getLongLivedAdminPool,
} from '../../../long-lived-admin-pool';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { mutateHarnessRegistry } from '../../../harness-registry';
import { applyPot557RenameAndFixups } from './_hive-substrate-rig';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

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

// ───────────────────────────── shared scaffolding ─────────────────────────────

const cleanups: Array<() => void | Promise<void>> = [];

function resetFixturePoolState(): void {
  // Each security scenario owns a different OrgTestDb. Resolver/db-org resets
  // alone leave the separate cursor-pool registry and its identity pin alive.
  _resetLongLivedAdminPoolsForTests();
  _resetStoreIdentityForTests();
}

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      // best-effort — a thrown assertion must not leak a swarm / dir / db / store
    }
  }
  resetFixturePoolState();
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

interface Identity {
  devicePubkey: string;
  userId: number;
  login: string;
  override: NonNullable<BootHarnessOpts['announceIdentityOverride']>;
}

/** A faithful identity: the announce signs with the key that OWNS `devicePubkey`, so
 *  `verifyAnnounce` passes (the normal honest peer). */
function makeIdentity(login: string, userId: number, keychainId: string): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = rawPubkeyBase64(publicKey);
  return {
    devicePubkey,
    userId,
    login,
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

/** A FORGED identity: it announces `devicePubkey` (key A) but signs the announce with a
 *  DIFFERENT key (key B). `verifyAnnounce` rebuilds the verifier from the announced key A
 *  and rejects B's signature → the admission decider returns `bad_sig`. This is the
 *  forged-announce attack surface the D-007 / D-004 sig gate exists to close. */
function makeBadSigIdentity(login: string, userId: number, keychainId: string): Identity {
  const { publicKey } = generateKeyPairSync('ed25519'); // announced device key (A)
  const { privateKey: wrongPrivateKey } = generateKeyPairSync('ed25519'); // the WRONG signer (B)
  const devicePubkey = rawPubkeyBase64(publicKey);
  return {
    devicePubkey,
    userId,
    login,
    override: {
      resolveOpts: {
        keychainId,
        resolveGithubUser: async () => ({ id: userId, login }),
        loadKeypair: async (id: string) => ({ keychainId: id, pubkeyBase64: devicePubkey }),
        resolveAttestationGistId: async () => `gist-${login}`,
      },
      // Sign with B's private key — the signature will NOT verify against the announced A.
      sign: async (_keychainId: string, bytes: Buffer) => nodeSign(null, bytes, wrongPrivateKey),
    },
  };
}

/** A receiver verifyBinding stub standing in for the GitHub gist-attestation I/O:
 *  'verified' for the whitelisted author userIds, 'fail' otherwise. (The membership /
 *  admission LOGIC stays the real path — this only replaces the unreachable gist fetch.) */
function verifyFor(...userIds: number[]): BootHarnessOpts['verifyBindingOverride'] {
  const allow = new Set(userIds);
  return async (_pk, _login, userId) => (allow.has(userId) ? 'verified' : 'fail');
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

interface PeerControl {
  handle: BootedHarnessHandle;
  storeId: string;
  mergeNow(): Promise<number>;
}

/** Boot one peer THROUGH a dedicated substrate sidecar HOST (its own "process"). */
async function bootViaSidecarHost(args: {
  workspaceId: string;
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
    workspaceId: args.workspaceId,
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

/** env-route getOrgPg at a migrated org DB = the RECEIVER-under-test's PG view. */
function installEnv(orgDb: OrgTestDb, workspaceId: string): void {
  const prev = {
    adminUrl: process.env.HARNESS_ADMIN_DATABASE_URL,
    appUrl: process.env.HARNESS_DATABASE_URL,
    ws: process.env.PAPERCUSP_WORKSPACE_ID,
    skip: process.env.PAPERCUSP_SKIP_PG_DISCOVERY,
    pgb: process.env.PAPERCUSP_PGBOUNCER,
  };
  process.env.HARNESS_ADMIN_DATABASE_URL = orgDb.adminDsn;
  process.env.HARNESS_DATABASE_URL = orgDb.appDsn;
  process.env.PAPERCUSP_WORKSPACE_ID = workspaceId;
  process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
  process.env.PAPERCUSP_PGBOUNCER = '0';
  _resetUrlCacheForTests();
  _resetHarnessAdminUrlCacheForTests();
  void resetDbOrgPools();
  _clearHiveMemberDeviceSetCacheForTest();
  cleanups.push(async () => {
    if (prev.adminUrl === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
    else process.env.HARNESS_ADMIN_DATABASE_URL = prev.adminUrl;
    if (prev.appUrl === undefined) delete process.env.HARNESS_DATABASE_URL;
    else process.env.HARNESS_DATABASE_URL = prev.appUrl;
    if (prev.ws === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
    else process.env.PAPERCUSP_WORKSPACE_ID = prev.ws;
    if (prev.skip === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
    else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = prev.skip;
    if (prev.pgb === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
    else process.env.PAPERCUSP_PGBOUNCER = prev.pgb;
    _resetUrlCacheForTests();
    _resetHarnessAdminUrlCacheForTests();
    _clearHiveMemberDeviceSetCacheForTest();
    await resetDbOrgPools();
  });
}

/** The AUTHOR's content-origin schema: features + the CDC capture so a direct
 *  origin='local' INSERT drains to the author's log. */
async function setupAuthorSchema(sql: postgres.Sql, authorSlug: string, workspaceId: string): Promise<void> {
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
    VALUES ('p-fed', 'Fed', 'active', ${authorSlug}, ${workspaceId}, 0, 0)
  `;
  await sql.unsafe(SUBSTRATE_OUTBOX_DDL);
  await sql.unsafe(FILL_WORKSPACE_ID_DDL);
  await sql.unsafe(HARNESS_ISSUES_CONSOLIDATED_FED_DDL); // defines capture_substrate_outbox
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '375-work-items-cdc-capture.sql'), 'utf8')));
}

/** The OWNER author additionally needs the Hive schema so it can author the ROSTER
 *  (pot_members) into its own log — the joiners federate it from there. */
async function setupOwnerSchema(sql: postgres.Sql, hiveHome: string, hivePubkeyB64: string, workspaceId: string): Promise<void> {
  await setupAuthorSchema(sql, hiveHome, workspaceId);
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '184-hives-table.sql'), 'utf8')));
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '185-hive-members-admission.sql'), 'utf8')));
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '189-hive-members-federation-cols.sql'), 'utf8')));
  await applyPot557RenameAndFixups(sql);
  await sql`
    INSERT INTO harness_shared.pots
      (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
    VALUES (${workspaceId}, ${hiveHome}, decode(${hivePubkeyB64}, 'base64'),
            'kc-owner-home', 'Owner Home', null, 1, 1)
  `;
}

const memberAtt = (login: string, pk: string) =>
  JSON.stringify([
    {
      device_pubkey: pk,
      gist_id: `gist-${login}`,
      gist_url: `https://gist.github.com/${login}`,
      device_label: `${login}-dev`,
      created_at: 1,
      signature_by_device: 'sig',
    },
  ]);

/** Author one pot_members ROSTER row (fires the capture trigger → outbox → log). */
async function authorRosterRow(sql: postgres.Sql, hiveHome: string, workspaceId: string, id: Identity): Promise<void> {
  await sql`
    INSERT INTO harness_shared.pot_members
      (workspace_id, pot_home_slug, github_user_id, github_username, device_attestations, revoked_pubkeys, binding_status)
    VALUES (${workspaceId}, ${hiveHome}, ${id.userId}, ${id.login},
            ${memberAtt(id.login, id.devicePubkey)}::text::jsonb, '{}'::text[], 'verified')
  `;
}

/** Seed the `hives` row a `pot_members` row FK-references (pot_members_hive_fkey). */
async function seedHiveRow(sql: postgres.Sql, hiveHome: string, workspaceId: string): Promise<void> {
  const { publicKey } = generateKeyPairSync('ed25519');
  await sql`
    INSERT INTO harness_shared.pots
      (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
    VALUES (${workspaceId}, ${hiveHome}, decode(${rawPubkeyBase64(publicKey)}, 'base64'),
            'kc-owner-home', 'Owner Home', null, 1, 1)
  `;
}

/** Seed a pot_members roster row DIRECTLY in the (migrated) org DB. */
async function seedRosterRow(sql: postgres.Sql, hiveHome: string, workspaceId: string, id: Identity): Promise<void> {
  await sql`
    INSERT INTO harness_shared.pot_members
      (workspace_id, pot_home_slug, github_user_id, github_username, device_attestations, revoked_pubkeys, binding_status)
    VALUES (${workspaceId}, ${hiveHome}, ${id.userId}, ${id.login},
            ${memberAtt(id.login, id.devicePubkey)}::text::jsonb, '{}'::text[], 'verified')
  `;
}

/** Author one feature under `slug` (fires the capture trigger → outbox → log). */
async function authorFeature(
  sql: postgres.Sql,
  slug: string,
  featureId: string,
  title: string,
  ts: number,
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
    VALUES (${slug}, ${featureId}, ${title}, 'fed', 'todo', 0, 'local', ${ts}, ${ts}, ${ts})
  `;
}

interface SeenFeature {
  feature_id: string;
  title: string | null;
  status: string | null;
  origin: string;
}

async function readFeature(sql: postgres.Sql, slug: string, featureId: string): Promise<SeenFeature | undefined> {
  const rows = await sql<SeenFeature[]>`
    SELECT feature_id, title, status, origin
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${slug} AND feature_id = ${featureId}
  `;
  return rows[0];
}

/**
 * Boot OWNER (author + roster source) + a fresh topic-bound RECEIVER (member joiner, its
 * PG is observed) + an ATTACKER peer (its own author DB). The owner's content is the
 * POSITIVE control: it MUST reach the receiver (origin='remote'), proving the path is live
 * — so the attacker's content being absent is a genuine DROP, not a dead swarm.
 *
 * `attackerInRoster` lets a case prove a gate sits ABOVE membership (a forged-sig or
 * revoked device that IS rostered is still dropped). Returns whether each log was admitted,
 * the federated owner feature (control), the attacker feature (must be absent), and the
 * receiver's boot events (to assert WHICH gate dropped the attacker).
 */
async function runReceiverWithAttacker(opts: {
  wsId: string;
  hiveHome: string;
  recvSlug: string;
  attackerSlug: string;
  owner: Identity;
  recv: Identity;
  attacker: Identity;
  attackerInRoster: boolean;
  /** Pubkeys the RECEIVER boots with in its `revoked` set (the local ban list). */
  receiverRevoked?: string[];
}): Promise<{
  admittedOwner: boolean;
  admittedAttacker: boolean;
  ownerFeature?: SeenFeature;
  attackerFeature?: SeenFeature;
  recvEvents: ReturnType<typeof listBootHistory>;
}> {
  const { wsId, hiveHome, recvSlug, attackerSlug, owner, recv, attacker, attackerInRoster } = opts;

  const orgDb: OrgTestDb = await createOrgTestDb();
  cleanups.push(() => orgDb.cleanup());
  installEnv(orgDb, wsId);

  const { publicKey: hivePub } = generateKeyPairSync('ed25519');
  const hivePubkeyB64 = rawPubkeyBase64(hivePub);

  // Receiver's PG: a hives row (home resolution) + the VERIFIED directory-cache owner
  // binding (the SOLE source the topic-bound D-053 bootstrap-admit reads). NO pot_members
  // rows → EMPTY roster = the genuine fresh-join state.
  await orgDb.adminSql`
    INSERT INTO harness_shared.pots
      (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
    VALUES (${wsId}, ${hiveHome}, decode(${hivePubkeyB64}, 'base64'), 'kc-owner-home', 'Owner Home', null, 1, 1)
  `;
  await orgDb.adminSql`
    INSERT INTO harness_shared.pot_directory_cache (workspace_id, payload, updated_at)
    VALUES (${wsId}, ${JSON.stringify({
      hives: [{ hivePubkey: hivePubkeyB64, ownerDevicePubkey: owner.devicePubkey }],
    })}::text::jsonb, 1)
  `;

  // Registry: HIVE_HOME is a remote_hive VIEW; the receiver + attacker slugs join it.
  await mutateHarnessRegistry(
    (r) => ({
      ...r,
      projects: [
        ...r.projects,
        { slug: hiveHome, path: '/tmp/sd-owner', harness_kind: 'hive', remote_hive: true },
        { slug: recvSlug, path: '/tmp/sd-recv', hive_slug: hiveHome },
        { slug: attackerSlug, path: '/tmp/sd-attacker', hive_slug: hiveHome },
      ],
    }),
    wsId,
  );

  // Sanity: the receiver's boot reads resolve as the repro relies on.
  const { joinerPotHomeSlug } = await import('../../../hive-federation');
  const { loadHiveOwnerDevicePubkey } = await import('../../../hive-membership-store');
  expect(await joinerPotHomeSlug(wsId, recvSlug)).toBe(hiveHome);
  expect(await loadHiveOwnerDevicePubkey(wsId, hivePubkeyB64)).toBe(owner.devicePubkey);
  _clearHiveMemberDeviceSetCacheForTest();

  // OWNER author (content + roster) DB; ATTACKER author DB.
  const dbOwner: FreshPgDb = await createFreshPgDb('sdOwner');
  cleanups.push(() => dbOwner.cleanup());
  await setupOwnerSchema(dbOwner.sql, hiveHome, hivePubkeyB64, wsId);
  const dbAttacker: FreshPgDb = await createFreshPgDb('sdAttacker');
  cleanups.push(() => dbAttacker.cleanup());
  await setupAuthorSchema(dbAttacker.sql, attackerSlug, wsId);

  const testnet = await createTestnet(3);
  cleanups.push(async () => {
    try {
      await testnet.destroy();
    } catch {
      /* ignore */
    }
  });

  const hiveBinding: SwarmBinding = { kind: 'hive', hive_pubkey: hivePubkeyB64 };
  const topicBinding: SwarmBinding = {
    kind: 'topic',
    topic_hex: deriveSwarmTopic(hiveBinding).toString('hex'),
  };

  // OWNER (author): serves its log; its own apply is irrelevant (no-op).
  const ownerPeer = await bootViaSidecarHost({
    workspaceId: wsId,
    root: makeWorkspaceRoot('sd-owner-'),
    swarm: makeSwarm(testnet.bootstrap),
    harnessSlug: hiveHome,
    binding: hiveBinding,
    bootExtra: {
      announceIdentityOverride: owner.override,
      verifyBindingOverride: verifyFor(recv.userId, attacker.userId),
      applyOverride: async () => true,
    },
  });

  // ATTACKER (author): serves its log; no-op apply. Its announce identity is whatever the
  // case wired (a forged-sig identity for the bad-sig case, an honest one otherwise).
  const attackerPeer = await bootViaSidecarHost({
    workspaceId: wsId,
    root: makeWorkspaceRoot('sd-attacker-'),
    swarm: makeSwarm(testnet.bootstrap),
    harnessSlug: attackerSlug,
    binding: topicBinding,
    bootExtra: {
      announceIdentityOverride: attacker.override,
      verifyBindingOverride: verifyFor(owner.userId, recv.userId),
      applyOverride: async () => true,
    },
  });

  // RECEIVER (under test): REAL boot apply → getOrgPg/orgDb. EMPTY roster, REAL D-053
  // bootstrap-admit. pendingRetryMs>0 so a buffered attacker is RE-evaluated each tick
  // (proving it STAYS rejected across retries, never sneaks in late).
  const recvPeer = await bootViaSidecarHost({
    workspaceId: wsId,
    root: makeWorkspaceRoot('sd-recv-'),
    swarm: makeSwarm(testnet.bootstrap),
    harnessSlug: recvSlug,
    binding: topicBinding,
    bootExtra: {
      announceIdentityOverride: recv.override,
      verifyBindingOverride: verifyFor(owner.userId, attacker.userId),
      pendingRetryMs: 250,
      ...(opts.receiverRevoked
        ? { loadRevokedOverride: async () => new Set(opts.receiverRevoked) }
        : {}),
    },
  });

  expect(ownerPeer.handle.swarm, 'owner did not join a swarm').not.toBeNull();
  expect(attackerPeer.handle.swarm, 'attacker did not join a swarm').not.toBeNull();
  expect(recvPeer.handle.swarm, 'receiver did not join a swarm').not.toBeNull();
  expect(ownerPeer.handle.swarm!.topicHex).toBe(recvPeer.handle.swarm!.topicHex);
  expect(attackerPeer.handle.swarm!.topicHex).toBe(recvPeer.handle.swarm!.topicHex);

  // OWNER authors the ROSTER (always owner + receiver; + attacker when the case wants to
  // prove the gate beats membership) + its content feature → outbox → drain → owner log.
  const rosterIds = attackerInRoster ? [owner, recv, attacker] : [owner, recv];
  for (const id of rosterIds) await authorRosterRow(dbOwner.sql, hiveHome, wsId, id);
  await authorFeature(dbOwner.sql, hiveHome, 'F-owner', 'Owner feature', 6001);
  const ownerDrained = await drainOutboxOnce(ownerPeer.handle, dbOwner.sql);
  expect(ownerDrained, 'owner outbox (roster + feature) did not drain to its log').toBeGreaterThanOrEqual(
    rosterIds.length + 1,
  );

  // ATTACKER authors its content feature → outbox → drain → attacker log. (It serves it;
  // whether the receiver ever reads it is the whole question.)
  await authorFeature(dbAttacker.sql, attackerSlug, 'F-attacker', 'Attacker feature', 7001);
  expect(
    await drainOutboxOnce(attackerPeer.handle, dbAttacker.sql),
    'attacker outbox (feature) did not drain to its log',
  ).toBeGreaterThanOrEqual(1);

  // POSITIVE CONTROL: merge until the OWNER feature lands on the receiver (origin='remote').
  // That proves the swarm + admission + merge + member-content apply pipeline is LIVE.
  const control = await pollUntil(
    async () => {
      await Promise.all([ownerPeer.mergeNow(), attackerPeer.mergeNow(), recvPeer.mergeNow()]);
      return (await readFeature(orgDb.adminSql, hiveHome, 'F-owner')) ?? undefined;
    },
    { timeoutMs: 60_000, intervalMs: 300 },
  );

  // Extra passes: give the attacker's content EVERY chance to (wrongly) replicate + apply
  // after the control has already proven the pipeline is flowing.
  for (let i = 0; i < 10; i++) {
    await Promise.all([ownerPeer.mergeNow(), attackerPeer.mergeNow(), recvPeer.mergeNow()]);
  }

  return {
    admittedOwner: recvPeer.handle.admitted.has(ownerPeer.handle.ownLog.keyHex),
    admittedAttacker: recvPeer.handle.admitted.has(attackerPeer.handle.ownLog.keyHex),
    ownerFeature: control ?? (await readFeature(orgDb.adminSql, hiveHome, 'F-owner')),
    attackerFeature: await readFeature(orgDb.adminSql, attackerSlug, 'F-attacker'),
    recvEvents: listBootHistory({ workspaceId: wsId, harnessSlug: recvSlug, limit: 80 }),
  };
}

// ─────────────────────────────────── tests ───────────────────────────────────

describe('SIDECAR security fixture pool lifecycle', () => {
  it('preserves a real rebind warning while isolating the next database fixture', async () => {
    const first = await createOrgTestDb();
    cleanups.push(() => first.cleanup());
    const second = await createOrgTestDb();
    cleanups.push(() => second.cleanup());
    const previous = {
      adminUrl: process.env.HARNESS_ADMIN_DATABASE_URL,
      skipDiscovery: process.env.PAPERCUSP_SKIP_PG_DISCOVERY,
      pgbouncer: process.env.PAPERCUSP_PGBOUNCER,
    };
    cleanups.push(() => {
      if (previous.adminUrl === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
      else process.env.HARNESS_ADMIN_DATABASE_URL = previous.adminUrl;
      if (previous.skipDiscovery === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
      else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = previous.skipDiscovery;
      if (previous.pgbouncer === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
      else process.env.PAPERCUSP_PGBOUNCER = previous.pgbouncer;
      _resetUrlCacheForTests();
      _resetHarnessAdminUrlCacheForTests();
    });
    const routeTo = (database: OrgTestDb) => {
      process.env.HARNESS_ADMIN_DATABASE_URL = database.adminDsn;
      process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
      process.env.PAPERCUSP_PGBOUNCER = '0';
      _resetUrlCacheForTests();
      _resetHarnessAdminUrlCacheForTests();
      _resetStoreIdentityForTests();
    };
    const label = 'pg-merge-cursor-store';
    resetFixturePoolState();
    routeTo(first);
    const firstPool = getLongLivedAdminPool(label);
    cleanups.push(() => firstPool.end({ timeout: 1 }));
    expect((await firstPool`SELECT current_database() AS name`)[0].name).toBe(first.dbName);
    // The independent identity query must settle before the next fixture reset.
    await vi.waitFor(() => expect(pinnedStoreIdentity()?.database).toBe(first.dbName));
    expect(boundAdminPoolUrl(label)).toBe(first.adminDsn);

    routeTo(second);
    expect(boundAdminPoolUrl(label)).toBe(first.adminDsn);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const secondPool = getLongLivedAdminPool(label);
      cleanups.push(() => secondPool.end({ timeout: 1 }));
      expect((await secondPool`SELECT current_database() AS name`)[0].name).toBe(second.dbName);
      await vi.waitFor(() => expect(pinnedStoreIdentity()?.database).toBe(second.dbName));
      expect(boundAdminPoolUrl(label)).toBe(second.adminDsn);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        '[db] pg-merge-cursor-store pool rebound: target changed since it was built — rebuilding',
      );

      resetFixturePoolState();
      routeTo(first);
      expect(boundAdminPoolUrl(label)).toBeNull();
      warn.mockClear();
      const freshPool = getLongLivedAdminPool(label);
      cleanups.push(() => freshPool.end({ timeout: 1 }));
      expect((await freshPool`SELECT current_database() AS name`)[0].name).toBe(first.dbName);
      await vi.waitFor(() => expect(pinnedStoreIdentity()?.database).toBe(first.dbName));
      expect(boundAdminPoolUrl(label)).toBe(first.adminDsn);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('SIDECAR shared-hive SECURITY DROPS — a malicious / unauthorised frame must NOT be applied (D-053/D-054)', () => {
  it(
    'DROP 1 — BAD-SIG announce: a forged-signature peer (even one IN the roster) is rejected (bad_sig), never admitted, its content never applies',
    async () => {
      const wsId = 'ws-sd-badsig';
      const owner = makeIdentity('sd-owner', 99, 'kc-sd-owner');
      const recv = makeIdentity('sd-recv', 11, 'kc-sd-recv');
      // The attacker IS a rostered identity, but its announce signature is FORGED.
      const attacker = makeBadSigIdentity('sd-badsig', 22, 'kc-sd-badsig');

      const r = await runReceiverWithAttacker({
        wsId,
        hiveHome: 'sdbs-owner-hive',
        recvSlug: 'sdbs-recv',
        attackerSlug: 'sdbs-attacker',
        owner,
        recv,
        attacker,
        attackerInRoster: true, // prove the SIG gate sits ABOVE membership
      });

      // Positive control: the legit path works.
      expect(r.admittedOwner, "the receiver never admitted the OWNER's log (control broke)").toBe(true);
      expect(r.ownerFeature, 'control: owner feature never reached the receiver PG').toMatchObject({
        feature_id: 'F-owner',
        origin: 'remote',
      });

      // THE DROP: the forged-sig peer is never admitted and its content never lands.
      expect(
        r.admittedAttacker,
        'SECURITY HOLE: the receiver ADMITTED a forged-signature peer log',
      ).toBe(false);
      expect(
        r.attackerFeature,
        'SECURITY HOLE: a forged-signature peer’s content was APPLIED to the receiver PG',
      ).toBeUndefined();
      // The gate that dropped it is the signature gate (bad_sig), not membership.
      expect(
        r.recvEvents.some((e) => e.kind === 'announce_rejected' && (e.message ?? '').includes('bad_sig')),
        'expected an announce_rejected:bad_sig event for the forged-sig peer',
      ).toBe(true);
    },
    180_000,
  );

  it(
    'DROP 2 — UNAUTHORISED device: a real GitHub identity that is NOT a hive member is dropped (membership miss + member-content guard), never applies',
    async () => {
      const wsId = 'ws-sd-unauth';
      const owner = makeIdentity('sd-owner', 99, 'kc-sd-owner');
      const recv = makeIdentity('sd-recv', 11, 'kc-sd-recv');
      // The attacker AUTHENTICATES (valid sig + verifyBinding 'verified') but is NOT in the roster.
      const attacker = makeIdentity('sd-unauth', 33, 'kc-sd-unauth');

      const r = await runReceiverWithAttacker({
        wsId,
        hiveHome: 'sdua-owner-hive',
        recvSlug: 'sdua-recv',
        attackerSlug: 'sdua-attacker',
        owner,
        recv,
        attacker,
        attackerInRoster: false, // the point: a non-member
      });

      // Positive control.
      expect(r.admittedOwner, "the receiver never admitted the OWNER's log (control broke)").toBe(true);
      expect(r.ownerFeature, 'control: owner feature never reached the receiver PG').toMatchObject({
        feature_id: 'F-owner',
        origin: 'remote',
      });

      // THE DROP: authentication passed, but authorisation (membership) did not — so the
      // unauthorised log is never admitted as a member and its content never applies.
      expect(
        r.admittedAttacker,
        'SECURITY HOLE: the receiver ADMITTED a non-member device’s log',
      ).toBe(false);
      expect(
        r.attackerFeature,
        'SECURITY HOLE: a non-member device’s content was APPLIED to the receiver PG',
      ).toBeUndefined();
      // It was dropped on MEMBERSHIP (a same-hive membership-miss buffer), not on identity —
      // i.e. it authenticated fine; it simply is not a member.
      expect(
        r.recvEvents.some(
          (e) => e.kind === 'announce_pending' && (e.message ?? '').includes('membership_miss'),
        ),
        'expected an announce_pending:membership_miss event for the unauthorised (non-member) peer',
      ).toBe(true);
    },
    180_000,
  );

  it(
    'DROP 2b — member-content guard (real testcontainer roster): decideMemberContentOp refuses a non-member author device, admits a member author device',
    async () => {
      const wsId = 'ws-sd-guard';
      const hiveHome = 'sdg-owner-hive';
      const owner = makeIdentity('sdg-owner', 99, 'kc-sdg-owner');
      const member = makeIdentity('sdg-member', 11, 'kc-sdg-member');
      const outsider = makeIdentity('sdg-outsider', 44, 'kc-sdg-outsider');

      const orgDb: OrgTestDb = await createOrgTestDb();
      cleanups.push(() => orgDb.cleanup());
      installEnv(orgDb, wsId);

      // Real roster = {owner, member}; the outsider is deliberately absent.
      await seedHiveRow(orgDb.adminSql, hiveHome, wsId);
      await seedRosterRow(orgDb.adminSql, hiveHome, wsId, owner);
      await seedRosterRow(orgDb.adminSql, hiveHome, wsId, member);
      _clearHiveMemberDeviceSetCacheForTest();

      // Sanity over the REAL federated read: the set has the two members, not the outsider.
      const set = await resolveHiveMemberDeviceSet(wsId, hiveHome);
      expect(set.has(owner.devicePubkey)).toBe(true);
      expect(set.has(member.devicePubkey)).toBe(true);
      expect(set.has(outsider.devicePubkey)).toBe(false);
      _clearHiveMemberDeviceSetCacheForTest();

      // The guard, driven with real inputs (sql omitted → the SAME getOrgPg seam admission
      // uses). opts.harnessSlug is the receiver's own slug; rowHarnessSlug is the author's
      // (cross-member). A member's op applies; the outsider's is refused (not 'apply').
      const guardOpts = { workspaceId: wsId, harnessSlug: 'sdg-recv', potHomeSlug: hiveHome };
      const memberDecision: MemberContentDecision = await decideMemberContentOp(
        'sdg-member', // a cross-member author slug
        guardOpts,
        member.devicePubkey,
      );
      const outsiderDecision: MemberContentDecision = await decideMemberContentOp(
        'sdg-outsider',
        guardOpts,
        outsider.devicePubkey,
      );

      expect(memberDecision, 'control: a real member author device must APPLY').toBe('apply');
      expect(
        outsiderDecision,
        'SECURITY HOLE: the member-content guard APPLIED a non-member author device’s op',
      ).not.toBe('apply');
    },
    120_000,
  );

  it(
    'DROP 3 — REVOKED member (admission decider, real makeAdmissionDecider): a revoked device is refused FIRST, beating a valid signature AND a verified binding',
    async () => {
      const banned = 'BANNED_DEVICE_PUBKEY_b64====';
      const good = 'GOOD_DEVICE_PUBKEY_b64======';

      // The REAL admission decider boot wires (read-admission.ts), with a binding that would
      // OTHERWISE admit everyone — so the only thing that can drop the banned device is the
      // `revoked` precedence (revoked → bad_sig → verifyBinding).
      const admit = makeAdmissionDecider({
        verifyBinding: async () => 'verified',
        revoked: new Set([banned]),
      });

      const baseInput = {
        github_login: 'mallory',
        github_user_id: 22,
        attestation_gist_id: 'gist-mallory',
      };

      // A revoked device with a VALID sig + a binding that verifies → still REJECTED (revoked).
      expect(
        await admit({ ...baseInput, device_pubkey: banned, sigValid: true }),
        'SECURITY HOLE: a revoked device with a valid sig + verified binding was ADMITTED',
      ).toEqual({ admit: false, reason: 'revoked' });

      // Revoked beats bad_sig too (revocation is checked FIRST): even an invalid sig reports
      // 'revoked', not 'bad_sig' — the documented precedence.
      expect(
        await admit({ ...baseInput, device_pubkey: banned, sigValid: false }),
      ).toEqual({ admit: false, reason: 'revoked' });

      // Control: a NON-revoked device with a valid sig + verified binding IS admitted, so the
      // rejection above is genuinely the revocation cut, not a blanket deny.
      expect(
        await admit({ ...baseInput, device_pubkey: good, sigValid: true }),
      ).toEqual({ admit: true });

      // Control: a non-revoked device with a bad sig is dropped on bad_sig (the next gate).
      expect(
        await admit({ ...baseInput, device_pubkey: good, sigValid: false }),
      ).toEqual({ admit: false, reason: 'bad_sig' });
    },
    60_000,
  );

  it(
    'DROP 3b — REVOKED/BANNED member (real testcontainer roster): once removed from pot_members, decideMemberContentOp drops the member’s SUBSEQUENT content',
    async () => {
      const wsId = 'ws-sd-ban';
      const hiveHome = 'sdban-owner-hive';
      const owner = makeIdentity('sdban-owner', 99, 'kc-sdban-owner');
      const member = makeIdentity('sdban-member', 11, 'kc-sdban-member');

      const orgDb: OrgTestDb = await createOrgTestDb();
      cleanups.push(() => orgDb.cleanup());
      installEnv(orgDb, wsId);

      await seedHiveRow(orgDb.adminSql, hiveHome, wsId);
      await seedRosterRow(orgDb.adminSql, hiveHome, wsId, owner);
      await seedRosterRow(orgDb.adminSql, hiveHome, wsId, member);
      _clearHiveMemberDeviceSetCacheForTest();

      const guardOpts = { workspaceId: wsId, harnessSlug: 'sdban-recv', potHomeSlug: hiveHome };

      // BEFORE the ban: the member's cross-member content applies.
      expect(
        await decideMemberContentOp('sdban-member', guardOpts, member.devicePubkey),
        'control: a current member’s content must apply BEFORE the ban',
      ).toBe('apply');

      // BAN: remove the member from the roster (the membership cut a pot:ban_member drives).
      await orgDb.adminSql`
        DELETE FROM harness_shared.pot_members
         WHERE workspace_id = ${wsId} AND pot_home_slug = ${hiveHome}
           AND github_user_id = ${member.userId}
      `;
      // The onMemberApplied hook invalidates this in production; do it explicitly here.
      _clearHiveMemberDeviceSetCacheForTest();

      const set = await resolveHiveMemberDeviceSet(wsId, hiveHome);
      expect(set.has(member.devicePubkey), 'the banned member must be gone from the device set').toBe(false);
      _clearHiveMemberDeviceSetCacheForTest();

      // AFTER the ban: the SAME member device’s SUBSEQUENT content is no longer applied.
      expect(
        await decideMemberContentOp('sdban-member', guardOpts, member.devicePubkey),
        'SECURITY HOLE: a banned (roster-removed) member’s content was still APPLIED',
      ).not.toBe('apply');
    },
    120_000,
  );
});
