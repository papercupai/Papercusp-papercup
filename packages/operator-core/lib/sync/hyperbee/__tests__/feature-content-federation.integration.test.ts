/**
 * feature-content-federation.integration.test.ts — Stage 6 of the feature-content
 * federation plan (papercusp-feature-content-federation-2026-06-01): the
 * END-TO-END ACCEPTANCE that proves a feature/issue written on one peer actually
 * lands in ANOTHER peer's Postgres, through the REAL CDC-outbox send-side.
 *
 * ## What this proves (the whole send→swarm→receive→PG chain, no shortcuts)
 * For peer A → peer B, the test exercises EVERY link the plan built (Stages 1-5):
 *
 *   1. A local `INSERT … origin='local'` into A's `harness_features_consolidated`
 *      fires the REAL migration-102 AFTER trigger →
 *   2. a `harness_shared.substrate_outbox` row in A's DB →
 *   3. `drainOutboxOnce(handleA, pgA)` maps it (`outboxRowToLocalWriteOp`) and
 *      `handle.append`s it to A's OWN Hypercore log →
 *   4. the REAL in-process Hyperswarm (local testnet DHT, mirror of
 *      `two-peer-swarm-bidi.test.ts`) replicates A's log to B, which has ADMITTED
 *      A via the `verifyBindingOverride` channel-2 stand-in →
 *   5. B's read-merge picks up the op and the REAL `harness-features` projection
 *      (the exact `buildHarnessFeaturesProjection` write SQL, bound to B's pg via
 *      the new `sql` seam) writes the row into B's `harness_features_consolidated`
 *      with `origin='remote'`.
 *
 * The acceptance assertion reads B's PG and confirms the actual row (title /
 * status / etc.) is there. This is strictly MORE than the bidi test, which
 * stopped at a capturing `apply` spy — here the RECEIVING peer runs real PG
 * projections, so we prove the row genuinely lands in the database.
 *
 * ## Two SEPARATE databases (the meaningfulness precondition)
 * `createFreshPgDb` makes a distinct throwaway DATABASE per peer (pgA, pgB) on
 * the shared testcontainer. The projections are bound to each peer's `sql`
 * client via the Stage-6 `HarnessFeaturesProjectionOpts.sql` /
 * `IssuesProjectionOpts.sql` seam, so A's writes go ONLY to pgA and B's
 * projection writes go ONLY to pgB. The test asserts A's insert is absent from
 * pgB until federation delivers it — without separate DBs the whole test would
 * be a tautology (a row "appearing in B" that is really A's own row).
 *
 * ## What is real vs stood-in (same boundary as the bidi test)
 * - REAL: two corestores → two distinct logs; real Hyperswarm/Noise over a local
 *   testnet DHT; real `verifyAnnounce` signature check; real capture trigger;
 *   real outbox drain; real row→op mappers; real read-merge; real PG projections
 *   on BOTH peers; two real Postgres databases.
 * - STOOD IN (offline-deterministic, exactly as the bidi test): the channel-2
 *   GitHub-binding fetch → `verifyBindingOverride` admit-by-userId. Channel-2 is
 *   proven offline + live-verified separately.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { stubHivePolicyReadsForTest } from './_hive-policy-read-stubs';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import { bootHarnessSubstrate, type BootedHarnessHandle } from '../boot';
import { type HyperswarmLike } from '../swarm';
import type { OpEnvelope } from '../op-envelope-types';
import { _resetBootHistoryForTests } from '../boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';
import { drainOutboxOnce } from '../outbox-drain';
import { applyOpVia, type ProjectionLookup, type TableProjection } from '../projection';
import { buildHarnessFeaturesProjection } from '../projections/harness-features';
import { buildIssuesProjection } from '../projections/issues';
// WI-261 Prong A: the REAL per-harness scoped apply (with the harness_slug guard +
// the hive-home remap set) — NOT the simplified buildPeerApply — so the slug-mismatch
// drop is exercised exactly as production applies it.
import { buildHarnessProjectionApply } from '../projections/register-all';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  SUBSTRATE_OUTBOX_DDL,
  FILL_WORKSPACE_ID_DDL,
  HARNESS_ISSUES_CONSOLIDATED_FED_DDL,
} from '../../../../test/_work-items-schema';
// WI-259 STEP 1 (P-001) membership-aware admission case (below) — these route the
// PROCESS-GLOBAL getOrgPg() at a migrated throwaway DB so boot.ts's STEP 1 reads
// (potHomeSlugForHarness + resolveHiveMemberDeviceSet, both hardcoded to getOrgPg()
// with NO sql seam) resolve against a seeded pot_members/hives/harness_registry.
// Mirrors the _baseline-coord-fixture env-routing in two-peer-convergence.integration.test.ts.
import { _resetForTests as resetDbOrgPools } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache the pool resolver memoizes
import { _resetUrlCacheForTests } from '../../../../../../libs/papercusp/libs/db/src/connection';
import { _resetHarnessAdminUrlCacheForTests } from '../../../embedded-pg-discovery';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { mutateHarnessRegistry } from '../../../harness-registry';
import { _clearHiveMemberDeviceSetCacheForTest } from '../hive-member-identity-set';
// WI-259 P-004 defer/replay capstone — drives the REAL projections + buffer + drain hook.
import { buildHiveMembersProjection, type HiveMemberRow } from '../projections/hive-members';
import type { HarnessIssueRow } from '../projections/issues';
import type { ProvenanceContext } from '../projection';
import { DEFAULT_MEMBER_CONTENT_TTL_MS, PendingMembershipContent } from '../pending-membership-content';

const __dirname = dirname(fileURLToPath(import.meta.url));
// .../apps/operator/lib/sync/hyperbee/__tests__ → repo root is six levels up.
const REPO_ROOT = resolve(__dirname, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

// ── Shared identity / swarm constants. Same binding on both peers → same topic. ──
const WORKSPACE_ID = 'ws-fed-stage6';
const HARNESS_SLUG = 'sheets';
const BINDING = {
  kind: 'local' as const,
  workspace_id: WORKSPACE_ID,
  harness_slug: HARNESS_SLUG,
};

// ── Async resource teardown (newest-first, mirrors the bidi test). ──
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

/** A `bootHarnessSubstrate` announce-identity override for a peer with a
 *  self-generated Ed25519 keypair (no OS keychain / gh) — mirrors the bidi test. */
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
        // Bypass the real ensureAttestationGist (it signs with the OS keychain
        // key for `keychainId`, which this test never seeds → AttestationError
        // → swallowed swarm-join failure → handle.swarm null). The announce
        // doesn't need a real gist for the in-process testnet swarm.
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

/** Cluster-global framework roles the migration GRANTs reference. Roles are
 *  cluster-wide in Postgres, so creating them once on either DB suffices for
 *  every throwaway DB on the reused testcontainer. Idempotent. */
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

/**
 * Build the minimal-but-faithful federation schema in a peer's DB, then apply
 * the REAL migration-102 (capture trigger + outbox) and migration-103
 * (workspace_id fill trigger) SQL files verbatim — so the send-side this test
 * exercises is the production trigger, not a re-implementation.
 *
 * The consolidated tables carry exactly the columns the trigger reads
 * (`origin`, `workspace_id`, key column) + the columns the projections
 * INSERT/SELECT. A `projects` row maps `harness_slug → WORKSPACE_ID` so the
 * migration-103 BEFORE-INSERT fill trigger stamps the SAME workspace_id the
 * booted harness drains on (otherwise the drain's `workspace_id` filter misses).
 */
async function setupPeerSchema(sql: postgres.Sql, memberSlug: string = HARNESS_SLUG): Promise<void> {
  await sql.unsafe(FRAMEWORK_ROLES_DDL);

  // P-010 unification: work_items is the base table + hfc/ei compat views (replaces the
  // hand-rolled consolidated tables). projects maps harness_slug → WORKSPACE_ID for the
  // fill trigger; the work_items CDC capture (mig 375) is the real post-unification
  // send-side (stamps table_name harness_features_consolidated / engineer_issues per family).
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await sql.unsafe(`
    CREATE TABLE harness_shared.projects (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      status       TEXT NOT NULL,
      slug         TEXT,
      workspace_id TEXT,
      created_ts   BIGINT NOT NULL,
      updated_ts   BIGINT NOT NULL
    );
  `);

  // Map the harness slug → the workspace_id the booted handle drains on, so the fill
  // trigger stamps the matching value and the drain's `workspace_id` filter matches.
  // `memberSlug` defaults to HARNESS_SLUG; the slug-mismatch case (WI-261) passes each
  // peer's DISTINCT member slug so its own writes resolve the workspace_id.
  await sql`
    INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id, created_ts, updated_ts)
    VALUES ('p-fed', 'Fed', 'active', ${memberSlug}, ${WORKSPACE_ID}, 0, 0)
  `;

  // The outbox surface, the workspace_id fill (now on the work_items BASE — hfc is a
  // compat VIEW), and the work_items capture (mig 375). 375 captures feature rows under
  // table_name='harness_features_consolidated' and issue rows under 'engineer_issues',
  // so the read-side projections demux exactly as before the unification.
  await sql.unsafe(SUBSTRATE_OUTBOX_DDL);
  await sql.unsafe(FILL_WORKSPACE_ID_DDL);
  // The legacy harness_issues_consolidated federated table (separate from the unification)
  // + its generic capture/fill — some of these tests federate it alongside features.
  await sql.unsafe(HARNESS_ISSUES_CONSOLIDATED_FED_DDL);
  const stripMig = (s: string) =>
    s
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('\\') && !/^(begin|commit);$/i.test(t);
      })
      .join('\n');
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '375-work-items-cdc-capture.sql'), 'utf8')));
}

/**
 * Build a PER-PEER scoped projection apply bound to THIS peer's `sql` (NOT the
 * process-global getOrgPg). Contains exactly the two federated projections
 * (features + issues) — the only tables this test's ops touch. Mirrors
 * `buildHarnessProjectionApply`'s structure (the 2-entry lookup + `applyOpVia`),
 * but threads the per-peer `sql` seam so the receiving peer's REAL projection SQL
 * writes into the receiving peer's REAL database. `ownLogKeyHex` is threaded so
 * `applyOpVia` derives origin from log-source (own → 'local', admitted-remote →
 * 'remote') — exactly as production does.
 */
function buildPeerApply(
  sql: postgres.Sql,
  ownLogKeyHex: string,
): (op: OpEnvelope) => Promise<boolean> {
  const opts = { workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG, sql };
  const scoped = new Map<string, TableProjection<unknown>>();
  for (const p of [
    buildHarnessFeaturesProjection(opts),
    buildIssuesProjection(opts),
  ] as TableProjection<unknown>[]) {
    scoped.set(p.tableTag, p);
  }
  const lookup: ProjectionLookup = (tag) => scoped.get(tag) ?? null;
  return (op: OpEnvelope) => applyOpVia(lookup, op, { ownLogKeyHex });
}

/** Read one feature row out of a peer's PG as the projection shape (epoch-ms
 *  timestamps, origin), so assertions compare real persisted columns. */
async function readFeature(sql: postgres.Sql, featureId: string) {
  const rows = await sql<
    Array<{ feature_id: string; title: string | null; status: string | null; origin: string; workspace_id: string }>
  >`
    SELECT feature_id, title, status, origin, workspace_id
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${HARNESS_SLUG} AND feature_id = ${featureId}
  `;
  return rows[0];
}

async function readIssue(sql: postgres.Sql, issueId: string) {
  const rows = await sql<
    Array<{ issue_id: string; title: string; severity: string; status: string; origin: string }>
  >`
    SELECT issue_id, title, severity, status, origin
      FROM harness_shared.harness_issues_consolidated
     WHERE harness_slug = ${HARNESS_SLUG} AND issue_id = ${issueId}
  `;
  return rows[0];
}

