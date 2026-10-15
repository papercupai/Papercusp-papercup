/**
 * federation-concurrent-writes-sidecar.repro.integration.test.ts
 *
 * Plan: shared-hive-member-content-federation-2026-06-20 (D-053, D-054).
 *
 * ## THE NEW DIMENSION (CONCURRENT BIDIRECTIONAL writes — no prior sidecar repro covers it)
 * Every faithful sidecar repro to date proves ONE-DIRECTION federation (an AUTHOR
 * serves its log; a RECEIVER applies it) — bootstrap-admit, content-matrix,
 * multimember, reconnect-catchup. NONE exercises the case where BOTH peers author
 * AND receive CONCURRENTLY and the merge must CONVERGE conflict-free:
 *   1. two peers author DIFFERENT keys ~simultaneously → after a bidirectional merge
 *      BOTH peers hold BOTH items (the other peer's at origin='remote'), no loss; and
 *   2. two peers author the SAME key concurrently → the PG-level LWW guard
 *      (EI-79/D-001: order by `fed_hlc`, fall back to `fed_ts`) must resolve to the
 *      SAME deterministic winner on BOTH peers — no split-brain, no duplicate row.
 *
 * ## TOPOLOGY — two devices/peers of ONE hive-home harness (where same-key races occur)
 * A same-(slug,key) conflict can ONLY arise between two peers that share the harness
 * slug: the CDC drain federates a row only from the peer whose `handle.harnessSlug`
 * equals the row's `harness_slug` (drain filter), and a remote-origin row never
 * re-captures (echo guard). So the realistic concurrent-same-key topology is TWO
 * DEVICES of the SAME hive-home harness (two admins / two machines of the home),
 * both VERIFIED members, both authoring the shared home backlog. Both boot
 * `harnessSlug = HIVE_HOME` on the hive binding and admit each other via the REAL
 * member-set admission (D-002: admit a log iff its announce device ∈ the hive's
 * federated `pot_members`) — NO membership/admission LOGIC is stubbed.
 * `verifyBindingOverride` stands in ONLY for the unreachable GitHub gist-attestation
 * I/O (the same infra stub every faithful sidecar repro uses).
 *
 * ## FAITHFUL HLC (why each peer gets a FULLY MIGRATED PG, not the hand-rolled DDL)
 * Convergence under same-key conflict is decided by the mig-314 ordering key: a LOCAL
 * write's PG row carries `fed_hlc` ONLY because the `stamp_local_federated_write`
 * BEFORE trigger stamps `hlc_now()` on it; the CDC capture threads that HLC onto the
 * wire op; the remote peer's projection writes the SAME `fed_hlc`; the LWW guard
 * orders by it. The hand-rolled `_work-items-schema` test DDL has NEITHER the stamp
 * trigger NOR the hlc clock, so a local row would carry `fed_hlc = NULL` and ANY
 * remote op would clobber it — a TEST ARTIFACT that would falsely "diverge". To test
 * convergence FAITHFULLY each peer runs a FULLY MIGRATED Postgres (createOrgTestDb →
 * the real `stamp_local_federated_write` + `hlc_now`/`hlc_recv` + the work_items CDC
 * capture), EXACTLY the production write path.
 *
 * Each peer is its OWN process (a dedicated substrate sidecar HOST via
 * createSubstrateSidecarHost → bootHarnessSubstrate → real testnet-DHT swarm /
 * announce / admission / merge) AND its OWN HLC clock (boot `hlcClock` send seam +
 * the apply `hlcClock` recv seam) — real peers are separate processes with
 * independent clocks, so a shared process clock would decide cross-peer LWW by
 * drain-race instead of causal order (hlc-stamp.ts).
 *
 * RUN (real testcontainer PG; Docker-gated `.integration` → the integration config):
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/sync/hyperbee/__tests__/federation-concurrent-writes-sidecar.repro.integration.test.ts
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { HlcClock, compareHlc, decodeHlc } from '@papercusp/locks-core';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import {
  bootHarnessSubstrate,
  type BootedHarnessHandle,
  type BootHarnessOpts,
} from '../boot';
import { type SwarmBinding } from '../derive-swarm-topic';
import {
  createSubstrateSidecarHost,
  type SubstrateSidecarHost,
} from '../substrate-sidecar-host';
import { type HyperswarmLike } from '../swarm';
import type { OpEnvelope } from '../op-envelope-types';
import type { PeerLogOp } from '../peer-log';
import type { AdmittedLog } from '../read-merge';
import { _resetBootHistoryForTests } from '../boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';
import { drainOutboxOnce } from '../outbox-drain';
import { applyOpVia, type ProjectionLookup, type TableProjection } from '../projection';
import { buildHarnessFeaturesProjection } from '../projections/harness-features';
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
import { _clearHiveMemberDeviceSetCacheForTest } from '../hive-member-identity-set';

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

/** env-route getOrgPg at a migrated org DB (peer A's PG view + the workspace-shared
 *  pot_members / hives / directory-cache the REAL admission reads). */
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

