/**
 * federation-multimember-sidecar.repro.test.ts
 *
 * Plan: shared-hive-member-content-federation-2026-06-20 (D-052, D-053).
 *
 * ## THE NEW DIMENSION (>2 peers — no prior test covers it)
 * Every faithful sidecar repro to date boots exactly TWO peers (owner + one joiner):
 *   - sidecar-joiner-owner-bootstrap-admit.repro.test.ts (owner + 1 joiner)
 *   - federation-content-matrix.repro.test.ts             (owner + 1 member)
 * So the MULTI-MEMBER fan-out has never been exercised: does a THIRD peer change
 * anything? In particular —
 *   (a) does an owner's content reach BOTH members, not just the first to connect, and
 *   (b) does a member's content reach its SIBLING member (member↔member), or does it
 *       only ever flow to the owner?
 *
 * ## TOPOLOGY PROVEN (member↔member is DIRECT, not owner-relayed)
 * In the substrate model a member's content lives ONLY on that member's OWN hypercore
 * log. The owner does NOT re-author a received member's content onto the owner log
 * (remote-origin rows don't re-capture — skipOwnOps / the origin guard). So a sibling
 * can ONLY see member M1's content by DIRECTLY admitting + replicating M1's log. That
 * happens via the SAME identity-admission path the owner uses (D-002: admit a log iff
 * its announce device_pubkey ∈ the hive's federated `pot_members`), reached on the
 * fresh joiner only AFTER:
 *   1. it bootstrap-admits the OWNER (D-053 directory-cache owner binding, topic-bound), then
 *   2. federates the owner's ROSTER (all three members) into its PG, then
 *   3. the member-set cache invalidates (onMemberApplied) so resolveHiveMemberDeviceSet
 *      now returns the sibling's device, then
 *   4. the pending-peer retry loop (boot.ts retryPendingOnce) re-admits the sibling whose
 *      announce was BUFFERED at connect time (its membership had not federated yet —
 *      the WI-559 asymmetric-stall buffer). This needs pendingRetryMs > 0 (the 2-peer
 *      repros pin it to 0 because a joiner only ever admits the ONE owner at first
 *      announce; a sibling federates LATER, so the retry is load-bearing here).
 *
 * ## What this repro proves (THREE real sidecar-host peers, ONE hive, real swarm + PG)
 * Each `it` boots O + M1 + M2 through the REAL substrate sidecar HOST
 * (createSubstrateSidecarHost → bootHarnessSubstrate → real swarm / announce / admission
 * / merge), and asserts ONE peer's PG (the RECEIVER, on the REAL boot apply seam → the
 * env-routed org DB) ends with the OTHER TWO peers' content at origin='remote'. The two
 * NON-receivers are AUTHORS on their own throwaway content DBs (a no-op applyOverride —
 * they only SERVE their log). Rotating the receiver across all three peers asserts EACH
 * peer's PG, with NO identity/membership stubs on the receive path (real
 * resolveHiveMemberDeviceSet, real loadHiveOwnerDevicePubkey bootstrap, real member-content
 * guard). verifyBinding is overridden ONLY to stand in for the GitHub gist-attestation I/O
 * (unreachable locally) — the same infra stub both 2-peer faithful repros use; the
 * membership/admission LOGIC is the real path.
 *
 *   - it #1 (receiver = MEMBER M1): M1 ends with the OWNER's feature (O→M1) AND the
 *     SIBLING M2's feature (M2→M1, member↔member) — both origin='remote'.
 *   - it #2 (receiver = MEMBER M2): symmetric — M2 ends with O→M2 AND M1→M2.
 *   - it #3 (receiver = OWNER O): O ends with BOTH members' features (M1→O AND M2→O)
 *     via the owner-home content-guard fallback (WI-559/FED-1).
 *
 * Together: "owner content fans out to BOTH members", "a member's content reaches the
 * owner AND the sibling member", and "each peer's PG ends with the others' content".
 *
 * RUN (real testcontainer PG):
 *   cd packages/operator-core && VITEST_UNIT_TIMEOUT_MS=180000 \
 *     npx vitest run lib/sync/hyperbee/__tests__/federation-multimember-sidecar.repro.test.ts
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
import { _resetBootHistoryForTests } from '../boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';
import { drainOutboxOnce } from '../outbox-drain';
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
  STORE_IDENTITY_SQL,
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
import { _clearHiveMemberDeviceSetCacheForTest } from '../hive-member-identity-set';
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
  // Each topology owns a fresh DB; resolver resets do not clear cursor pools.
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
  _resetCacheForTests();
  _resetBootHistoryForTests();
  resetFixturePoolState();
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

/** A receiver verifyBinding stub that stands in for the GitHub gist-attestation I/O:
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

// ─────────────────────────────────── tests ───────────────────────────────────

describe('SIDECAR multi-member fixture pool lifecycle', () => {
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
    expect((await firstPool.unsafe(STORE_IDENTITY_SQL))[0].database).toBe(first.dbName);
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
      expect((await secondPool.unsafe(STORE_IDENTITY_SQL))[0].database).toBe(second.dbName);
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
      expect((await freshPool.unsafe(STORE_IDENTITY_SQL))[0].database).toBe(first.dbName);
      await vi.waitFor(() => expect(pinnedStoreIdentity()?.database).toBe(first.dbName));
      expect(boundAdminPoolUrl(label)).toBe(first.adminDsn);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('SIDECAR multi-member (>2 peers) federation — owner + 2 members on ONE hive, real swarm + PG, no membership stubs (D-052/D-053)', () => {
  /**
   * Shared body for the two MEMBER-receiver cases (it #1 / it #2). The RECEIVER is a
   * fresh, EMPTY-roster member booted TOPIC-bound (the real invite/link join): it
   * bootstrap-admits the OWNER (directory cache), federates the 3-member roster, then
   * pending-retry-admits the SIBLING member and applies its content. Asserts the
   * receiver's PG ends with BOTH the owner's AND the sibling's feature (origin='remote').
   */
  async function runMemberReceiver(opts: {
    wsId: string;
    hiveHome: string;
    recvSlug: string;
    siblingSlug: string;
    recv: Identity; // the receiver-under-test (a member)
    sibling: Identity; // the other member (an author)
    owner: Identity; // the hive owner (an author)
  }): Promise<{
    ownerFeature?: SeenFeature;
    siblingFeature?: SeenFeature;
    admittedOwner: boolean;
    admittedSibling: boolean;
  }> {
    const { wsId, hiveHome, recvSlug, siblingSlug, recv, sibling, owner } = opts;

    const orgDb: OrgTestDb = await createOrgTestDb();
    cleanups.push(() => orgDb.cleanup());
    installEnv(orgDb, wsId);

    const { publicKey: hivePub } = generateKeyPairSync('ed25519');
    const hivePubkeyB64 = rawPubkeyBase64(hivePub);

    // Receiver's PG: a hives row (home resolution) + the VERIFIED directory-cache owner
    // binding (the SOLE source the topic-bound bootstrap-admit reads). NO pot_members →
    // EMPTY roster = the genuine fresh-join state.
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

    // Registry: HIVE_HOME is a remote_hive VIEW; both member slugs join it.
    await mutateHarnessRegistry(
      (r) => ({
        ...r,
        projects: [
          ...r.projects,
          { slug: hiveHome, path: '/tmp/mm-owner', harness_kind: 'hive', remote_hive: true },
          { slug: recvSlug, path: '/tmp/mm-recv', hive_slug: hiveHome },
          { slug: siblingSlug, path: '/tmp/mm-sibling', hive_slug: hiveHome },
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

    // OWNER author content+roster DB; SIBLING author content DB.
    const dbOwner: FreshPgDb = await createFreshPgDb('mmOwner');
    cleanups.push(() => dbOwner.cleanup());
    await setupOwnerSchema(dbOwner.sql, hiveHome, hivePubkeyB64, wsId);
    const dbSibling: FreshPgDb = await createFreshPgDb('mmSibling');
    cleanups.push(() => dbSibling.cleanup());
    await setupAuthorSchema(dbSibling.sql, siblingSlug, wsId);

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
      root: makeWorkspaceRoot('mm-owner-'),
      swarm: makeSwarm(testnet.bootstrap),
      harnessSlug: hiveHome,
      binding: hiveBinding,
      bootExtra: {
        announceIdentityOverride: owner.override,
        verifyBindingOverride: verifyFor(recv.userId, sibling.userId),
        applyOverride: async () => true,
      },
    });

    // SIBLING (author): serves its log; no-op apply.
    const siblingPeer = await bootViaSidecarHost({
      workspaceId: wsId,
      root: makeWorkspaceRoot('mm-sibling-'),
      swarm: makeSwarm(testnet.bootstrap),
      harnessSlug: siblingSlug,
      binding: topicBinding,
      bootExtra: {
        announceIdentityOverride: sibling.override,
        verifyBindingOverride: verifyFor(owner.userId, recv.userId),
        applyOverride: async () => true,
      },
    });

    // RECEIVER (under test): REAL boot apply → getOrgPg/orgDb. EMPTY roster, REAL
    // bootstrap-admit. pendingRetryMs>0 so the SIBLING (buffered at connect, membership
    // not-yet-federated) is re-admitted once the owner roster lands (the load-bearing
    // difference from the 2-peer repros).
    const recvPeer = await bootViaSidecarHost({
      workspaceId: wsId,
      root: makeWorkspaceRoot('mm-recv-'),
      swarm: makeSwarm(testnet.bootstrap),
      harnessSlug: recvSlug,
      binding: topicBinding,
      bootExtra: {
        announceIdentityOverride: recv.override,
        verifyBindingOverride: verifyFor(owner.userId, sibling.userId),
        pendingRetryMs: 250,
      },
    });

    expect(ownerPeer.handle.swarm, 'owner did not join a swarm').not.toBeNull();
    expect(siblingPeer.handle.swarm, 'sibling did not join a swarm').not.toBeNull();
    expect(recvPeer.handle.swarm, 'receiver did not join a swarm').not.toBeNull();
    expect(ownerPeer.handle.swarm!.topicHex).toBe(recvPeer.handle.swarm!.topicHex);
    expect(siblingPeer.handle.swarm!.topicHex).toBe(recvPeer.handle.swarm!.topicHex);

    // OWNER authors the 3-member ROSTER + its content feature → outbox → drain → owner log.
    await authorRosterRow(dbOwner.sql, hiveHome, wsId, owner);
    await authorRosterRow(dbOwner.sql, hiveHome, wsId, recv);
    await authorRosterRow(dbOwner.sql, hiveHome, wsId, sibling);
    await authorFeature(dbOwner.sql, hiveHome, 'F-owner', 'Owner feature', 6001);
    const ownerDrained = await drainOutboxOnce(ownerPeer.handle, dbOwner.sql);
    expect(ownerDrained, 'owner outbox (roster + feature) did not drain to its log').toBeGreaterThanOrEqual(4);

    // SIBLING authors its content feature → outbox → drain → sibling log.
    await authorFeature(dbSibling.sql, siblingSlug, 'F-sibling', 'Sibling feature', 7001);
    const siblingDrained = await drainOutboxOnce(siblingPeer.handle, dbSibling.sql);
    expect(siblingDrained, 'sibling outbox (feature) did not drain to its log').toBeGreaterThanOrEqual(1);

    // THE MULTI-MEMBER PROOF: merge until the receiver admits BOTH peers' logs and its
    // PG holds BOTH the owner's and the sibling's feature at origin='remote'.
    const result = await pollUntil(
      async () => {
        await Promise.all([ownerPeer.mergeNow(), siblingPeer.mergeNow(), recvPeer.mergeNow()]);
        const ownerFeature = await readFeature(orgDb.adminSql, hiveHome, 'F-owner');
        const siblingFeature = await readFeature(orgDb.adminSql, siblingSlug, 'F-sibling');
        return ownerFeature && siblingFeature ? { ownerFeature, siblingFeature } : undefined;
      },
      { timeoutMs: 60_000, intervalMs: 300 },
    );

    return {
      ownerFeature: result?.ownerFeature ?? (await readFeature(orgDb.adminSql, hiveHome, 'F-owner')),
      siblingFeature:
        result?.siblingFeature ?? (await readFeature(orgDb.adminSql, siblingSlug, 'F-sibling')),
      admittedOwner: recvPeer.handle.admitted.has(ownerPeer.handle.ownLog.keyHex),
      admittedSibling: recvPeer.handle.admitted.has(siblingPeer.handle.ownLog.keyHex),
    };
  }

  it(
    'MEMBER M1 (fresh, topic-bound) ends with BOTH the owner feature (O→M1) and the sibling M2 feature (M2→M1, member↔member)',
    async () => {
      const wsId = 'ws-mm-recv-m1';
      const owner = makeIdentity('owner', 99, 'kc-owner');
      const m1 = makeIdentity('member1', 11, 'kc-m1');
      const m2 = makeIdentity('member2', 22, 'kc-m2');
      const r = await runMemberReceiver({
        wsId,
        hiveHome: 'mm1-owner-hive',
        recvSlug: 'mm1-member-1',
        siblingSlug: 'mm1-member-2',
        recv: m1,
        sibling: m2,
        owner,
      });
      expect(r.admittedOwner, "M1 never admitted the OWNER's log (bootstrap-admit broke)").toBe(true);
      expect(
        r.admittedSibling,
        "M1 never admitted the SIBLING M2's log — member↔member admission broke (sibling never re-admitted after the roster federated)",
      ).toBe(true);
      expect(r.ownerFeature, 'O→M1: the owner feature never reached M1 PG').toMatchObject({
        feature_id: 'F-owner',
        title: 'Owner feature',
        origin: 'remote',
      });
      expect(
        r.siblingFeature,
        'M2→M1 (member↔member): the sibling feature never reached M1 PG — only the owner content fanned out',
      ).toMatchObject({ feature_id: 'F-sibling', title: 'Sibling feature', origin: 'remote' });
    },
    180_000,
  );

  it(
    'MEMBER M2 (fresh, topic-bound) ends with BOTH the owner feature (O→M2) and the sibling M1 feature (M1→M2, member↔member)',
    async () => {
      const wsId = 'ws-mm-recv-m2';
      const owner = makeIdentity('owner', 99, 'kc-owner');
      const m1 = makeIdentity('member1', 11, 'kc-m1');
      const m2 = makeIdentity('member2', 22, 'kc-m2');
      const r = await runMemberReceiver({
        wsId,
        hiveHome: 'mm2-owner-hive',
        recvSlug: 'mm2-member-2',
        siblingSlug: 'mm2-member-1',
        recv: m2,
        sibling: m1,
        owner,
      });
      expect(r.admittedOwner, "M2 never admitted the OWNER's log (bootstrap-admit broke)").toBe(true);
      expect(
        r.admittedSibling,
        "M2 never admitted the SIBLING M1's log — member↔member admission broke",
      ).toBe(true);
      expect(r.ownerFeature, 'O→M2: the owner feature never reached M2 PG').toMatchObject({
        feature_id: 'F-owner',
        title: 'Owner feature',
        origin: 'remote',
      });
      expect(
        r.siblingFeature,
        'M1→M2 (member↔member): the sibling feature never reached M2 PG',
      ).toMatchObject({ feature_id: 'F-sibling', title: 'Sibling feature', origin: 'remote' });
    },
    180_000,
  );

  it(
    'OWNER O ends with BOTH members’ features (M1→O AND M2→O) via the owner-home content-guard fallback',
    async () => {
      const wsId = 'ws-mm-recv-owner';
      const hiveHome = 'mmo-owner-hive';
      const m1Slug = 'mmo-member-1';
      const m2Slug = 'mmo-member-2';
      const owner = makeIdentity('owner', 99, 'kc-owner');
      const m1 = makeIdentity('member1', 11, 'kc-m1');
      const m2 = makeIdentity('member2', 22, 'kc-m2');

      const orgDb: OrgTestDb = await createOrgTestDb();
      cleanups.push(() => orgDb.cleanup());
      installEnv(orgDb, wsId);

      const { publicKey: hivePub } = generateKeyPairSync('ed25519');
      const hivePubkeyB64 = rawPubkeyBase64(hivePub);

      // OWNER's PG already HOLDS its roster (it created the hive) — seed all three rows +
      // the hives row + the directory-cache owner binding directly.
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
      for (const id of [owner, m1, m2]) await seedRosterRow(orgDb.adminSql, hiveHome, wsId, id);

      // Registry: HIVE_HOME is the OWNER's own home (NOT a remote_hive view); the members join it.
      await mutateHarnessRegistry(
        (r) => ({
          ...r,
          projects: [
            ...r.projects,
            { slug: hiveHome, path: '/tmp/mmo-owner', harness_kind: 'hive' },
            { slug: m1Slug, path: '/tmp/mmo-m1', hive_slug: hiveHome },
            { slug: m2Slug, path: '/tmp/mmo-m2', hive_slug: hiveHome },
          ],
        }),
        wsId,
      );

      const { potHomeSlugForHarness } = await import('../../../hive-federation');
      const { resolveHiveMemberDeviceSet } = await import('../hive-member-identity-set');
      expect(await potHomeSlugForHarness(wsId, hiveHome)).toBe(hiveHome);
      const set = await resolveHiveMemberDeviceSet(wsId, hiveHome);
      expect(set.has(m1.devicePubkey)).toBe(true);
      expect(set.has(m2.devicePubkey)).toBe(true);
      _clearHiveMemberDeviceSetCacheForTest();

      // Both members are AUTHORS on their own content DBs.
      const dbM1: FreshPgDb = await createFreshPgDb('mmoM1');
      cleanups.push(() => dbM1.cleanup());
      await setupAuthorSchema(dbM1.sql, m1Slug, wsId);
      const dbM2: FreshPgDb = await createFreshPgDb('mmoM2');
      cleanups.push(() => dbM2.cleanup());
      await setupAuthorSchema(dbM2.sql, m2Slug, wsId);

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

      // OWNER (RECEIVER under test): REAL boot apply → orgDb; owner-home content-guard
      // fallback (WI-559/FED-1) engages so cross-member ops materialize.
      const ownerPeer = await bootViaSidecarHost({
        workspaceId: wsId,
        root: makeWorkspaceRoot('mmo-owner-'),
        swarm: makeSwarm(testnet.bootstrap),
        harnessSlug: hiveHome,
        binding: hiveBinding,
        bootExtra: {
          announceIdentityOverride: owner.override,
          verifyBindingOverride: verifyFor(m1.userId, m2.userId),
          pendingRetryMs: 250,
        },
      });

      // M1 + M2 (AUTHORS): serve their logs; no-op apply.
      const m1Peer = await bootViaSidecarHost({
        workspaceId: wsId,
        root: makeWorkspaceRoot('mmo-m1-'),
        swarm: makeSwarm(testnet.bootstrap),
        harnessSlug: m1Slug,
        binding: topicBinding,
        bootExtra: {
          announceIdentityOverride: m1.override,
          verifyBindingOverride: verifyFor(owner.userId, m2.userId),
          applyOverride: async () => true,
        },
      });
      const m2Peer = await bootViaSidecarHost({
        workspaceId: wsId,
        root: makeWorkspaceRoot('mmo-m2-'),
        swarm: makeSwarm(testnet.bootstrap),
        harnessSlug: m2Slug,
        binding: topicBinding,
        bootExtra: {
          announceIdentityOverride: m2.override,
          verifyBindingOverride: verifyFor(owner.userId, m1.userId),
          applyOverride: async () => true,
        },
      });

      expect(ownerPeer.handle.swarm).not.toBeNull();
      expect(m1Peer.handle.swarm).not.toBeNull();
      expect(m2Peer.handle.swarm).not.toBeNull();
      expect(ownerPeer.handle.swarm!.topicHex).toBe(m1Peer.handle.swarm!.topicHex);
      expect(ownerPeer.handle.swarm!.topicHex).toBe(m2Peer.handle.swarm!.topicHex);

      await authorFeature(dbM1.sql, m1Slug, 'F-m1', 'Member1 feature', 7101);
      expect(await drainOutboxOnce(m1Peer.handle, dbM1.sql)).toBeGreaterThanOrEqual(1);
      await authorFeature(dbM2.sql, m2Slug, 'F-m2', 'Member2 feature', 7201);
      expect(await drainOutboxOnce(m2Peer.handle, dbM2.sql)).toBeGreaterThanOrEqual(1);

      const result = await pollUntil(
        async () => {
          await Promise.all([ownerPeer.mergeNow(), m1Peer.mergeNow(), m2Peer.mergeNow()]);
          const f1 = await readFeature(orgDb.adminSql, m1Slug, 'F-m1');
          const f2 = await readFeature(orgDb.adminSql, m2Slug, 'F-m2');
          return f1 && f2 ? { f1, f2 } : undefined;
        },
        { timeoutMs: 60_000, intervalMs: 300 },
      );

      expect(
        ownerPeer.handle.admitted.has(m1Peer.handle.ownLog.keyHex),
        "the OWNER never admitted M1's log",
      ).toBe(true);
      expect(
        ownerPeer.handle.admitted.has(m2Peer.handle.ownLog.keyHex),
        "the OWNER never admitted M2's log",
      ).toBe(true);
      expect(result?.f1, 'M1→O: member 1 feature never reached the OWNER PG').toMatchObject({
        feature_id: 'F-m1',
        title: 'Member1 feature',
        origin: 'remote',
      });
      expect(result?.f2, 'M2→O: member 2 feature never reached the OWNER PG').toMatchObject({
        feature_id: 'F-m2',
        title: 'Member2 feature',
        origin: 'remote',
      });
    },
    180_000,
  );
});