/** Slug-parameterized `readIssue` — the WI-259 P-004 case reads an issue row under a GIVEN
 *  (cross-member author) slug, which the hardcoded-HARNESS_SLUG `readIssue` can't address. */
async function readIssueForSlug(sql: postgres.Sql, slug: string, issueId: string) {
  const rows = await sql<
    Array<{ issue_id: string; title: string; severity: string; status: string; origin: string }>
  >`
    SELECT issue_id, title, severity, status, origin
      FROM harness_shared.harness_issues_consolidated
     WHERE harness_slug = ${slug} AND issue_id = ${issueId}
  `;
  return rows[0];
}

async function countOutbox(sql: postgres.Sql, table: string, key: string): Promise<number> {
  const rows = await sql<Array<{ n: string | number }>>`
    SELECT COUNT(*)::int AS n FROM harness_shared.substrate_outbox
     WHERE table_name = ${table} AND key = ${key}
  `;
  return Number(rows[0]?.n ?? 0);
}

/** Slug-parameterized `readFeature` — the WI-261 case reads a feature row under a
 *  GIVEN member slug (peers no longer share one slug, so the hardcoded-HARNESS_SLUG
 *  variant above can't address B's projection scope). */
async function readFeatureForSlug(sql: postgres.Sql, slug: string, featureId: string) {
  const rows = await sql<
    Array<{ feature_id: string; title: string | null; status: string | null; origin: string; workspace_id: string }>
  >`
    SELECT feature_id, title, status, origin, workspace_id
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${slug} AND feature_id = ${featureId}
  `;
  return rows[0];
}

interface BootedPeer {
  handle: BootedHarnessHandle;
  pg: postgres.Sql;
  identity: ReturnType<typeof makeIdentityOverride>;
}