/** Seed a pot_members roster row DIRECTLY in a (migrated) DB. */
async function seedRosterRow(sql: postgres.Sql, hiveHome: string, workspaceId: string, id: Identity): Promise<void> {
  await sql`
    INSERT INTO harness_shared.pot_members
      (workspace_id, pot_home_slug, github_user_id, github_username, device_attestations, revoked_pubkeys, binding_status)
    VALUES (${workspaceId}, ${hiveHome}, ${id.userId}, ${id.login},
            ${memberAtt(id.login, id.devicePubkey)}::text::jsonb, '{}'::text[], 'verified')
  `;
}

/**
 * A peer's throwaway projection apply over its OWN migrated content DB — the REAL
 * harness-features projection (membership-aware guard + the EI-79/D-001 LWW PG guard).
 * `ownLogKeyHex` is the source-log identity that makes the peer SKIP its own ops
 * (skipOwnOps) + stamp the OTHER peer's ops origin='remote'; `clock` is the peer's
 * independent HLC clock for the apply RECV seam (observeRemoteHlc).
 */
function buildPeerApply(
  sql: postgres.Sql,
  workspaceId: string,
  harnessSlug: string,
  ownLogKeyHex: string,
  clock: HlcClock,
): (op: OpEnvelope) => Promise<boolean> {
  const proj = buildHarnessFeaturesProjection({ workspaceId, harnessSlug, sql });
  const scoped = new Map<string, TableProjection<unknown>>([[proj.tableTag, proj as TableProjection<unknown>]]);
  const lookup: ProjectionLookup = (tag) => scoped.get(tag) ?? null;
  return (op: OpEnvelope) => applyOpVia(lookup, op, { ownLogKeyHex, hlcClock: clock });
}

/** Author one feature under `slug` via a direct local INSERT (origin defaults to
 *  'local' → the mig-314 stamp trigger stamps fed_ts + fed_hlc; the CDC capture
 *  enqueues it to substrate_outbox). Insert through the hfc VIEW (the post-374
 *  auto-updatable compat view over work_items) so the base triggers fire. */
async function authorFeature(
  sql: postgres.Sql,
  workspaceId: string,
  slug: string,
  featureId: string,
  title: string,
  status: string,
  ts: number,
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, title, summary, status, attempts, item_kind, ts, created_ts, updated_ts)
    VALUES (${workspaceId}, ${slug}, ${featureId}, ${title}, 'fed', ${status}, 0, 'feature', ${ts}, ${ts}, ${ts})
  `;
}

/** Update an EXISTING feature's status locally (re-fires the stamp trigger → a NEW
 *  fed_hlc/fed_ts + origin='local' → re-captured to the outbox). */
async function updateFeatureStatus(
  sql: postgres.Sql,
  slug: string,
  featureId: string,
  status: string,
): Promise<void> {
  await sql`
    UPDATE harness_shared.harness_features_consolidated
       SET status = ${status}
     WHERE harness_slug = ${slug} AND feature_id = ${featureId}
  `;
}

interface SeenFeature {
  feature_id: string;
  title: string | null;
  status: string | null;
  origin: string;
  fed_hlc: string | null;
  fed_ts: string | null;
}

async function readFeature(sql: postgres.Sql, slug: string, featureId: string): Promise<SeenFeature | undefined> {
  const rows = await sql<SeenFeature[]>`
    SELECT feature_id, title, status, origin, fed_hlc, fed_ts
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${slug} AND feature_id = ${featureId}
  `;
  return rows[0];
}

async function countFeature(sql: postgres.Sql, slug: string, featureId: string): Promise<number> {
  const rows = await sql<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${slug} AND feature_id = ${featureId}
  `;
  return Number(rows[0]?.n ?? 0);
}

type CaptureDisposition = 'present' | 'absent' | 'unknown';

interface CapturedPeerLog {
  disposition: CaptureDisposition;
  sourceLogKey: string | null;
  scannedOps: number;
  matchingOp?: PeerLogOp;
  reason?: string;
}

interface ConcurrentLwwCapture {
  finalRows: { a: SeenFeature | null; b: SeenFeature | null };
  incoming: { bOnA: CapturedPeerLog; aOnB: CapturedPeerLog };
  /** The real boot path exposes only aggregate merge counts, not per-op apply outcomes. */
  directApplyDisposition: 'unknown';
}

const CAPTURE_GET_TIMEOUT_MS = 250;
const CAPTURE_MAX_LOG_OPS = 10_000;
const FEATURE_LOG_TABLES = new Set(['features-by-id', 'features_consolidated', 'harness_features_consolidated']);

type BoundedResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'timeout' | 'error' };