describe('Stage 6 — feature/issue content federates A↔B end-to-end through the REAL CDC-outbox + swarm (testcontainer PG)', () => {
  it(
    'a feature written on A lands in B (and vice versa), issues federate, and the echo-loop terminates',
    async () => {
      // Non-Hive harness with NO org-pool routing: model the successful absent-policy read,
      // or every merge pass fails on the live-DSN guard (WI-6554700010008455). Pushed first
      // so the newest-first teardown restores it after the substrates close.
      cleanups.push(stubHivePolicyReadsForTest());
      // ── Two SEPARATE databases — peer A's DB and peer B's DB. ──
      const dbA: FreshPgDb = await createFreshPgDb('fedA');
      cleanups.push(() => dbA.cleanup());
      const dbB: FreshPgDb = await createFreshPgDb('fedB');
      cleanups.push(() => dbB.cleanup());
      await setupPeerSchema(dbA.sql);
      await setupPeerSchema(dbB.sql);

      // Confirm separateness up front: they are genuinely different databases.
      const [nameA] = await dbA.sql<Array<{ d: string }>>`SELECT current_database() AS d`;
      const [nameB] = await dbB.sql<Array<{ d: string }>>`SELECT current_database() AS d`;
      expect(nameA.d).not.toBe(nameB.d);

      // ── Local testnet DHT (offline) + two real swarms (mirror bidi). ──
      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      const idA = makeIdentityOverride('alice', 42, 'kc-alice');
      const idB = makeIdentityOverride('bob', 7, 'kc-bob');
      const swarmA = makeSwarm(testnet.bootstrap);
      const swarmB = makeSwarm(testnet.bootstrap);
      const rootA = makeWorkspaceRoot('fed-A-');
      const rootB = makeWorkspaceRoot('fed-B-');

      // ── Boot A: admits B; real PG projection apply bound to A's DB. ──
      // applyOverride is built AFTER boot needs ownLog.keyHex; resolve via a
      // late-bound holder so the per-peer apply can reference each handle's own
      // log key (origin determination). We pass a thunk-backed apply: build it
      // lazily on first call using the captured handle's ownLog.keyHex.
      let handleA: BootedHarnessHandle | undefined;
      let handleB: BootedHarnessHandle | undefined;
      let applyA: ((op: OpEnvelope) => Promise<boolean>) | undefined;
      let applyB: ((op: OpEnvelope) => Promise<boolean>) | undefined;

      handleA = await bootHarnessSubstrate({
        workspaceRoot: rootA,
        workspaceId: WORKSPACE_ID,
        harnessSlug: HARNESS_SLUG,
        swarmBinding: BINDING,
        swarmOverride: swarmA,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idB.userId ? 'verified' : 'fail',
        applyOverride: (op, ctx) => {
          applyA ??= buildPeerApply(dbA.sql, ctx.ownLogKeyHex);
          return applyA(op);
        },
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idA.override,
        // Not a re-key test: without this the boot resolves Hive scope through the LIVE org
        // pool, which the integration live-DSN guard refuses (WI-6554700010008455).
        rekeyDepsOverride: null,
      });
      cleanups.push(async () => {
        await handleA?.close();
        await closeHarnessStore({ workspaceRoot: rootA, harnessSlug: HARNESS_SLUG });
      });

      handleB = await bootHarnessSubstrate({
        workspaceRoot: rootB,
        workspaceId: WORKSPACE_ID,
        harnessSlug: HARNESS_SLUG,
        swarmBinding: BINDING,
        swarmOverride: swarmB,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idA.userId ? 'verified' : 'fail',
        applyOverride: (op, ctx) => {
          applyB ??= buildPeerApply(dbB.sql, ctx.ownLogKeyHex);
          return applyB(op);
        },
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idB.override,
        rekeyDepsOverride: null, // see boot A (WI-6554700010008455)
      });
      cleanups.push(async () => {
        await handleB?.close();
        await closeHarnessStore({ workspaceRoot: rootB, harnessSlug: HARNESS_SLUG });
      });

      const peerA: BootedPeer = { handle: handleA, pg: dbA.sql, identity: idA };
      const peerB: BootedPeer = { handle: handleB, pg: dbB.sql, identity: idB };

      // Both must have joined the swarm on the same topic.
      expect(peerA.handle.swarm).not.toBeNull();
      expect(peerB.handle.swarm).not.toBeNull();
      expect(peerA.handle.swarm!.topicHex).toBe(peerB.handle.swarm!.topicHex);

      // ── (1) A→B FEATURE: local insert on A → real trigger → outbox → drain → log. ──
      await peerA.pg`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${HARNESS_SLUG}, 'F-fed-1', 'Federated feature one', 'from A', 'todo', 0, 'local', 1001, 1001, 1001)
      `;
      // The capture trigger should have enqueued exactly one outbox row in A's DB.
      expect(await countOutbox(peerA.pg, 'harness_features_consolidated', 'F-fed-1')).toBe(1);
      // Sanity: it is NOT in B yet (separate DBs; federation hasn't run).
      expect(await readFeature(peerB.pg, 'F-fed-1')).toBeUndefined();

      // Drain A's outbox → appends to A's own log. (A background boot-time
      // mergeNow may re-apply the own log and settle author_pubkey NULL→'', so a
      // drain can carry a small bounded number of settling rows in addition to
      // the new one — assert it drained AT LEAST the new feature, and that the
      // append actually reached A's log.)
      const lenA0 = peerA.handle.ownLog.length;
      const drainedA = await drainOutboxOnce(peerA.handle, peerA.pg);
      expect(drainedA, "A's F-fed-1 was not drained to its log").toBeGreaterThanOrEqual(1);
      expect(peerA.handle.ownLog.length).toBeGreaterThan(lenA0);

      // ── (2) B→A FEATURE (symmetric). ──
      await peerB.pg`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${HARNESS_SLUG}, 'F-fed-2', 'Federated feature two', 'from B', 'in-progress', 0, 'local', 1002, 1002, 1002)
      `;
      expect(await countOutbox(peerB.pg, 'harness_features_consolidated', 'F-fed-2')).toBe(1);
      const drainedB = await drainOutboxOnce(peerB.handle, peerB.pg);
      expect(drainedB).toBeGreaterThanOrEqual(1);

      // ── (4) ISSUE A→B: local issue insert on A → real fill+capture triggers → outbox → drain. ──
      await peerA.pg`
        INSERT INTO harness_shared.harness_issues_consolidated
          (harness_slug, issue_id, title, severity, source, status, found_at, attempts, notes, created_ts, updated_ts, origin)
        VALUES (${HARNESS_SLUG}, 'I-fed-1', 'Federated issue one', 'high', 'test', 'open',
                to_timestamp(1003 / 1000.0), 0, '[]'::jsonb, 1003, 1003, 'local')
      `;
      // The migration-103 fill trigger must have stamped the REAL workspace_id
      // (so the drain's workspace filter matches) — assert it, since '' would
      // silently break issue federation.
      const issWs = await peerA.pg<Array<{ workspace_id: string }>>`
        SELECT workspace_id FROM harness_shared.harness_issues_consolidated
         WHERE harness_slug = ${HARNESS_SLUG} AND issue_id = 'I-fed-1'
      `;
      expect(issWs[0]?.workspace_id).toBe(WORKSPACE_ID);
      expect(await countOutbox(peerA.pg, 'harness_issues_consolidated', 'I-fed-1')).toBe(1);
      const drainedIssue = await drainOutboxOnce(peerA.handle, peerA.pg);
      expect(drainedIssue, "A's I-fed-1 was not drained to its log").toBeGreaterThanOrEqual(1);

      // ── THE ACCEPTANCE: poll both peers' real merge, assert real PG rows. ──
      // Each tick drives mergeNow() on both peers (real swarm replication has
      // already crossed A↔B logs; merge reads them into each peer's PG via the
      // real projections). Resolves once all three cross-peer rows have landed.
      const result = await pollUntil(
        async () => {
          await Promise.all([peerA.handle.mergeNow(), peerB.handle.mergeNow()]);
          const fAonB = await readFeature(peerB.pg, 'F-fed-1');
          const fBonA = await readFeature(peerA.pg, 'F-fed-2');
          const iAonB = await readIssue(peerB.pg, 'I-fed-1');
          return fAonB && fBonA && iAonB ? { fAonB, fBonA, iAonB } : undefined;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );

      // (1) A→B feature — the core proof.
      expect(result?.fAonB, "A's feature F-fed-1 never reached B's PG (A→B failed)").toBeTruthy();
      expect(result!.fAonB).toMatchObject({
        feature_id: 'F-fed-1',
        title: 'Federated feature one',
        status: 'todo',
        origin: 'remote', // B received it from A's log → stamped remote
        workspace_id: WORKSPACE_ID,
      });

      // (2) B→A feature — bidirectional.
      expect(result?.fBonA, "B's feature F-fed-2 never reached A's PG (B→A failed)").toBeTruthy();
      expect(result!.fBonA).toMatchObject({
        feature_id: 'F-fed-2',
        title: 'Federated feature two',
        status: 'in-progress',
        origin: 'remote',
      });

      // (4) issue A→B.
      expect(result?.iAonB, "A's issue I-fed-1 never reached B's PG (issue A→B failed)").toBeTruthy();
      expect(result!.iAonB).toMatchObject({
        issue_id: 'I-fed-1',
        title: 'Federated issue one',
        severity: 'high',
        status: 'open',
        origin: 'remote',
      });

      // ── (3) ECHO-GUARD at integration level ──
      // (3a) A remote-origin write does NOT enqueue an outbox row. B's projection
      // just wrote F-fed-1 into B's PG with origin='remote' (the merge above).
      // Assert B did NOT re-enqueue it — the capture trigger's origin filter
      // dropped it, so the loop terminates (no echo back to A).
      expect(
        await countOutbox(peerB.pg, 'harness_features_consolidated', 'F-fed-1'),
        "B re-enqueued A's federated feature → echo loop would amplify forever",
      ).toBe(0);
      expect(
        await countOutbox(peerB.pg, 'harness_issues_consolidated', 'I-fed-1'),
        "B re-enqueued A's federated issue → echo loop",
      ).toBe(0);
      // And A did not echo B's F-fed-2 back into A's outbox either.
      expect(await countOutbox(peerA.pg, 'harness_features_consolidated', 'F-fed-2')).toBe(0);

      // (3b) Directly insert an origin='remote' feature on A → assert NO outbox
      // row is produced (the trigger filter, exercised in isolation).
      await peerA.pg`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${HARNESS_SLUG}, 'F-remote-direct', 'should not federate', 'todo', 0, 'remote', 2000, 2000, 2000)
      `;
      expect(
        await countOutbox(peerA.pg, 'harness_features_consolidated', 'F-remote-direct'),
        'a remote-origin local insert must NOT enqueue (echo guard)',
      ).toBe(0);

      // (3c) INTRA-PEER self-amplification guard CONVERGES (a Stage-6 finding,
      // now fixed). The substrate's read-merge re-applies the OWN log's ops
      // (origin='local') every pass — re-UPSERTing each local feature/issue.
      // Migration 102's capture UPDATE trigger carries a `WHEN (OLD.* IS DISTINCT
      // FROM NEW.*)` guard so an IDENTICAL re-upsert does NOT re-enqueue. Without
      // it the outbox grows by one row PER local feature PER merge pass forever
      // (verified: an identical origin='local' re-upsert grows the outbox 1→2),
      // and the drain re-appends those to the own log unboundedly.
      //
      // A bounded one-time settling is still expected: the test's manual INSERTs
      // leave author_pubkey NULL, and the first own-log merge-back upserts it to
      // '' (a REAL change → enqueues once), after which every further merge-back
      // is identical (guarded → no enqueue). So the invariant under test is
      // CONVERGENCE: repeatedly merge + drain and confirm the system reaches a
      // FIXED POINT (a drain that returns 0) and STAYS there — proving no
      // unbounded amplification. A missing/ineffective guard never converges
      // (every drain keeps returning rows).
      let converged = false;
      for (let pass = 0; pass < 8; pass++) {
        await Promise.all([peerA.handle.mergeNow(), peerB.handle.mergeNow()]);
        const a = await drainOutboxOnce(peerA.handle, peerA.pg);
        const b = await drainOutboxOnce(peerB.handle, peerB.pg);
        if (a === 0 && b === 0) {
          // Confirm it STAYS at the fixed point across one more full cycle.
          await Promise.all([peerA.handle.mergeNow(), peerB.handle.mergeNow()]);
          const a2 = await drainOutboxOnce(peerA.handle, peerA.pg);
          const b2 = await drainOutboxOnce(peerB.handle, peerB.pg);
          if (a2 === 0 && b2 === 0) {
            converged = true;
            break;
          }
        }
      }
      expect(
        converged,
        'outbox never reached a fixed point under repeated merge+drain — the migration-102 ' +
          'IS-DISTINCT-FROM guard is missing/ineffective (unbounded intra-peer self-amplification)',
      ).toBe(true);
    },
    60_000,
  );

  // EI-681: a harness that "goes shared" must RE-KEY onto a new swarm topic (its
  // gh:<repo_id> topic → the hive-pubkey topic). The fix is that re-key happens
  // IN PLACE — handle.rekey leaves the old topic + joins the new one while
  // keeping the SAME Corestore + own log (and their open cores + replication
  // streams) ALIVE. A reboot-based re-key tore the store down and broke the
  // OWNER's corestore serving of its own log core, so the feature never crossed
  // (the full owner→joiner crossing is proven by the packaged from-repo smoke,
  // which has the persistent directory connection production relies on). This
  // proves the load-bearing in-place CONTRACT: the topic changes, but the store
  // + own log are the SAME live objects with content preserved — a reboot would
  // evict the store + re-open a fresh own log, which this test would catch.
  it(
    'handle.rekey changes the swarm topic IN PLACE — same store + own log, content preserved',
    async () => {
      cleanups.push(stubHivePolicyReadsForTest()); // see the first test (WI-6554700010008455)
      const dbA: FreshPgDb = await createFreshPgDb('rekey');
      cleanups.push(() => dbA.cleanup());
      await setupPeerSchema(dbA.sql);

      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      const idA = makeIdentityOverride('alice', 42, 'kc-alice');
      const swarmA = makeSwarm(testnet.bootstrap);
      const rootA = makeWorkspaceRoot('rekey-');

      let handleA: BootedHarnessHandle | undefined;
      let applyA: ((op: OpEnvelope) => Promise<boolean>) | undefined;
      handleA = await bootHarnessSubstrate({
        workspaceRoot: rootA,
        workspaceId: WORKSPACE_ID,
        harnessSlug: HARNESS_SLUG,
        swarmBinding: BINDING,
        swarmOverride: swarmA,
        applyOverride: (op, ctx) => {
          applyA ??= buildPeerApply(dbA.sql, ctx.ownLogKeyHex);
          return applyA(op);
        },
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idA.override,
        // Not a re-key test: without this the boot resolves Hive scope through the LIVE org
        // pool, which the integration live-DSN guard refuses (WI-6554700010008455).
        rekeyDepsOverride: null,
      });
      cleanups.push(async () => {
        await handleA?.close();
        await closeHarnessStore({ workspaceRoot: rootA, harnessSlug: HARNESS_SLUG });
      });

      // Seed own-log content via the REAL CDC outbox → drain (the same path a
      // shared harness uses), then capture the pre-re-key substrate identity.
      await dbA.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${HARNESS_SLUG}, 'F-pre-rekey', 'Before re-key', 'seed', 'todo', 0, 'local', 1001, 1001, 1001)
      `;
      const drained = await drainOutboxOnce(handleA, dbA.sql);
      expect(drained).toBeGreaterThanOrEqual(1);

      const storeBefore = handleA.store;
      const ownLogBefore = handleA.ownLog;
      const keyBefore = handleA.ownLog.keyHex;
      const lenBefore = handleA.ownLog.length;
      expect(lenBefore).toBeGreaterThanOrEqual(1);
      const topic1 = handleA.swarm?.topicHex;
      expect(topic1).toBeTruthy();

      // ── RE-KEY IN PLACE onto a DIFFERENT topic (gh binding). ──
      const BINDING2 = { kind: 'gh' as const, github_repository_id: 987654321 };
      await handleA.rekey(BINDING2);

      // The topic CHANGED…
      const topic2 = handleA.swarm?.topicHex;
      expect(topic2, 're-key must actually change the swarm topic').not.toBe(topic1);
      expect(topic2).toBeTruthy();
      // …but the store + own log are the SAME LIVE OBJECTS (in place, NOT a
      // reboot — a reboot evicts the Corestore + re-opens a fresh own log).
      expect(handleA.store, 're-key must keep the SAME Corestore (in place)').toBe(storeBefore);
      expect(handleA.ownLog, 're-key must keep the SAME own log object').toBe(ownLogBefore);
      expect(handleA.ownLog.keyHex).toBe(keyBefore);
      expect(handleA.ownLog.length, 'own-log content must survive the re-key').toBe(lenBefore);

      // …and the substrate still works after the re-key (a fresh write drains
      // onto the SAME kept own log, advancing it).
      await dbA.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${HARNESS_SLUG}, 'F-post-rekey', 'After re-key', 'seed2', 'todo', 0, 'local', 1002, 1002, 1002)
      `;
      const drained2 = await drainOutboxOnce(handleA, dbA.sql);
      expect(drained2, 'a write after the re-key must still drain onto the kept own log').toBeGreaterThanOrEqual(1);
      expect(handleA.ownLog.length).toBeGreaterThan(lenBefore);
    },
    60_000,
  );

  // ──────────────────────────────────────────────────────────────────────────
  // WI-261 Prong A — REPRODUCES WI-259: a member-harness FEATURE written on peer
  // A does NOT federate-and-apply to peer B when B's member harness has a
  // DIFFERENT slug than A's. This is the from-repo join shape: the owner A boots a
  // member harness slug `hive-repo`, the joiner B joins via from-repo and gets the
  // slug `joined-hive-repo`, and BOTH ride the SAME shared hive topic (here a
  // single shared `BINDING`, exactly as a `hive:<pubkey>` topic is shared
  // independent of each peer's member slug — see derive-swarm-topic.ts).
  //
  // THE SLUG-MISMATCH MECHANISM (root cause CONFIRMED — do not re-investigate):
  //   - `buildHarnessProjectionApply(opts)` (register-all.ts:236) takes a
  //     `potHomeSlug`, but in `buildHarnessProjections` (register-all.ts:171-174)
  //     ONLY the hive-home-grained projections (pot_settings, pot_members,
  //     pot_policy, pot_reports, pot_pending_joins, pot_epoch_keys) rebind to
  //     `potHomeSlug`. The ~16 OTHERS — INCLUDING harness_features — STAY scoped
  //     to the member `harnessSlug`.
  //   - So A's feature op carries `harness_slug = 'hive-repo'` (A's member slug);
  //     B's features projection is scoped to `harnessSlug = 'joined-hive-repo'`;
  //     the writeToPg slug guard (`if (row.harness_slug !== opts.harnessSlug)
  //     return;`, harness-features.ts:154) silently drops A's op at the APPLY
  //     layer — even though the op WAS admitted + replicated to B.
  //
  // We wire each peer's apply with the REAL `buildHarnessProjectionApply` (its
  // per-peer `sql` seam + `potHomeSlug` = the shared hive-home), NOT the
  // simplified `buildPeerApply`, so the real harness_slug guard + the surgical
  // hive-home remap set are exercised exactly as production applies them.
  //
  // `it.fails`: today the DESIRED assertion (A's feature lands in B's PG) FAILS —
  // documenting the broken behavior while staying CI-green. It FLIPS RED (forcing
  // its removal) once the fix lands: features join the hive-home remap set
  // (register-all.ts:171-174) AND the write-path stamps the hive-home scope on the
  // feature op so the home-scoped projection accepts it.
  // ──────────────────────────────────────────────────────────────────────────
  it.fails(
    'WI-261 Prong A (repro WI-259): a feature on A does NOT reach B when B has a different member slug',
    async () => {
      // The from-repo join shape: A's member slug ≠ B's member slug, SAME hive-home.
      const A_SLUG = 'hive-repo'; // owner A's member harness slug
      const B_SLUG = 'joined-hive-repo'; // joiner B's from-repo member slug
      const HIVE_HOME = 'hive-repo-home'; // the SHARED hive-home slug both scope to

      // ── Two SEPARATE databases — each seeded with ITS OWN member slug → workspace
      //    so each peer's local write resolves workspace_id and drains onto its log. ──
      const dbA: FreshPgDb = await createFreshPgDb('wi261A');
      cleanups.push(() => dbA.cleanup());
      const dbB: FreshPgDb = await createFreshPgDb('wi261B');
      cleanups.push(() => dbB.cleanup());
      await setupPeerSchema(dbA.sql, A_SLUG);
      await setupPeerSchema(dbB.sql, B_SLUG);

      // ── Local testnet DHT + two real swarms (mirror the acceptance test). ──
      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      const idA = makeIdentityOverride('alice', 42, 'kc-alice');
      const idB = makeIdentityOverride('bob', 7, 'kc-bob');
      const swarmA = makeSwarm(testnet.bootstrap);
      const swarmB = makeSwarm(testnet.bootstrap);
      const rootA = makeWorkspaceRoot('wi261-A-');
      const rootB = makeWorkspaceRoot('wi261-B-');

      let handleA: BootedHarnessHandle | undefined;
      let handleB: BootedHarnessHandle | undefined;
      let applyA: ((op: OpEnvelope) => Promise<boolean>) | undefined;
      let applyB: ((op: OpEnvelope) => Promise<boolean>) | undefined;

      // ── Boot A: member slug A_SLUG; REAL scoped apply bound to A's DB + hive-home. ──
      handleA = await bootHarnessSubstrate({
        workspaceRoot: rootA,
        workspaceId: WORKSPACE_ID,
        harnessSlug: A_SLUG,
        swarmBinding: BINDING, // SHARED binding → SHARED topic, independent of member slug
        swarmOverride: swarmA,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idB.userId ? 'verified' : 'fail',
        applyOverride: (op, ctx) => {
          // The REAL per-harness scoped apply (harness_slug guard + hive-home remap
          // set), threading A's per-peer `sql` seam and the shared hive-home.
          applyA ??= buildHarnessProjectionApply({
            workspaceId: WORKSPACE_ID,
            harnessSlug: A_SLUG,
            potHomeSlug: HIVE_HOME,
            sql: dbA.sql,
            ownLogKeyHex: ctx.ownLogKeyHex,
          });
          return applyA(op);
        },
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idA.override,
      });
      cleanups.push(async () => {
        await handleA?.close();
        await closeHarnessStore({ workspaceRoot: rootA, harnessSlug: A_SLUG });
      });

      // ── Boot B: DIFFERENT member slug B_SLUG; REAL scoped apply bound to B's DB. ──
      handleB = await bootHarnessSubstrate({
        workspaceRoot: rootB,
        workspaceId: WORKSPACE_ID,
        harnessSlug: B_SLUG,
        swarmBinding: BINDING,
        swarmOverride: swarmB,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idA.userId ? 'verified' : 'fail',
        applyOverride: (op, ctx) => {
          applyB ??= buildHarnessProjectionApply({
            workspaceId: WORKSPACE_ID,
            harnessSlug: B_SLUG, // B's features projection is scoped HERE…
            potHomeSlug: HIVE_HOME, // …and only hive_* projections rebind to this.
            sql: dbB.sql,
            ownLogKeyHex: ctx.ownLogKeyHex,
          });
          return applyB(op);
        },
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idB.override,
      });
      cleanups.push(async () => {
        await handleB?.close();
        await closeHarnessStore({ workspaceRoot: rootB, harnessSlug: B_SLUG });
      });

      // Both joined the SAME topic despite different member slugs (topic ⟵ binding).
      expect(handleA.swarm).not.toBeNull();
      expect(handleB.swarm).not.toBeNull();
      expect(handleA.swarm!.topicHex).toBe(handleB.swarm!.topicHex);

      // ── A writes a member-harness FEATURE under A's slug → real trigger → outbox
      //    → drain → A's own log. ──
      await dbA.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${A_SLUG}, 'F-wi261', 'Mismatch-slug feature', 'from A', 'todo', 0, 'local', 3001, 3001, 3001)
      `;
      expect(await countOutbox(dbA.sql, 'harness_features_consolidated', 'F-wi261')).toBe(1);
      // Sanity: not in B yet under EITHER slug (separate DBs; federation hasn't run).
      expect(await readFeatureForSlug(dbB.sql, A_SLUG, 'F-wi261')).toBeUndefined();
      expect(await readFeatureForSlug(dbB.sql, B_SLUG, 'F-wi261')).toBeUndefined();

      const drainedA = await drainOutboxOnce(handleA, dbA.sql);
      expect(drainedA, "A's F-wi261 was not drained to its log").toBeGreaterThanOrEqual(1);

      // ── PROVE the op reaches B's APPLY layer (so the test can't pass for the wrong
      //    reason). Drive merges until B has ADMITTED A's remote log: `handleB.admitted`
      //    is keyed by log_core_key (= ownLog.keyHex), seeded with B's own log + every
      //    read-admitted remote. Admission is the ADMIT layer; once it holds, A's op
      //    IS being fed to B's apply, so any failure to land is the harness_slug guard
      //    (the APPLY layer) dropping it — the WI-259 drop this test targets.
      //
      //    NB: under `it.fails`, ANY throw makes the case pass, so admission CANNOT be
      //    a plain `expect` inside the feature poll (an admit miss would mask the apply
      //    drop and pass for the wrong reason). We instead drive admission to a BOOLEAN
      //    here and gate the feature poll on it — if B never admits A (an admit-layer
      //    regression), `bAdmittedA` stays false, the feature poll is skipped, and the
      //    final assertion below fails with the admit-specific message (still a `.fails`
      //    pass, but the message names the wrong-reason case so a maintainer sees it).
      const bAdmittedA =
        (await pollUntil(
          async () => {
            await Promise.all([handleA!.mergeNow(), handleB!.mergeNow()]);
            return handleB!.admitted.has(handleA!.ownLog.keyHex) ? true : undefined;
          },
          { timeoutMs: 15_000, intervalMs: 250 },
        )) ?? false;

      // ── Now poll for the DESIRED outcome: A's feature lands in B's PG. We look under
      //    EVERY plausible slug-scope — A_SLUG (the slug the op physically carries),
      //    B_SLUG, and HIVE_HOME (where a future fix would write the row) — so the
      //    assertion flips green the moment ANY correct apply lands it. ──
      const landedOnB = bAdmittedA
        ? await pollUntil(
            async () => {
              await Promise.all([handleA!.mergeNow(), handleB!.mergeNow()]);
              return (
                (await readFeatureForSlug(dbB.sql, A_SLUG, 'F-wi261')) ??
                (await readFeatureForSlug(dbB.sql, B_SLUG, 'F-wi261')) ??
                (await readFeatureForSlug(dbB.sql, HIVE_HOME, 'F-wi261'))
              );
            },
            { timeoutMs: 15_000, intervalMs: 250 },
          )
        : undefined;

      // Surface the admit-layer precondition explicitly (the wrong-reason guard).
      expect(
        bAdmittedA,
        "B never admitted A's remote log — this would be an ADMIT-layer failure, NOT the " +
          'WI-259 APPLY-layer drop this test targets (the case is passing for the wrong reason)',
      ).toBe(true);

      // DESIRED behavior (fails TODAY — the whole point of `it.fails`): A's feature
      // reached B's apply (admitted above) but was dropped by B's features-projection
      // harness_slug guard (B scoped to B_SLUG ≠ the op's A_SLUG). When features join
      // the hive-home remap set (register-all.ts:171-174) + the write-path stamps the
      // hive-home scope on the feature op, this assertion passes and `it.fails` flips RED.
      expect(
        landedOnB,
        "A's feature F-wi261 never reached B's PG — WI-259: features are NOT in the " +
          'hive-home remap set, so B (scoped to its differing member slug) drops A’s op',
      ).toBeTruthy();
      expect(landedOnB).toMatchObject({
        feature_id: 'F-wi261',
        title: 'Mismatch-slug feature',
        status: 'todo',
        origin: 'remote',
      });
    },
    60_000,
  );

  // ──────────────────────────────────────────────────────────────────────────
  // WI-259 STEP 1 (P-001) — the MEMBERSHIP-AWARE admission gate (LANDED).
  //
  // The WI-261 Prong A case above does NOT seed pot_members, so on B
  // `myHiveHome = hiveHomeProjectionSlug ?? potHomeSlugForHarness(ws, B-slug)`
  // resolves null and STEP 1 is SKIPPED — it only exercises the APPLY-layer drop.
  // This case SEEDS membership so STEP 1's admission path actually FIRES: B admits
  // A's out-of-scope (different member slug) log BY IDENTITY because A's verified
  // `device_pubkey` ∈ B's hive's federated member device-pubkey set
  // (resolveHiveMemberDeviceSet → listHiveMembers, boot.ts onAnnounce `if (!inScope)`).
  //
  // HOW MEMBERSHIP IS SEEDED (the real path — NOT the hiveHomeProjectionSlug shortcut):
  // STEP 1 calls `potHomeSlugForHarness(ws, B_SLUG)` and
  // `resolveHiveMemberDeviceSet(ws, myHiveHome)` with NO `sql` seam — BOTH hardcode
  // the PROCESS-GLOBAL `getOrgPg()`. The two booted peers, by contrast, bind their
  // PROJECTIONS to per-peer `sql` seams (dbA/dbB) — getOrgPg() is never their DB. So
  // to make STEP 1 read seeded membership we env-route getOrgPg() at a THIRD, MIGRATED
  // throwaway DB (createOrgTestDb + HARNESS_ADMIN/DATABASE_URL — the established
  // _baseline-coord-fixture pattern, see two-peer-convergence.integration.test.ts) and
  // seed THERE:
  //   - `hives`         — one row for HIVE_HOME (pot_members FKs it; needs a valid
  //                       raw-32 base64 Ed25519 public_key).
  //   - `pot_members`  — one row for A's identity (idA.userId + a device_attestations
  //                       entry carrying idA.devicePubkey), pot_home_slug = HIVE_HOME.
  //                       This is what resolveHiveMemberDeviceSet returns A's pubkey from.
  //   - `harness_registry` — B's project `{ slug: B_SLUG, hive_slug: HIVE_HOME }` so
  //                       potHomeSlugForHarness(ws, B_SLUG) resolves HIVE_HOME (A's
  //                       home project + a hive entry too, for symmetry).
  // A's announce carries A's REAL device_pubkey + github_user_id (the identity override),
  // matched to the seeded pot_members row.
  //
  // ASSERTIONS:
  //  (1) PASSES — B ADMITS A's log: `handleB.admitted.has(handleA.ownLog.keyHex)` flips
  //      true (STEP 1's `same_hive_member` admission fired). This is the NEW value: it
  //      validates the landed P-001 path. A miss FAILS the test (real regression signal).
  //  (2) Current state (documented) — A's feature does NOT yet land in B's PG: apply
  //      still drops it (P-002 not wired + the register-all member-slug guard still live).
  //      This check FLIPS to an admission→presence assertion when WI-259 P-002 lands.
  // ──────────────────────────────────────────────────────────────────────────
  it(
    'WI-259 (P-001+P-002): B ADMITS A’s same-hive cross-member log by membership identity AND applies its content — A’s feature lands in B under A’s member slug',
    async () => {
      const A_SLUG = 'hive-repo'; // owner A's member harness slug
      const B_SLUG = 'joined-hive-repo'; // joiner B's from-repo member slug
      const HIVE_HOME = 'hive-repo-home'; // the shared hive-home both members belong to

      // ── Env-route the PROCESS-GLOBAL getOrgPg() at a migrated membership DB so
      //    boot.ts STEP 1's getOrgPg()-backed reads see seeded pot_members/hives/registry. ──
      const orgDb: OrgTestDb = await createOrgTestDb();
      const prevAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
      const prevAppUrl = process.env.HARNESS_DATABASE_URL;
      const prevWs = process.env.PAPERCUSP_WORKSPACE_ID;
      const prevSkipDisc = process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
      const prevPgb = process.env.PAPERCUSP_PGBOUNCER;
      process.env.HARNESS_ADMIN_DATABASE_URL = orgDb.adminDsn;
      process.env.HARNESS_DATABASE_URL = orgDb.appDsn;
      process.env.PAPERCUSP_WORKSPACE_ID = WORKSPACE_ID;
      process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
      // backend-connection-scaling-2026-06-17: pgbouncerEnabled() is DEFAULT-ON on a SERVER-class host
      // (the dev box), so maybePgbouncer() rewrites the getOrgPg URL's host to 127.0.0.1:6432 (fronting
      // NATIVE PG) — bypassing this throwaway testcontainer DB and yielding "no such database: org_…".
      // Force the documented kill-switch OFF so STEP-1's getOrgPg reads honour the env DSN's port.
      process.env.PAPERCUSP_PGBOUNCER = '0';
      _resetUrlCacheForTests();
      _resetHarnessAdminUrlCacheForTests();
      await resetDbOrgPools();
      _clearHiveMemberDeviceSetCacheForTest();
      cleanups.push(async () => {
        // Restore env + reset the global pools/caches so the OTHER cases in this file
        // (which never touch getOrgPg()) are unaffected.
        if (prevAdminUrl === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
        else process.env.HARNESS_ADMIN_DATABASE_URL = prevAdminUrl;
        if (prevAppUrl === undefined) delete process.env.HARNESS_DATABASE_URL;
        else process.env.HARNESS_DATABASE_URL = prevAppUrl;
        if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
        else process.env.PAPERCUSP_WORKSPACE_ID = prevWs;
        if (prevSkipDisc === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
        else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = prevSkipDisc;
        if (prevPgb === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
        else process.env.PAPERCUSP_PGBOUNCER = prevPgb;
        _resetUrlCacheForTests();
        _resetHarnessAdminUrlCacheForTests();
        _clearHiveMemberDeviceSetCacheForTest();
        await resetDbOrgPools();
        await orgDb?.cleanup();
      });

      // ── Identities up front — A's seeded pot_members row MUST match A's announce. ──
      const idA = makeIdentityOverride('alice', 42, 'kc-alice');
      const idB = makeIdentityOverride('bob', 7, 'kc-bob');

      // ── Seed membership in the env-routed (getOrgPg) DB. adminSql is harness_admin
      //    (RLS-bypass superuser), so no app.workspace_id GUC is needed. ──
      // A valid raw-32 base64 Ed25519 pubkey for the hives row (pot_members FKs hives).
      const { publicKey: hivePub } = generateKeyPairSync('ed25519');
      const hivePubkeyB64 = rawPubkeyBase64(hivePub);
      await orgDb.adminSql`
        INSERT INTO harness_shared.pots
          (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, decode(${hivePubkeyB64}, 'base64'),
                'kc-hive-home', 'Hive Home', null, 1, 1)
      `;
      // A's pot_members row — the device_attestations entry carries A's REAL announce
      // device_pubkey, so resolveHiveMemberDeviceSet(ws, HIVE_HOME) contains it.
      await orgDb.adminSql`
        INSERT INTO harness_shared.pot_members
          (workspace_id, pot_home_slug, github_user_id, github_username,
           device_attestations, revoked_pubkeys, binding_status)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${idA.userId}, 'alice',
                ${JSON.stringify([
                  {
                    device_pubkey: idA.devicePubkey,
                    gist_id: 'gist-alice',
                    gist_url: 'https://gist.github.com/alice',
                    device_label: 'alice-dev',
                    created_at: 1,
                    signature_by_device: 'sig',
                  },
                ])}::text::jsonb,
                '{}'::text[], 'verified')
      `;
      // Registry: B's member project points at HIVE_HOME so potHomeSlugForHarness(B)
      // → HIVE_HOME. (A's home + member projects seeded too for symmetry.)
      await mutateHarnessRegistry(
        (r) => ({
          ...r,
          projects: [
            ...r.projects,
            { slug: HIVE_HOME, path: '/tmp/hive-home', harness_kind: 'hive' },
            { slug: A_SLUG, path: '/tmp/a', hive_slug: HIVE_HOME },
            { slug: B_SLUG, path: '/tmp/b', hive_slug: HIVE_HOME },
          ],
        }),
        WORKSPACE_ID,
      );

      // ── Sanity: the SAME getOrgPg()-backed reads STEP 1 makes resolve as expected. ──
      const { potHomeSlugForHarness } = await import('../../../hive-federation');
      const { resolveHiveMemberDeviceSet } = await import('../hive-member-identity-set');
      expect(await potHomeSlugForHarness(WORKSPACE_ID, B_SLUG)).toBe(HIVE_HOME);
      const seededSet = await resolveHiveMemberDeviceSet(WORKSPACE_ID, HIVE_HOME);
      expect(seededSet.has(idA.devicePubkey)).toBe(true);
      _clearHiveMemberDeviceSetCacheForTest(); // drop the sanity-read cache so boot re-reads fresh

      // ── Two SEPARATE per-peer DBs (the projection scope) — each its OWN member slug. ──
      const dbA: FreshPgDb = await createFreshPgDb('wi259A');
      cleanups.push(() => dbA.cleanup());
      const dbB: FreshPgDb = await createFreshPgDb('wi259B');
      cleanups.push(() => dbB.cleanup());
      await setupPeerSchema(dbA.sql, A_SLUG);
      await setupPeerSchema(dbB.sql, B_SLUG);

      // ── Local testnet DHT + two real swarms (mirror the WI-261 case). ──
      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      const swarmA = makeSwarm(testnet.bootstrap);
      const swarmB = makeSwarm(testnet.bootstrap);
      const rootA = makeWorkspaceRoot('wi259-A-');
      const rootB = makeWorkspaceRoot('wi259-B-');

      let handleA: BootedHarnessHandle | undefined;
      let handleB: BootedHarnessHandle | undefined;
      let applyA: ((op: OpEnvelope) => Promise<boolean>) | undefined;
      let applyB: ((op: OpEnvelope) => Promise<boolean>) | undefined;

      // ── Boot A: member slug A_SLUG; REAL scoped apply bound to A's DB + hive-home. ──
      handleA = await bootHarnessSubstrate({
        workspaceRoot: rootA,
        workspaceId: WORKSPACE_ID,
        harnessSlug: A_SLUG,
        swarmBinding: BINDING, // SHARED binding → SHARED topic, independent of member slug
        swarmOverride: swarmA,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idB.userId ? 'verified' : 'fail',
        applyOverride: (op, ctx) => {
          applyA ??= buildHarnessProjectionApply({
            workspaceId: WORKSPACE_ID,
            harnessSlug: A_SLUG,
            potHomeSlug: HIVE_HOME,
            sql: dbA.sql,
            ownLogKeyHex: ctx.ownLogKeyHex,
          });
          return applyA(op);
        },
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idA.override,
      });
      cleanups.push(async () => {
        await handleA?.close();
        await closeHarnessStore({ workspaceRoot: rootA, harnessSlug: A_SLUG });
      });

      // A is fully booted here; capture its key now so B's apply closure reads no handle
      // (WI-6554700010008569 guard: applyOverride closures never read `.ownLog`).
      const aOwnLogKeyHex = handleA.ownLog.keyHex;

      // ── Boot B: DIFFERENT member slug B_SLUG. B is the receiver whose STEP 1 fires:
      //    A's announce (origin=A_SLUG) is out of B's own/rebind scope, so B falls into
      //    `if (!inScope)` and admits A by membership identity. ──
      handleB = await bootHarnessSubstrate({
        workspaceRoot: rootB,
        workspaceId: WORKSPACE_ID,
        harnessSlug: B_SLUG,
        swarmBinding: BINDING,
        swarmOverride: swarmB,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idA.userId ? 'verified' : 'fail',
        applyOverride: (op, ctx) => {
          applyB ??= buildHarnessProjectionApply({
            workspaceId: WORKSPACE_ID,
            harnessSlug: B_SLUG,
            potHomeSlug: HIVE_HOME,
            sql: dbB.sql,
            ownLogKeyHex: ctx.ownLogKeyHex,
            // WI-259 P-002 seam: mirror boot.ts's admit-time map. Boot stamps
            // admittedIdentities[A's log_core_key] = A's device_pubkey (boot.ts:1009) and
            // resolveAuthorDevice reads it back by sourceLogKeyHex (boot.ts:607). A REMOTE
            // op's provenance.authorPubkey IS its receiver-stamped sourceLogKeyHex
            // (projection.ts:266) = A's ownLog.keyHex here; resolving that to A's seeded
            // member device is exactly what the live handle does once it admits A (STEP 1
            // above proves the admit fired, so this map is populated identically in prod).
            resolveAuthorDevice: (k) => (k === aOwnLogKeyHex ? idA.devicePubkey : null),
          });
          return applyB(op);
        },
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idB.override,
      });
      cleanups.push(async () => {
        await handleB?.close();
        await closeHarnessStore({ workspaceRoot: rootB, harnessSlug: B_SLUG });
      });

      // Both joined the SAME topic despite different member slugs (topic ⟵ binding).
      expect(handleA.swarm).not.toBeNull();
      expect(handleB.swarm).not.toBeNull();
      expect(handleA.swarm!.topicHex).toBe(handleB.swarm!.topicHex);

      // ── A writes a member-harness FEATURE under A's slug → real trigger → outbox
      //    → drain → A's own log. ──
      await dbA.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${A_SLUG}, 'F-wi259', 'Member feature', 'from A', 'todo', 0, 'local', 4001, 4001, 4001)
      `;
      expect(await countOutbox(dbA.sql, 'harness_features_consolidated', 'F-wi259')).toBe(1);
      const drainedA = await drainOutboxOnce(handleA, dbA.sql);
      expect(drainedA, "A's F-wi259 was not drained to its log").toBeGreaterThanOrEqual(1);

      // ── (1) THE NEW VALUE: poll until B ADMITS A's remote log via STEP 1. This is the
      //    landed P-001 path — B admits A's out-of-scope log because A's verified
      //    device_pubkey ∈ B's hive member device set (the seeded pot_members). A miss
      //    FAILS the test (a real STEP-1 regression). `handleB.admitted` is keyed by
      //    log_core_key (= ownLog.keyHex), seeded with B's own log + every admitted remote. ──
      const bAdmittedA =
        (await pollUntil(
          async () => {
            await Promise.all([handleA!.mergeNow(), handleB!.mergeNow()]);
            return handleB!.admitted.has(handleA!.ownLog.keyHex) ? true : undefined;
          },
          { timeoutMs: 20_000, intervalMs: 250 },
        )) ?? false;
      expect(
        bAdmittedA,
        "B did NOT admit A's same-hive cross-member log — WI-259 STEP 1 (P-001) membership-aware " +
          'admission did not fire (check the seeded hives/pot_members/registry resolve under getOrgPg())',
      ).toBe(true);

      // ── (2) WI-259 P-002 CLOSE GATE: A's same-hive cross-member feature now LANDS in B's
      //    PG. The op is admitted+replicated (STEP 1 above); B's apply then resolves the op's
      //    unforgeable receiver-stamped sourceLogKeyHex → A's admitted device
      //    (resolveAuthorDevice, mirroring boot.ts:607/1009) and the P-002 guard applies it
      //    because that device ∈ B's hive member device set (resolveHiveMemberDeviceSet over
      //    the seeded pot_members). Content stays under A's MEMBER slug — the membership-aware
      //    design keeps cross-member content addressable by its author's slug, NOT remapped to
      //    B_SLUG or HIVE_HOME. (Was the documented pre-P-002 absence; flipped now P-002 landed.) ──
      for (let i = 0; i < 6; i++) {
        await Promise.all([handleA.mergeNow(), handleB.mergeNow()]);
      }
      expect(
        await readFeatureForSlug(dbB.sql, A_SLUG, 'F-wi259'),
        "A's F-wi259 did NOT cross to B under A's member slug — WI-259 P-002 apply guard " +
          'dropped the admitted cross-member op (check resolveAuthorDevice → member-set membership)',
      ).toBeDefined();
      expect(await readFeatureForSlug(dbB.sql, B_SLUG, 'F-wi259')).toBeUndefined();
      expect(await readFeatureForSlug(dbB.sql, HIVE_HOME, 'F-wi259')).toBeUndefined();
    },
    60_000,
  );

  // ──────────────────────────────────────────────────────────────────────────
  // WI-559 / FED-1 (fed-b→fed-a "discovers 0") — the OWNER-side apply.
  //
  // The WI-259 P-002 case above proves a JOINER (member harness; its potHomeSlug is set via the
  // 2c rebind) applies a cross-member op. It did NOT cover the OTHER direction: the hive OWNER
  // (whose RECEIVING harness IS the hive home) applying a MEMBER's content. Boot's
  // `resolveHiveHomeProjectionSlug` only resolves the JOINER rebind (`joinerPotHomeSlug` → null
  // for an owner), so the owner's home harness ran the 6 content projections with
  // potHomeSlug=undefined → `decideMemberContentOp` returned 'drop' (no-hiveHome) for EVERY
  // cross-member op → fed-b→fed-a "discovers 0". The fix resolves the owner's OWN hive-home (the
  // same way STEP-1 admit's `resolveSameHiveMember` already does: `hiveHomeProjectionSlug ??
  // potHomeSlugForHarness`) and threads it as the content-guard fallback (the admit/apply
  // asymmetry closed).
  //
  // This case is the FAITHFUL proof (the existing cases all hardcode `potHomeSlug` + stub
  // `resolveAuthorDevice` through `applyOverride`, so none exercises boot's REAL resolution). The
  // RECEIVER (the OWNER) boots with the REAL `bootHarnessSubstrate` scopedApply — NO
  // `applyOverride`, NO stubbed `resolveAuthorDevice` — so boot's real
  // `admittedIdentities → resolveAuthorDevice → resolveHiveMemberDeviceSet` chain AND the new
  // owner-home resolution are on the path end-to-end. getOrgPg() is env-routed at the migrated
  // org DB (harness_admin → RLS-bypass), so the owner's real projections write there.
  // PRE-FIX this assertion FAILS (the op is dropped no-hiveHome); POST-FIX it lands.
  // ──────────────────────────────────────────────────────────────────────────
  it(
    'WI-559/FED-1: the OWNER (hive-home) harness APPLIES a member’s cross-member feature via the REAL boot scopedApply — fed-b→fed-a no longer "discovers 0"',
    async () => {
      const HIVE_HOME = 'fed1-owner-home'; // the OWNER's harness slug IS the hive home
      const MEMBER_SLUG = 'fed1-member'; // the author member's slug (≠ the home)

      // ── Env-route getOrgPg() at a migrated org DB: the OWNER's REAL scopedApply writes here
      //    (getOrgPg = harness_admin, RLS-bypass) AND boot's STEP-1 + guard reads resolve here. ──
      const orgDb: OrgTestDb = await createOrgTestDb();
      const prevAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
      const prevAppUrl = process.env.HARNESS_DATABASE_URL;
      const prevWs = process.env.PAPERCUSP_WORKSPACE_ID;
      const prevSkipDisc = process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
      const prevPgb = process.env.PAPERCUSP_PGBOUNCER;
      process.env.HARNESS_ADMIN_DATABASE_URL = orgDb.adminDsn;
      process.env.HARNESS_DATABASE_URL = orgDb.appDsn;
      process.env.PAPERCUSP_WORKSPACE_ID = WORKSPACE_ID;
      process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
      // pgbouncer default-on on a server-class host rewrites the getOrgPg URL → :6432 (native PG),
      // bypassing this throwaway testcontainer DB — force the documented kill-switch OFF.
      process.env.PAPERCUSP_PGBOUNCER = '0';
      _resetUrlCacheForTests();
      _resetHarnessAdminUrlCacheForTests();
      await resetDbOrgPools();
      _clearHiveMemberDeviceSetCacheForTest();
      cleanups.push(async () => {
        if (prevAdminUrl === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
        else process.env.HARNESS_ADMIN_DATABASE_URL = prevAdminUrl;
        if (prevAppUrl === undefined) delete process.env.HARNESS_DATABASE_URL;
        else process.env.HARNESS_DATABASE_URL = prevAppUrl;
        if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
        else process.env.PAPERCUSP_WORKSPACE_ID = prevWs;
        if (prevSkipDisc === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
        else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = prevSkipDisc;
        if (prevPgb === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
        else process.env.PAPERCUSP_PGBOUNCER = prevPgb;
        _resetUrlCacheForTests();
        _resetHarnessAdminUrlCacheForTests();
        _clearHiveMemberDeviceSetCacheForTest();
        await resetDbOrgPools();
        await orgDb?.cleanup();
      });

      const idOwner = makeIdentityOverride('owner', 99, 'kc-owner');
      const idMember = makeIdentityOverride('member', 7, 'kc-member');

      // ── Seed the hive + the MEMBER's membership in the org DB. getHiveBySlug(HIVE_HOME) truthy
      //    ⇒ potHomeSlugForHarness(HIVE_HOME) === HIVE_HOME ⇒ the owner-home fallback engages. ──
      const { publicKey: hivePub } = generateKeyPairSync('ed25519');
      const hivePubkeyB64 = rawPubkeyBase64(hivePub);
      await orgDb.adminSql`
        INSERT INTO harness_shared.pots
          (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, decode(${hivePubkeyB64}, 'base64'),
                'kc-owner-home', 'Owner Home', null, 1, 1)
      `;
      await orgDb.adminSql`
        INSERT INTO harness_shared.pot_members
          (workspace_id, pot_home_slug, github_user_id, github_username,
           device_attestations, revoked_pubkeys, binding_status)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${idMember.userId}, 'member',
                ${JSON.stringify([
                  {
                    device_pubkey: idMember.devicePubkey,
                    gist_id: 'gist-member',
                    gist_url: 'https://gist.github.com/member',
                    device_label: 'member-dev',
                    created_at: 1,
                    signature_by_device: 'sig',
                  },
                ])}::text::jsonb,
                '{}'::text[], 'verified')
      `;
      await mutateHarnessRegistry(
        (r) => ({
          ...r,
          projects: [
            ...r.projects,
            { slug: HIVE_HOME, path: '/tmp/owner-home', harness_kind: 'hive' },
            { slug: MEMBER_SLUG, path: '/tmp/member', hive_slug: HIVE_HOME },
          ],
        }),
        WORKSPACE_ID,
      );

      // Sanity: the owner-home resolution + member set resolve as the fix relies on.
      const { potHomeSlugForHarness } = await import('../../../hive-federation');
      const { resolveHiveMemberDeviceSet } = await import('../hive-member-identity-set');
      expect(await potHomeSlugForHarness(WORKSPACE_ID, HIVE_HOME)).toBe(HIVE_HOME);
      expect((await resolveHiveMemberDeviceSet(WORKSPACE_ID, HIVE_HOME)).has(idMember.devicePubkey)).toBe(
        true,
      );
      _clearHiveMemberDeviceSetCacheForTest();

      // The MEMBER author's per-peer DB (its content origin) + its own member slug.
      const dbMember: FreshPgDb = await createFreshPgDb('fed1member');
      cleanups.push(() => dbMember.cleanup());
      await setupPeerSchema(dbMember.sql, MEMBER_SLUG);

      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      const swarmOwner = makeSwarm(testnet.bootstrap);
      const swarmMember = makeSwarm(testnet.bootstrap);
      const rootOwner = makeWorkspaceRoot('fed1-owner-');
      const rootMember = makeWorkspaceRoot('fed1-member-');

      let handleOwner: BootedHarnessHandle | undefined;
      let handleMember: BootedHarnessHandle | undefined;
      let applyMember: ((op: OpEnvelope) => Promise<boolean>) | undefined;

      // ── Boot the OWNER: harnessSlug = the hive home; NO applyOverride → the REAL boot scopedApply
      //    (getOrgPg → orgDb). This is what exercises the owner-home potHomeSlug fallback. ──
      handleOwner = await bootHarnessSubstrate({
        workspaceRoot: rootOwner,
        workspaceId: WORKSPACE_ID,
        harnessSlug: HIVE_HOME,
        // A real shared OWNER is on the hive topic (kind:'hive') — NOT a private 'local' binding;
        // this is what makes `bindingResolvesHiveHomeProjection` true so the owner-home fallback
        // (boot.ts ownPotHomeSlug) engages. Both peers derive the SAME topic from this pubkey.
        swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
        swarmOverride: swarmOwner,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idMember.userId ? 'verified' : 'fail',
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idOwner.override,
      });
      cleanups.push(async () => {
        await handleOwner?.close();
        await closeHarnessStore({ workspaceRoot: rootOwner, harnessSlug: HIVE_HOME });
      });

      // ── Boot the MEMBER author: its own slug + per-peer apply (its content origin). ──
      handleMember = await bootHarnessSubstrate({
        workspaceRoot: rootMember,
        workspaceId: WORKSPACE_ID,
        harnessSlug: MEMBER_SLUG,
        // Same hive topic as the owner (same pubkey) so they peer; the member is a JOINER, so its
        // own-home fallback resolves undefined (member slug ≠ its hive home) — it uses applyOverride.
        swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
        swarmOverride: swarmMember,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idOwner.userId ? 'verified' : 'fail',
        applyOverride: (op, ctx) => {
          applyMember ??= buildPeerApply(dbMember.sql, ctx.ownLogKeyHex);
          return applyMember(op);
        },
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idMember.override,
      });
      cleanups.push(async () => {
        await handleMember?.close();
        await closeHarnessStore({ workspaceRoot: rootMember, harnessSlug: MEMBER_SLUG });
      });

      expect(handleOwner.swarm).not.toBeNull();
      expect(handleMember.swarm).not.toBeNull();
      expect(handleOwner.swarm!.topicHex).toBe(handleMember.swarm!.topicHex);

      // ── The MEMBER writes a feature under its own slug → real trigger → outbox → drain → log. ──
      await dbMember.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${MEMBER_SLUG}, 'F-fed1', 'Member→owner feature', 'from member', 'todo', 0, 'local', 5001, 5001, 5001)
      `;
      expect(await countOutbox(dbMember.sql, 'harness_features_consolidated', 'F-fed1')).toBe(1);
      const drained = await drainOutboxOnce(handleMember, dbMember.sql);
      expect(drained, "the member's F-fed1 was not drained to its log").toBeGreaterThanOrEqual(1);

      // ── Precondition: the OWNER ADMITS the member's log (STEP-1 by membership identity). ──
      const ownerAdmittedMember =
        (await pollUntil(
          async () => {
            await Promise.all([handleOwner!.mergeNow(), handleMember!.mergeNow()]);
            return handleOwner!.admitted.has(handleMember!.ownLog.keyHex) ? true : undefined;
          },
          { timeoutMs: 20_000, intervalMs: 250 },
        )) ?? false;
      expect(
        ownerAdmittedMember,
        "the owner did NOT admit the member's log — STEP-1 membership admission did not fire " +
          '(seeded hives/pot_members/registry must resolve under getOrgPg())',
      ).toBe(true);

      // ── THE PROOF: the member's cross-member feature LANDS in the owner's PG (getOrgPg/orgDb)
      //    under the MEMBER's slug. PRE-FIX the owner's scopedApply ran potHomeSlug=undefined and
      //    dropped it (no-hiveHome); POST-FIX the owner-home fallback engages the membership guard
      //    (member device ∈ members) and applies it. ──
      const landed = await pollUntil(
        async () => {
          await Promise.all([handleOwner!.mergeNow(), handleMember!.mergeNow()]);
          return await readFeatureForSlug(orgDb.adminSql, MEMBER_SLUG, 'F-fed1');
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(
        landed,
        "the member's feature never reached the OWNER's PG — WI-559/FED-1: the owner's home harness " +
          'dropped the admitted cross-member op (owner-home potHomeSlug fallback not engaged)',
      ).toBeTruthy();
      expect(landed).toMatchObject({
        feature_id: 'F-fed1',
        title: 'Member→owner feature',
        status: 'todo',
        origin: 'remote',
      });
    },
    60_000,
  );

  // ──────────────────────────────────────────────────────────────────────────
  // EI-3417 (WI-259 STEP-2 follow-up) — the JOINER-side real-path sibling to WI-559/FED-1.
  //
  // WI-559/FED-1 (above) proved the OWNER (hive-home) harness applies a member's cross-member
  // content via boot's REAL scopedApply. The WI-259 P-001+P-002 case (above) proves a JOINER
  // (non-home member) applies a same-hive peer's cross-member content too — but ONLY through a
  // STUBBED path: B boots with `applyOverride` hardcoding `potHomeSlug: HIVE_HOME` and stubbing
  // `resolveAuthorDevice`, so boot's own `resolveHiveHomeProjectionSlug` (the `joinerPotHomeSlug`
  // remote_hive-registry resolution) and its real `admittedIdentities → resolveAuthorDevice` map
  // are NEVER exercised for a genuine joiner. That blind spot is exactly the class that let the
  // FED-1 owner-side bug ship green — the equivalent gap on the joiner side was unproven, not
  // fixed.
  //
  // This case closes it: B (the receiver) boots with NO `applyOverride` — the REAL
  // `bootHarnessSubstrate` scopedApply — and the registry marks HIVE_HOME `remote_hive: true`
  // (a JOINED, not owned, hive-home), which is what makes `joinerPotHomeSlug`
  // (hive-federation.ts:155) resolve non-null for B and engages the real rebind
  // `resolveHiveHomeProjectionSlug` (boot.ts:901) performs on a `hive`/`topic` swarm binding. B's
  // own `admittedIdentities`/`resolveAuthorDevice` (populated by the REAL STEP-1 admit, not a
  // test stub) then gate the P-002 apply. getOrgPg() is env-routed at the migrated org DB, so B's
  // real projections (and the STEP-1 membership read) both hit it — the production single-PG
  // shape, same as the FED-1 case.
  // ──────────────────────────────────────────────────────────────────────────
  it(
    'EI-3417: the JOINER (remote_hive member, real rebind) applies a same-hive peer’s cross-member feature via the REAL boot scopedApply — no applyOverride, no resolveAuthorDevice stub',
    async () => {
      const HIVE_HOME = 'ei3417-hive-home'; // the JOINED (remote_hive) hive-home both members rebind to
      const A_SLUG = 'ei3417-author-a'; // the author member's own slug (content origin)
      const B_SLUG = 'ei3417-joiner-b'; // the RECEIVER — a genuine joiner, real rebind, real apply

      // ── Env-route getOrgPg() at a migrated org DB: B's REAL scopedApply writes here
      //    (getOrgPg = harness_admin, RLS-bypass) AND boot's STEP-1 + guard reads resolve here. ──
      const orgDb: OrgTestDb = await createOrgTestDb();
      const prevAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
      const prevAppUrl = process.env.HARNESS_DATABASE_URL;
      const prevWs = process.env.PAPERCUSP_WORKSPACE_ID;
      const prevSkipDisc = process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
      const prevPgb = process.env.PAPERCUSP_PGBOUNCER;
      process.env.HARNESS_ADMIN_DATABASE_URL = orgDb.adminDsn;
      process.env.HARNESS_DATABASE_URL = orgDb.appDsn;
      process.env.PAPERCUSP_WORKSPACE_ID = WORKSPACE_ID;
      process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
      // pgbouncer default-on on a server-class host rewrites the getOrgPg URL → :6432 (native PG),
      // bypassing this throwaway testcontainer DB — force the documented kill-switch OFF.
      process.env.PAPERCUSP_PGBOUNCER = '0';
      _resetUrlCacheForTests();
      _resetHarnessAdminUrlCacheForTests();
      await resetDbOrgPools();
      _clearHiveMemberDeviceSetCacheForTest();
      cleanups.push(async () => {
        if (prevAdminUrl === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
        else process.env.HARNESS_ADMIN_DATABASE_URL = prevAdminUrl;
        if (prevAppUrl === undefined) delete process.env.HARNESS_DATABASE_URL;
        else process.env.HARNESS_DATABASE_URL = prevAppUrl;
        if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
        else process.env.PAPERCUSP_WORKSPACE_ID = prevWs;
        if (prevSkipDisc === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
        else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = prevSkipDisc;
        if (prevPgb === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
        else process.env.PAPERCUSP_PGBOUNCER = prevPgb;
        _resetUrlCacheForTests();
        _resetHarnessAdminUrlCacheForTests();
        _clearHiveMemberDeviceSetCacheForTest();
        await resetDbOrgPools();
        await orgDb?.cleanup();
      });

      const idA = makeIdentityOverride('alice', 42, 'kc-alice');
      const idB = makeIdentityOverride('bob', 7, 'kc-bob');

      // ── Seed the hive + A's membership in the org DB (same shape as the P-002/FED-1 cases). ──
      const { publicKey: hivePub } = generateKeyPairSync('ed25519');
      const hivePubkeyB64 = rawPubkeyBase64(hivePub);
      await orgDb.adminSql`
        INSERT INTO harness_shared.pots
          (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, decode(${hivePubkeyB64}, 'base64'),
                'kc-ei3417-home', 'EI-3417 Hive Home', null, 1, 1)
      `;
      await orgDb.adminSql`
        INSERT INTO harness_shared.pot_members
          (workspace_id, pot_home_slug, github_user_id, github_username,
           device_attestations, revoked_pubkeys, binding_status)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${idA.userId}, 'alice',
                ${JSON.stringify([
                  {
                    device_pubkey: idA.devicePubkey,
                    gist_id: 'gist-alice',
                    gist_url: 'https://gist.github.com/alice',
                    device_label: 'alice-dev',
                    created_at: 1,
                    signature_by_device: 'sig',
                  },
                ])}::text::jsonb,
                '{}'::text[], 'verified')
      `;
      // Registry: HIVE_HOME is `remote_hive: true` — a JOINED view, NOT owned — which is what
      // makes `joinerPotHomeSlug` (hive-federation.ts:155) resolve non-null for B. Both members
      // point their `hive_slug` at it, mirroring a real from-repo join.
      await mutateHarnessRegistry(
        (r) => ({
          ...r,
          projects: [
            ...r.projects,
            { slug: HIVE_HOME, path: '/tmp/ei3417-home', harness_kind: 'hive', remote_hive: true },
            { slug: A_SLUG, path: '/tmp/ei3417-a', hive_slug: HIVE_HOME },
            { slug: B_SLUG, path: '/tmp/ei3417-b', hive_slug: HIVE_HOME },
          ],
        }),
        WORKSPACE_ID,
      );

      // ── Sanity: B's REAL rebind resolves — the exact chain boot.ts:901 drives at boot. ──
      const { joinerPotHomeSlug } = await import('../../../hive-federation');
      expect(await joinerPotHomeSlug(WORKSPACE_ID, B_SLUG, { fresh: true })).toBe(HIVE_HOME);
      const { resolveHiveMemberDeviceSet } = await import('../hive-member-identity-set');
      expect((await resolveHiveMemberDeviceSet(WORKSPACE_ID, HIVE_HOME)).has(idA.devicePubkey)).toBe(
        true,
      );
      _clearHiveMemberDeviceSetCacheForTest();

      // A's own per-peer DB (its content origin) — A still uses the applyOverride seam (this
      // case is about proving B's real path, not A's).
      const dbA: FreshPgDb = await createFreshPgDb('ei3417A');
      cleanups.push(() => dbA.cleanup());
      await setupPeerSchema(dbA.sql, A_SLUG);

      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      const swarmA = makeSwarm(testnet.bootstrap);
      const swarmB = makeSwarm(testnet.bootstrap);
      const rootA = makeWorkspaceRoot('ei3417-A-');
      const rootB = makeWorkspaceRoot('ei3417-B-');

      let handleA: BootedHarnessHandle | undefined;
      let handleB: BootedHarnessHandle | undefined;
      let applyA: ((op: OpEnvelope) => Promise<boolean>) | undefined;

      // ── Boot A: member slug A_SLUG; applyOverride → its own per-peer DB (content origin only —
      //    NOT the thing under test). Same hive topic as B (shared hive_pubkey). ──
      handleA = await bootHarnessSubstrate({
        workspaceRoot: rootA,
        workspaceId: WORKSPACE_ID,
        harnessSlug: A_SLUG,
        swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
        swarmOverride: swarmA,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idB.userId ? 'verified' : 'fail',
        applyOverride: (op, ctx) => {
          applyA ??= buildHarnessProjectionApply({
            workspaceId: WORKSPACE_ID,
            harnessSlug: A_SLUG,
            potHomeSlug: HIVE_HOME,
            sql: dbA.sql,
            ownLogKeyHex: ctx.ownLogKeyHex,
          });
          return applyA(op);
        },
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idA.override,
      });
      cleanups.push(async () => {
        await handleA?.close();
        await closeHarnessStore({ workspaceRoot: rootA, harnessSlug: A_SLUG });
      });

      // ── Boot B: the JOINER under test. NO applyOverride — boot's REAL scopedApply
      //    (getOrgPg → orgDb), real hiveHomeProjectionSlug rebind, real resolveAuthorDevice. ──
      handleB = await bootHarnessSubstrate({
        workspaceRoot: rootB,
        workspaceId: WORKSPACE_ID,
        harnessSlug: B_SLUG,
        swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
        swarmOverride: swarmB,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idA.userId ? 'verified' : 'fail',
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idB.override,
      });
      cleanups.push(async () => {
        await handleB?.close();
        await closeHarnessStore({ workspaceRoot: rootB, harnessSlug: B_SLUG });
      });

      expect(handleA.swarm).not.toBeNull();
      expect(handleB.swarm).not.toBeNull();
      expect(handleA.swarm!.topicHex).toBe(handleB.swarm!.topicHex);

      // ── A writes a member feature under its own slug → real trigger → outbox → drain → log. ──
      await dbA.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${A_SLUG}, 'F-ei3417', 'Joiner-received feature', 'from A', 'todo', 0, 'local', 6001, 6001, 6001)
      `;
      expect(await countOutbox(dbA.sql, 'harness_features_consolidated', 'F-ei3417')).toBe(1);
      const drainedA = await drainOutboxOnce(handleA, dbA.sql);
      expect(drainedA, "A's F-ei3417 was not drained to its log").toBeGreaterThanOrEqual(1);

      // ── (1) B ADMITS A's log via REAL STEP-1 membership admission (no test stub involved). ──
      const bAdmittedA =
        (await pollUntil(
          async () => {
            await Promise.all([handleA!.mergeNow(), handleB!.mergeNow()]);
            return handleB!.admitted.has(handleA!.ownLog.keyHex) ? true : undefined;
          },
          { timeoutMs: 20_000, intervalMs: 250 },
        )) ?? false;
      expect(
        bAdmittedA,
        "B did NOT admit A's same-hive cross-member log — STEP 1 membership-aware admission did " +
          'not fire (check the seeded hives/pot_members/registry resolve under getOrgPg())',
      ).toBe(true);

      // ── (2) THE PROOF: A's cross-member feature LANDS in B's real PG (getOrgPg/orgDb) under
      //    A's slug — B's REAL rebind (joinerPotHomeSlug) + REAL resolveAuthorDevice (populated
      //    by the real STEP-1 admit) drove the P-002 guard end-to-end, no test seam involved. ──
      const landed = await pollUntil(
        async () => {
          await Promise.all([handleA!.mergeNow(), handleB!.mergeNow()]);
          return await readFeatureForSlug(orgDb.adminSql, A_SLUG, 'F-ei3417');
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(
        landed,
        "A's feature never reached the JOINER's real PG — EI-3417: B's real rebind/apply chain " +
          'dropped the admitted cross-member op',
      ).toBeTruthy();
      expect(landed).toMatchObject({
        feature_id: 'F-ei3417',
        title: 'Joiner-received feature',
        status: 'todo',
        origin: 'remote',
      });
      // Content stays addressable under A's member slug, not remapped to B or the home.
      expect(await readFeatureForSlug(orgDb.adminSql, B_SLUG, 'F-ei3417')).toBeUndefined();
      expect(await readFeatureForSlug(orgDb.adminSql, HIVE_HOME, 'F-ei3417')).toBeUndefined();
    },
    60_000,
  );

  // ──────────────────────────────────────────────────────────────────────────
  // WI-259 P-004 — CONTENT-BEFORE-MEMBERSHIP defer / replay (the capstone).
  //
  // A member A's content op and A's `pot_members` row federate as SEPARATE ops, and the merge
  // applies ops by LOG POSITION, not a global cross-table sort — so on peer B a cross-member
  // content op can reach the apply seam BEFORE the `pot_members` op that adds its author. The
  // P-002 membership guard then sees A ∉ members and would DROP it, and the cursor advances past
  // it → lost. P-004 DEFERS such an op (author device known, just not yet a member) into the
  // PendingMembershipContent buffer and RE-APPLIES it when A's `pot_members` row applies (the
  // onMemberApplied drain in projections/hive-members.ts).
  //
  // The full two-peer swarm rig (the cases above) CANNOT exercise this: there membership is
  // pre-seeded in PG, so the `pot_members` projection apply — which FIRES the drain — never runs
  // for A. This case drives the REAL projections (issues + pot_members) + the REAL buffer + the
  // REAL drain hook directly, over ONE migrated workspace PG (production's single-PG shape: the
  // guard's getOrgPg membership read and the pot_members write hit the SAME DB), so the ordering
  // is deterministic and every real seam (decideMemberContentOp → defer → invalidate → drain →
  // re-apply → resolveHiveMemberDeviceSet) is on the path.
  // ──────────────────────────────────────────────────────────────────────────
  it(
    'WI-259 P-004: a cross-member content op arriving BEFORE the author’s membership is DEFERRED, then DRAINS + lands when the member’s pot_members row applies',
    async () => {
      const HIVE_HOME = 'hive-home-p004';
      const B_SLUG = 'joined-member-b'; // the receiving member harness (≠ A's author slug)
      const A_SLUG = 'author-member-a'; // the (cross-member) slug A's content is authored under
      const A_LOG_KEY = 'a-source-log-key-hex-p004'; // A's receiver-stamped sourceLogKeyHex
      const idA = makeIdentityOverride('alice', 42, 'kc-alice'); // → idA.devicePubkey + userId

      // ── Env-route the PROCESS-GLOBAL getOrgPg() at a migrated workspace DB so the guard's
      //    resolveHiveMemberDeviceSet read AND the projections' writes hit ONE DB (prod shape). ──
      const orgDb: OrgTestDb = await createOrgTestDb();
      const prevAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
      const prevAppUrl = process.env.HARNESS_DATABASE_URL;
      const prevWs = process.env.PAPERCUSP_WORKSPACE_ID;
      const prevSkipDisc = process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
      const prevPgb = process.env.PAPERCUSP_PGBOUNCER;
      process.env.HARNESS_ADMIN_DATABASE_URL = orgDb.adminDsn;
      process.env.HARNESS_DATABASE_URL = orgDb.appDsn;
      process.env.PAPERCUSP_WORKSPACE_ID = WORKSPACE_ID;
      process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
      // backend-connection-scaling-2026-06-17: on a SERVER-class host (the dev box) pgbouncerEnabled()
      // is DEFAULT-ON, so maybePgbouncer() rewrites EVERY org-pool URL's host to 127.0.0.1:6432 — which
      // fronts the NATIVE PG, NOT this throwaway testcontainer DB the env routes getOrgPg at. That makes
      // the getOrgPg-backed membership read (resolveHiveMemberDeviceSet) hit :6432 → "no such database:
      // org_…". Force the documented kill-switch OFF so getOrgPg honours the env DSN's testcontainer port.
      process.env.PAPERCUSP_PGBOUNCER = '0';
      _resetUrlCacheForTests();
      _resetHarnessAdminUrlCacheForTests();
      await resetDbOrgPools();
      _clearHiveMemberDeviceSetCacheForTest();
      cleanups.push(async () => {
        if (prevAdminUrl === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
        else process.env.HARNESS_ADMIN_DATABASE_URL = prevAdminUrl;
        if (prevAppUrl === undefined) delete process.env.HARNESS_DATABASE_URL;
        else process.env.HARNESS_DATABASE_URL = prevAppUrl;
        if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
        else process.env.PAPERCUSP_WORKSPACE_ID = prevWs;
        if (prevSkipDisc === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
        else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = prevSkipDisc;
        if (prevPgb === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
        else process.env.PAPERCUSP_PGBOUNCER = prevPgb;
        _resetUrlCacheForTests();
        _resetHarnessAdminUrlCacheForTests();
        _clearHiveMemberDeviceSetCacheForTest();
        await resetDbOrgPools();
        await orgDb?.cleanup();
      });

      // Seed the hive row (pot_members FKs it; needs a valid raw-32 base64 Ed25519 pubkey).
      // NOT A's pot_members row yet — that arrives in step (2), the whole point of the race.
      const { publicKey: hivePub } = generateKeyPairSync('ed25519');
      const hivePubkeyB64 = rawPubkeyBase64(hivePub);
      await orgDb.adminSql`
        INSERT INTO harness_shared.pots
          (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, decode(${hivePubkeyB64}, 'base64'),
                'kc-hive-home', 'Hive Home', null, 1, 1)
      `;

      // ── The REAL projections, bound to the SAME workspace DB + the SAME buffer instance (exactly
      //    as boot.ts wires them: the content projection defers, the pot_members projection drains). ──
      const buffer = new PendingMembershipContent();
      const issuesProj = buildIssuesProjection({
        workspaceId: WORKSPACE_ID,
        harnessSlug: B_SLUG, // B applies A's cross-member op only if A ∈ members
        sql: orgDb.adminSql,
        potHomeSlug: HIVE_HOME,
        // A REMOTE op's provenance.authorPubkey IS its receiver-stamped sourceLogKeyHex; boot maps
        // it → A's admit-verified device via admittedIdentities (boot.ts:607). Mirror that here.
        resolveAuthorDevice: (k) => (k === A_LOG_KEY ? idA.devicePubkey : null),
        pendingMemberContent: buffer,
      });
      const membersProj = buildHiveMembersProjection({
        workspaceId: WORKSPACE_ID,
        harnessSlug: HIVE_HOME, // the pot_members projection demuxes on the hive-home slug
        sql: orgDb.adminSql,
        pendingMemberContent: buffer, // shares the buffer → its apply drains the deferred content
      });

      const aIssue: HarnessIssueRow = {
        harness_slug: A_SLUG, // cross-member: ≠ B_SLUG → membership-gated
        issue_id: 'I-defer',
        title: 'A pre-membership issue',
        severity: 'major', // harness_issues_consolidated_severity_check: critical|major|minor|nit (mig 130)
        source: 'system', // harness_issues_consolidated_source_check: validator|worker|human|system (mig 130)
        status: 'open',
        found_at: 7000,
        found_during: null,
        repro: null,
        evidence: null,
        suggested_fix: null,
        code_pointer: null,
        linked_feature_id: null,
        attempts: 0,
        notes: [],
        created_ts: 7000,
        updated_ts: 7000,
      };
      const aIssueProv: ProvenanceContext = {
        authorPubkey: A_LOG_KEY,
        origin: 'remote',
        ts: 7000,
        fedHlc: 'hlc-issue-7000',
      };

      // ── (1) A's issue arrives BEFORE A's membership → the guard DEFERS it (author device known,
      //    but A ∉ the empty member set). It is NOT applied, and NOT lost — it sits in the buffer. ──
      _clearHiveMemberDeviceSetCacheForTest();
      await issuesProj.writeToPg(aIssue, aIssueProv);
      expect(
        await readIssueForSlug(orgDb.adminSql, A_SLUG, 'I-defer'),
        'a cross-member op whose author is not yet a member must NOT apply (it should defer)',
      ).toBeUndefined();
      expect(buffer.size(), 'the dropped cross-member op must be buffered, not lost').toBe(1);

      // ── (2) A's pot_members row applies → the onMemberApplied DRAIN re-applies the deferred issue.
      //    The projection apply invalidates the member-set cache (so the re-check reads fresh) THEN
      //    drains the buffer for A's device + re-runs the deferred writeToPg, which now sees A ∈
      //    members and applies it. This is the P-004 fix the swarm rig can't reach. ──
      const aMember: HiveMemberRow = {
        pot_home_slug: HIVE_HOME,
        github_user_id: idA.userId,
        github_username: 'alice',
        device_attestations: [
          {
            device_pubkey: idA.devicePubkey,
            gist_id: 'gist-alice',
            gist_url: 'https://gist.github.com/alice',
            device_label: 'alice-dev',
            created_at: 1,
            signature_by_device: 'sig',
          },
        ],
        revoked_pubkeys: [],
        binding_status: 'verified',
      };
      await membersProj.writeToPg(aMember, {
        authorPubkey: '',
        origin: 'remote',
        ts: 8000,
        fedHlc: 'hlc-member-8000',
      });

      expect(buffer.size(), 'the deferred op should have drained on the member apply').toBe(0);
      const landed = await readIssueForSlug(orgDb.adminSql, A_SLUG, 'I-defer');
      expect(
        landed,
        "the deferred cross-member issue did NOT land after A's membership federated — the P-004 " +
          'drain (onMemberApplied → drainForDevices → re-apply) did not fire / re-check fresh membership',
      ).toBeDefined();
      expect(landed).toMatchObject({
        issue_id: 'I-defer',
        title: 'A pre-membership issue',
        severity: 'major',
        status: 'open',
        origin: 'remote',
      });

      // ── (3) A genuine NON-member's deferred op is NOT resurrected by an UNRELATED member apply
      //    (the drain is device-targeted) and expires via the buffer TTL — the bounded-buffer
      //    guarantee (D-007 point 2) that keeps non-member content from lingering forever. ──
      const ghostIssue: HarnessIssueRow = { ...aIssue, issue_id: 'I-ghost', harness_slug: 'never-a-member' };
      await issuesProj.writeToPg(
        { ...ghostIssue },
        { authorPubkey: 'ghost-log-key', origin: 'remote', ts: 9000, fedHlc: 'hlc-ghost-9000' },
      );
      // resolveAuthorDevice('ghost-log-key') → null, so the guard can't confirm an identity yet.
      // WI-1632: this is no longer a permanent drop; the op is buffered by source-log key and
      // retried when admission later records sourceLogKey → device. If admission never catches up,
      // the same TTL backstop evicts it.
      expect(buffer.size(), 'an op with a source-log key but unresolved identity must be buffered').toBe(1);
      expect(await readIssueForSlug(orgDb.adminSql, 'never-a-member', 'I-ghost')).toBeUndefined();
      expect(buffer.sweepExpired(Date.now() + DEFAULT_MEMBER_CONTENT_TTL_MS + 1)).toBe(1);
      expect(buffer.size()).toBe(0);
    },
    60_000,
  );
});