async function settleBounded<T>(work: Promise<T>, timeoutMs: number): Promise<BoundedResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BoundedResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs);
  });
  try {
    return await Promise.race([
      work.then((value) => ({ ok: true as const, value }), () => ({ ok: false as const, reason: 'error' as const })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read one peer log conservatively for a feature key. A missing log, failed refresh,
 * timed-out block, or truncated scan is `unknown`, never `absent`; only a complete
 * bounded scan with no matching op establishes absence.
 */
async function scanAdmittedLogForFeature(
  log: AdmittedLog | undefined,
  featureId: string,
): Promise<CapturedPeerLog> {
  if (!log) {
    return {
      disposition: 'unknown',
      sourceLogKey: null,
      scannedOps: 0,
      reason: 'source-log-not-admitted',
    };
  }

  const refreshable = log as AdmittedLog & { update?: () => Promise<void> };
  if (refreshable.update) {
    const refreshed = await settleBounded(Promise.resolve().then(() => refreshable.update!()), CAPTURE_GET_TIMEOUT_MS);
    if (!refreshed.ok) {
      return {
        disposition: 'unknown',
        sourceLogKey: log.keyHex,
        scannedOps: 0,
        reason: `log-refresh-${refreshed.reason}`,
      };
    }
  }

  let length: number;
  try {
    length = Math.max(0, log.length);
  } catch {
    return {
      disposition: 'unknown',
      sourceLogKey: log.keyHex,
      scannedOps: 0,
      reason: 'log-length-error',
    };
  }

  const scanLength = Math.min(length, CAPTURE_MAX_LOG_OPS);
  for (let index = 0; index < scanLength; index += 1) {
    const read = await settleBounded(
      Promise.resolve().then(() => log.get(index)),
      CAPTURE_GET_TIMEOUT_MS,
    );
    if (!read.ok) {
      return {
        disposition: 'unknown',
        sourceLogKey: log.keyHex,
        scannedOps: index,
        reason: `op-${index}-${read.reason}`,
      };
    }
    const op = read.value;
    if (op && op.hbKey === featureId && FEATURE_LOG_TABLES.has(op.table)) {
      return {
        disposition: 'present',
        sourceLogKey: log.keyHex,
        scannedOps: index + 1,
        matchingOp: op,
      };
    }
  }

  return {
    disposition: length > scanLength ? 'unknown' : 'absent',
    sourceLogKey: log.keyHex,
    scannedOps: scanLength,
    ...(length > scanLength ? { reason: `scan-cap-${CAPTURE_MAX_LOG_OPS}` } : {}),
  };
}

/** Capture failure-time evidence without claiming whether the projection guard applied an op. */
async function captureConcurrentLwwState(args: {
  dbA: postgres.Sql;
  dbB: postgres.Sql;
  peerA: PeerControl;
  peerB: PeerControl;
  harnessSlug: string;
  featureId: string;
}): Promise<ConcurrentLwwCapture> {
  const [finalA, finalB, bOnA, aOnB] = await Promise.all([
    readFeature(args.dbA, args.harnessSlug, args.featureId),
    readFeature(args.dbB, args.harnessSlug, args.featureId),
    scanAdmittedLogForFeature(
      args.peerA.handle.admitted.get(args.peerB.handle.ownLog.keyHex),
      args.featureId,
    ),
    scanAdmittedLogForFeature(
      args.peerB.handle.admitted.get(args.peerA.handle.ownLog.keyHex),
      args.featureId,
    ),
  ]);
  return {
    finalRows: { a: finalA ?? null, b: finalB ?? null },
    incoming: { bOnA, aOnB },
    directApplyDisposition: 'unknown',
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Migration 813 moved the causal frontier to a sequence; the row retains node identity. */
async function pinHlcFrontier(
  sql: postgres.Sql,
  ms: number,
  count: number,
  nodeId: string,
): Promise<void> {
  const packed = (BigInt(ms) * 65_536n + BigInt(count)).toString();
  await sql`UPDATE harness_shared.hlc_clock SET node_id = ${nodeId} WHERE id = 1`;
  await sql`SELECT pg_catalog.setval('harness_shared.hlc_packed_seq'::regclass, ${packed}::bigint, true)`;
  const [frontier] = await sql`SELECT last_value::text AS packed FROM harness_shared.hlc_packed_seq`;
  expect(frontier.packed, 'the production sequence frontier pin did not land').toBe(packed);
}

/**
 * Boot the two-device hive-home topology used by both `it` blocks: deviceA + deviceB,
 * both VERIFIED members of HIVE_HOME, each on its OWN migrated content DB + OWN HLC
 * clock + OWN sidecar host, mutually admitting via the real member-set admission.
 * Returns each peer's control handle, content sql, and device identity.
 */
async function bootTwoDeviceHive(wsId: string, hiveHome: string): Promise<{
  dbA: OrgTestDb;
  dbB: OrgTestDb;
  peerA: PeerControl;
  peerB: PeerControl;
  applyB: (op: OpEnvelope) => Promise<boolean>;
  clockA: HlcClock;
  clockB: HlcClock;
  idA: Identity;
  idB: Identity;
}> {
  // dbA is env-routed (getOrgPg) → it holds the workspace-shared membership/identity
  // the REAL admission reads AND is peer A's content DB (peer A applies via the REAL
  // boot apply seam → getOrgPg). dbB is peer B's content DB (applied via applyOverride).
  const dbA: OrgTestDb = await createOrgTestDb();
  cleanups.push(() => dbA.cleanup());
  const dbB: OrgTestDb = await createOrgTestDb();
  cleanups.push(() => dbB.cleanup());
  installEnv(dbA, wsId);

  const idA = makeIdentity('alice', 99, 'kc-alice');
  const idB = makeIdentity('bob', 7, 'kc-bob');

  const { publicKey: hivePub } = generateKeyPairSync('ed25519');
  const hivePubkeyB64 = rawPubkeyBase64(hivePub);

  // dbA (the membership source): hives row + directory-cache owner binding +
  // BOTH devices as verified members → the real member-set admission admits each
  // peer's log on the other. (No membership LOGIC stubbed.)
  await dbA.adminSql`
    INSERT INTO harness_shared.pots
      (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
    VALUES (${wsId}, ${hiveHome}, decode(${hivePubkeyB64}, 'base64'), 'kc-home', 'Home', null, 1, 1)
  `;
  await dbA.adminSql`
    INSERT INTO harness_shared.pot_directory_cache (workspace_id, payload, updated_at)
    VALUES (${wsId}, ${JSON.stringify({
      hives: [{ hivePubkey: hivePubkeyB64, ownerDevicePubkey: idA.devicePubkey }],
    })}::text::jsonb, 1)
  `;
  await seedRosterRow(dbA.adminSql, hiveHome, wsId, idA);
  await seedRosterRow(dbA.adminSql, hiveHome, wsId, idB);

  // Registry: HIVE_HOME is the hive's own home harness (both peers run it).
  await mutateHarnessRegistry(
    (r) => ({
      ...r,
      projects: [...r.projects, { slug: hiveHome, path: '/tmp/cw-home', harness_kind: 'hive' }],
    }),
    wsId,
  );

  const { resolveHiveMemberDeviceSet } = await import('../hive-member-identity-set');
  const set = await resolveHiveMemberDeviceSet(wsId, hiveHome);
  expect(set.has(idA.devicePubkey)).toBe(true);
  expect(set.has(idB.devicePubkey)).toBe(true);
  _clearHiveMemberDeviceSetCacheForTest();

  const testnet = await createTestnet(3);
  cleanups.push(async () => {
    try {
      await testnet.destroy();
    } catch {
      /* ignore */
    }
  });

  const hiveBinding: SwarmBinding = { kind: 'hive', hive_pubkey: hivePubkeyB64 };
  // Independent per-peer HLC clocks (real peers = separate processes).
  const clockA = new HlcClock();
  const clockB = new HlcClock();

  // PEER A: the REAL boot apply seam → getOrgPg/dbA (no applyOverride). Own SEND clock.
  const peerA = await bootViaSidecarHost({
    workspaceId: wsId,
    root: makeWorkspaceRoot('cw-a-'),
    swarm: makeSwarm(testnet.bootstrap),
    harnessSlug: hiveHome,
    binding: hiveBinding,
    bootExtra: {
      announceIdentityOverride: idA.override,
      verifyBindingOverride: verifyFor(idB.userId),
      hlcClock: clockA,
    },
  });

  // PEER B: applies the REAL harness-features projection over its OWN DB (dbB) via
  // applyOverride; SEND + RECV both on clock B (fully independent peer).
  let applyB: ((op: OpEnvelope) => Promise<boolean>) | undefined;
  const peerB = await bootViaSidecarHost({
    workspaceId: wsId,
    root: makeWorkspaceRoot('cw-b-'),
    swarm: makeSwarm(testnet.bootstrap),
    harnessSlug: hiveHome,
    binding: hiveBinding,
    bootExtra: {
      announceIdentityOverride: idB.override,
      verifyBindingOverride: verifyFor(idA.userId),
      hlcClock: clockB,
      applyOverride: (op, ctx) => {
        applyB ??= buildPeerApply(dbB.adminSql, wsId, hiveHome, ctx.ownLogKeyHex, clockB);
        return applyB(op);
      },
    },
  });

  expect(peerA.handle.swarm, 'peer A did not join a swarm').not.toBeNull();
  expect(peerB.handle.swarm, 'peer B did not join a swarm').not.toBeNull();
  expect(peerA.handle.swarm!.topicHex).toBe(peerB.handle.swarm!.topicHex);

  // Mutual admission must land before either side authors (so the first author's op
  // is replicated, not stranded behind a not-yet-admitted log).
  const mutuallyAdmitted = await pollUntil(
    async () => {
      await Promise.all([peerA.mergeNow(), peerB.mergeNow()]);
      const aAdmitsB = peerA.handle.admitted.has(peerB.handle.ownLog.keyHex);
      const bAdmitsA = peerB.handle.admitted.has(peerA.handle.ownLog.keyHex);
      return aAdmitsB && bAdmitsA ? true : undefined;
    },
    { timeoutMs: 30_000, intervalMs: 250 },
  );
  expect(mutuallyAdmitted, 'the two devices never mutually admitted (member-set admission broke)').toBe(true);

  return {
    dbA,
    dbB,
    peerA,
    peerB,
    applyB: (op) => {
      applyB ??= buildPeerApply(dbB.adminSql, wsId, hiveHome, peerB.handle.ownLog.keyHex, clockB);
      return applyB(op);
    },
    clockA,
    clockB,
    idA,
    idB,
  };
}

/** The PG-level LWW order the guard uses: by `fed_hlc` when both present, else `fed_ts`. */
function lwwGreater(
  a: { fed_hlc: string | null; fed_ts: string | null },
  b: { fed_hlc: string | null; fed_ts: string | null },
): 'a' | 'b' | 'tie' {
  if (a.fed_hlc && b.fed_hlc) {
    const c = compareHlc(decodeHlc(a.fed_hlc), decodeHlc(b.fed_hlc));
    return c > 0 ? 'a' : c < 0 ? 'b' : 'tie';
  }
  const at = Number(a.fed_ts ?? -Infinity);
  const bt = Number(b.fed_ts ?? -Infinity);
  return at > bt ? 'a' : at < bt ? 'b' : 'tie';
}

// ─────────────────────────────────── tests ───────────────────────────────────

describe('SIDECAR concurrent BIDIRECTIONAL writes — conflict-free convergence on ONE hive (two devices, real swarm + migrated PG, no membership stubs) — D-053/D-054', () => {
  it('preserves a real rebind warning while isolating the next database fixture', async () => {
    const first = await createOrgTestDb();
    cleanups.push(() => first.cleanup());
    const second = await createOrgTestDb();
    cleanups.push(() => second.cleanup());
    installEnv(first, 'ws-cw-pool-control');
    const routeTo = (database: OrgTestDb) => {
      process.env.HARNESS_ADMIN_DATABASE_URL = database.adminDsn;
      _resetUrlCacheForTests();
      _resetHarnessAdminUrlCacheForTests();
      _resetStoreIdentityForTests();
    };
    const label = 'pg-merge-cursor-store';
    resetFixturePoolState();
    const firstPool = getLongLivedAdminPool(label);
    cleanups.push(() => firstPool.end({ timeout: 1 }));
    expect((await firstPool`SELECT current_database() AS name`)[0].name).toBe(first.dbName);
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

  it('distinguishes the obsolete row frontier from the production sequence clock', async () => {
    const db = await createOrgTestDb();
    cleanups.push(() => db.cleanup());
    const ms = Date.now() + 300_000;
    const count = 500;
    const nodeId = 'aaaa1111aaaa1111';
    await db.adminSql`UPDATE harness_shared.hlc_clock
      SET last_ms = ${ms}, last_count = ${count}, node_id = ${nodeId} WHERE id = 1`;
    const [unpinned] = await db.adminSql`SELECT harness_shared.hlc_now() AS hlc`;
    expect(decodeHlc(unpinned.hlc).ms, 'legacy row must not govern the migrated clock').toBeLessThan(ms);

    await pinHlcFrontier(db.adminSql, ms, count, nodeId);
    const [pinned] = await db.adminSql`SELECT harness_shared.hlc_now() AS hlc`;
    expect(pinned.hlc).toBe(`${String(ms).padStart(15, '0')}:00501:${nodeId}`);
  });

  it('failure capture distinguishes a present op from a peer log that was not admitted', async () => {
    const op: PeerLogOp = {
      type: 'put',
      table: 'features-by-id',
      hbKey: 'F-capture',
      value: { status: 'status-a' },
      ts: 1,
      schema_version: 1,
      author_pubkey: 'author-a',
    };
    const log: AdmittedLog = {
      keyHex: 'a'.repeat(64),
      length: 1,
      get: async () => op,
    };

    await expect(scanAdmittedLogForFeature(log, 'F-capture')).resolves.toMatchObject({
      disposition: 'present',
      matchingOp: op,
    });
    await expect(scanAdmittedLogForFeature(undefined, 'F-capture')).resolves.toMatchObject({
      disposition: 'unknown',
      reason: 'source-log-not-admitted',
    });
  });

  it(
    'DIFFERENT keys authored ~simultaneously on both peers → after merge BOTH peers hold BOTH features (the other peer\'s at origin=remote), no loss',
    async () => {
      const wsId = 'ws-cw-diff';
      const hiveHome = 'cw-diff-home';
      const { dbA, dbB, peerA, peerB, idA, idB } = await bootTwoDeviceHive(wsId, hiveHome);
      void idA;
      void idB;

      // Both devices author DIFFERENT features ~simultaneously (NO merge between → causally
      // concurrent), each into its OWN content DB.
      await authorFeature(dbA.adminSql, wsId, hiveHome, 'F-alice', 'Alice feature', 'todo', 10_001);
      await authorFeature(dbB.adminSql, wsId, hiveHome, 'F-bob', 'Bob feature', 'todo', 10_002);
      expect(await drainOutboxOnce(peerA.handle, dbA.adminSql)).toBeGreaterThanOrEqual(1);
      expect(await drainOutboxOnce(peerB.handle, dbB.adminSql)).toBeGreaterThanOrEqual(1);

      // Bidirectional merge until BOTH peers hold BOTH features.
      const converged = await pollUntil(
        async () => {
          await Promise.all([peerA.mergeNow(), peerB.mergeNow()]);
          const aAlice = await readFeature(dbA.adminSql, hiveHome, 'F-alice');
          const aBob = await readFeature(dbA.adminSql, hiveHome, 'F-bob');
          const bAlice = await readFeature(dbB.adminSql, hiveHome, 'F-alice');
          const bBob = await readFeature(dbB.adminSql, hiveHome, 'F-bob');
          return aAlice && aBob && bAlice && bBob ? { aAlice, aBob, bAlice, bBob } : undefined;
        },
        { timeoutMs: 40_000, intervalMs: 300 },
      );
      expect(converged, 'the two peers never converged to holding BOTH features (a write was lost)').toBeTruthy();

      // No loss; each peer's OWN write is origin=local, the OTHER's is origin=remote.
      expect(converged!.aAlice).toMatchObject({ feature_id: 'F-alice', title: 'Alice feature', origin: 'local' });
      expect(converged!.aBob).toMatchObject({ feature_id: 'F-bob', title: 'Bob feature', origin: 'remote' });
      expect(converged!.bBob).toMatchObject({ feature_id: 'F-bob', title: 'Bob feature', origin: 'local' });
      expect(converged!.bAlice).toMatchObject({ feature_id: 'F-alice', title: 'Alice feature', origin: 'remote' });

      // Exactly one row per (slug, key) on each peer — no duplicate.
      expect(await countFeature(dbA.adminSql, hiveHome, 'F-alice')).toBe(1);
      expect(await countFeature(dbA.adminSql, hiveHome, 'F-bob')).toBe(1);
      expect(await countFeature(dbB.adminSql, hiveHome, 'F-alice')).toBe(1);
      expect(await countFeature(dbB.adminSql, hiveHome, 'F-bob')).toBe(1);
    },
    180_000,
  );

  it(
    'SAME key authored concurrently on both peers → the EI-79/D-001 LWW guard converges BOTH peers to the SAME deterministic winner (HLC-then-fed_ts), no split-brain, no dup row',
    async () => {
      const wsId = 'ws-cw-same';
      const hiveHome = 'cw-same-home';
      const FID = 'F-contested';
      const { dbA, dbB, peerA, peerB } = await bootTwoDeviceHive(wsId, hiveHome);

      // Both peers author the SAME (slug, feature_id) CONCURRENTLY with DIFFERENT content,
      // WITHOUT merging in between (causally concurrent). A deliberate gap makes peer B's
      // write strictly LATER → its mig-314 fed_hlc is strictly greater → a DETERMINISTIC
      // LWW winner (no reliance on a sub-ms race). The point: BOTH peers must agree on it.
      await authorFeature(dbA.adminSql, wsId, hiveHome, FID, 'Contested', 'status-A-early', 20_001);
      await sleep(40);
      await authorFeature(dbB.adminSql, wsId, hiveHome, FID, 'Contested', 'status-B-late', 20_002);

      const localA = await readFeature(dbA.adminSql, hiveHome, FID);
      const localB = await readFeature(dbB.adminSql, hiveHome, FID);
      expect(localA?.fed_hlc, 'peer A local row never got a fed_hlc (mig-314 stamp trigger missing?)').not.toBeNull();
      expect(localB?.fed_hlc, 'peer B local row never got a fed_hlc (mig-314 stamp trigger missing?)').not.toBeNull();
      // The deterministic winner by the SAME order the PG guard uses (HLC then fed_ts).
      const winnerSide = lwwGreater(localA!, localB!);
      expect(winnerSide, 'the two local writes tied on HLC+fed_ts — make the gap larger').not.toBe('tie');
      const winnerStatus = winnerSide === 'a' ? 'status-A-early' : 'status-B-late';
       
      console.log(
        `[concurrent-same-key] A.fed_hlc=${localA!.fed_hlc} A.fed_ts=${localA!.fed_ts} | ` +
          `B.fed_hlc=${localB!.fed_hlc} B.fed_ts=${localB!.fed_ts} → winner=${winnerSide} (${winnerStatus})`,
      );

      expect(await drainOutboxOnce(peerA.handle, dbA.adminSql)).toBeGreaterThanOrEqual(1);
      expect(await drainOutboxOnce(peerB.handle, dbB.adminSql)).toBeGreaterThanOrEqual(1);

      // Bidirectional merge until BOTH peers' row carries the winning status.
      const converged = await pollUntil(
        async () => {
          await Promise.all([peerA.mergeNow(), peerB.mergeNow()]);
          const a = await readFeature(dbA.adminSql, hiveHome, FID);
          const b = await readFeature(dbB.adminSql, hiveHome, FID);
          return a?.status === winnerStatus && b?.status === winnerStatus ? { a, b } : undefined;
        },
        { timeoutMs: 40_000, intervalMs: 300 },
      );
      let capture: ConcurrentLwwCapture | undefined;
      if (!converged) {
        capture = await captureConcurrentLwwState({
          dbA: dbA.adminSql,
          dbB: dbB.adminSql,
          peerA,
          peerB,
          harnessSlug: hiveHome,
          featureId: FID,
        });
      }
      expect(
        converged,
        'the two peers did NOT converge to the same LWW winner (split-brain: each kept its own concurrent write)' +
          (capture ? `; failure capture=${JSON.stringify(capture)}` : ''),
      ).toBeTruthy();

      // CONVERGENCE: identical value on BOTH peers, and the LWW winner is the higher-HLC writer.
      expect(converged!.a.status).toBe(winnerStatus);
      expect(converged!.b.status).toBe(winnerStatus);

      // No duplicate row from the concurrent same-key insert (PK (harness_slug, feature_id)).
      expect(await countFeature(dbA.adminSql, hiveHome, FID)).toBe(1);
      expect(await countFeature(dbB.adminSql, hiveHome, FID)).toBe(1);

      // STRONG CRDT property: both peers converge to the IDENTICAL ordering key (fed_hlc),
      // not just the same value — so a SUBSEQUENT concurrent write resolves identically on
      // both. (This is the D-001 invariant: the wire op carries the author's fed_hlc, so the
      // remote peer materialises the SAME fed_hlc the author's local row holds.)
       
      console.log(
        `[concurrent-same-key] converged A.fed_hlc=${converged!.a.fed_hlc} B.fed_hlc=${converged!.b.fed_hlc}`,
      );
      expect(
        converged!.a.fed_hlc,
        'peers converged on VALUE but their fed_hlc ordering keys DIVERGE — a later concurrent write could re-split-brain',
      ).toBe(converged!.b.fed_hlc);
    },
    180_000,
  );

  it(
    'WI-1672 FORCED EXACT (ms,count) TIE — two peers pinned to the IDENTICAL HLC frontier ' +
      '(the post-clock-ratchet lockstep amplifier) author the SAME key concurrently: mig-459\'s ' +
      "node-id segment still resolves ONE deterministic winner on BOTH peers — where a pre-fix " +
      'fed_hlc STRING would have been a literal tie and the `>=` guard would accept the incoming ' +
      'remote op on both sides (stable split-brain, the S0 this migration closes)',
    async () => {
      const wsId = 'ws-cw-tie';
      const hiveHome = 'cw-tie-home';
      const FID = 'F-tied';
      const { dbA, dbB, peerA, peerB } = await bootTwoDeviceHive(wsId, hiveHome);

      // Pin BOTH peers' INDEPENDENT PG sequence frontiers to the IDENTICAL
      // (ms, count) frontier — ms set far into the future so
      // hlc_now()'s wall-clock ratchet is inactive on both regardless of any wall-
      // clock jitter between the two author() calls below. This reproduces the
      // WI-1672 AMPLIFIER deterministically instead of racing a real clock: "one
      // peer with a briefly-fast clock (or any past skew episode) pins ALL peers'
      // HLC wall components to that high-water mark ... after which every peer
      // advances by logical counter only, in near-lockstep."
      //
      // node_id is pinned EXPLICITLY too (rather than trusting each DB's mig-459
      // self-seed to differ): two `createOrgTestDb()` migrations run back-to-back
      // against the SAME throwaway testcontainer Postgres were OBSERVED to self-seed
      // the IDENTICAL node_id from plain SQL `random()` — see the follow-up hardening
      // mig 466 (hlc-node-id-strong-entropy), which moves the self-seed to pgcrypto's
      // gen_random_bytes(). This test's OWN job is narrower: prove the ORDERING
      // mechanism (fed_order_key / compareHlc) resolves a tie correctly whenever the
      // two nodes genuinely differ — which every real pair of devices' independently
      // (and, after mig 466, strongly) seeded node_id will.
      const pinnedMs = Date.now() + 600_000;
      const pinnedCount = 500;
      const nodeA = 'aaaa1111aaaa1111';
      const nodeB = 'bbbb2222bbbb2222';
      await pinHlcFrontier(dbA.adminSql, pinnedMs, pinnedCount, nodeA);
      await pinHlcFrontier(dbB.adminSql, pinnedMs, pinnedCount, nodeB);

      // Sanity: the node_id column exists (mig 459) and the pin actually landed.
      const [{ node_id: seenA }] = await dbA.adminSql<Array<{ node_id: string | null }>>`
        SELECT node_id FROM harness_shared.hlc_clock WHERE id = 1
      `;
      const [{ node_id: seenB }] = await dbB.adminSql<Array<{ node_id: string | null }>>`
        SELECT node_id FROM harness_shared.hlc_clock WHERE id = 1
      `;
      expect(seenA, 'the node_id pin did not take on peer A (mig 459 column missing/reverted?)').toBe(nodeA);
      expect(seenB, 'the node_id pin did not take on peer B (mig 459 column missing/reverted?)').toBe(nodeB);

      // Both peers author the SAME key CONCURRENTLY (no merge in between): each DB's
      // BEFORE stamp trigger calls its OWN hlc_now(), independently landing on the
      // SAME pinned (ms, count) — a genuine (ms,count) tie, by construction, not a race.
      await authorFeature(dbA.adminSql, wsId, hiveHome, FID, 'Contested', 'status-A', 30_001);
      await authorFeature(dbB.adminSql, wsId, hiveHome, FID, 'Contested', 'status-B', 30_002);

      const localA = await readFeature(dbA.adminSql, hiveHome, FID);
      const localB = await readFeature(dbB.adminSql, hiveHome, FID);
      expect(localA?.fed_hlc, 'peer A local row never got a fed_hlc').toBeTruthy();
      expect(localB?.fed_hlc, 'peer B local row never got a fed_hlc').toBeTruthy();

      // The (ms,count) PREFIX — the pre-WI-1672 ordering key — is IDENTICAL: this
      // really is the split-brain-triggering tie, not an ordinary timing race.
      const msCountPrefix = (hlc: string) => hlc.split(':').slice(0, 2).join(':');
      expect(
        msCountPrefix(localA!.fed_hlc!),
        'the (ms,count) prefixes differ — the clock pin failed to force a genuine tie',
      ).toBe(msCountPrefix(localB!.fed_hlc!));
      // Yet the FULL fed_hlc (incl. node segment) differs — construction breaks the tie.
      expect(
        localA!.fed_hlc,
        "the node segment did not distinguish the two peers' identical (ms,count) stamps",
      ).not.toBe(localB!.fed_hlc);

      // The node-aware compareHlc (== the SQL fed_order_key TEXT compare the PG guard
      // uses) gives ONE deterministic winner — never 'tie' — on an (ms,count)-tied pair.
      const winnerSide = lwwGreater(localA!, localB!);
      expect(
        winnerSide,
        'compareHlc/fed_order_key reported a TIE on an (ms,count)-identical pair — the WI-1672 bug is back',
      ).not.toBe('tie');
      const winnerStatus = winnerSide === 'a' ? 'status-A' : 'status-B';

      expect(await drainOutboxOnce(peerA.handle, dbA.adminSql)).toBeGreaterThanOrEqual(1);
      expect(await drainOutboxOnce(peerB.handle, dbB.adminSql)).toBeGreaterThanOrEqual(1);

      // Bidirectional merge until BOTH peers land on the SAME winner. Pre-mig-459 this
      // is exactly where split-brain occurred: the `>=` guard ACCEPTS on a tie, so each
      // peer's incoming remote op overwrote its own local row on BOTH sides — the two
      // peers stably SWAPPED winners instead of converging.
      const converged = await pollUntil(
        async () => {
          await Promise.all([peerA.mergeNow(), peerB.mergeNow()]);
          const a = await readFeature(dbA.adminSql, hiveHome, FID);
          const b = await readFeature(dbB.adminSql, hiveHome, FID);
          return a?.status === winnerStatus && b?.status === winnerStatus ? { a, b } : undefined;
        },
        { timeoutMs: 40_000, intervalMs: 300 },
      );
      expect(
        converged,
        'the two peers did NOT converge on an exact (ms,count) tie — split-brain reproduced (WI-1672 regression)',
      ).toBeTruthy();

      expect(converged!.a.status).toBe(winnerStatus);
      expect(converged!.b.status).toBe(winnerStatus);
      expect(
        converged!.a.fed_hlc,
        'peers converged on VALUE but their fed_hlc ordering keys still diverge',
      ).toBe(converged!.b.fed_hlc);

      // No duplicate row survives the tied concurrent insert.
      expect(await countFeature(dbA.adminSql, hiveHome, FID)).toBe(1);
      expect(await countFeature(dbB.adminSql, hiveHome, FID)).toBe(1);
    },
    180_000,
  );
});
