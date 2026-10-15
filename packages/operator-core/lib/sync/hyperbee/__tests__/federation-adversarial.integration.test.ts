/**
 * federation-adversarial.integration.test.ts — coordination-test-suite-2026-06-08
 * P-009 (federation data-plane ADVERSARIAL coverage, C2/C3).
 *
 * The sibling federation tests prove the happy path (a write on A reaches B). This
 * one is the adversarial complement over the SAME real two-peer testnet-DHT harness
 * (`createTestnet` + two `bootHarnessSubstrate` peers + real Ed25519 announces — the
 * exact boot+replication pattern copied from `hive-two-peer-federation.test.ts` and
 * `feature-content-federation.integration.test.ts`). It asserts the Model-B peer-log
 * federation SEAMS hold under hostile inputs:
 *
 *   1. NO LOSS — Track A content (a feature + a coord-message op) written on peer A's
 *      OWN log round-trips to peer B over the real Hyperswarm transport (the core
 *      no-cross-instance-loss assertion; `applyOverride` capture, no PG).
 *
 *   2. WRONG tableTag is SILENTLY DROPPED — an op whose `table` is the raw
 *      `harness_*_consolidated` table_NAME instead of the registered projection
 *      `tableTag` ('features-by-id') does NOT project, while the correctly-tagged
 *      sibling DOES. This pins the `feature-issue-op-keys.ts` invariant (LocalWriteOp.table
 *      MUST be the projection tableTag) THROUGH THE REAL `applyOpVia` dispatch + a real
 *      PG projection on the RECEIVING peer — so a regression that mismaps a table is
 *      caught (a missing row), not swallowed. A direct dispatch assertion nails the
 *      `applyOpVia → false` drop too.
 *
 *   3. ADMISSION + REVOCATION gate WHO federates — a peer B conclusively REJECTS
 *      (`verifyBindingOverride → 'fail'`) never admits A's log, so A's content does NOT
 *      cross; the admitted control case DOES. Then a mid-session published revocation
 *      (mutable `loadRevokedOverride`, refreshed every mergeNow) drops the admitted
 *      peer's log so NEW content from the revoked peer no longer projects. (The pure
 *      `resolveHiveSwarmBinding` private-stays-local gate is fully covered by
 *      `lib/hive-federation.test.ts`; not re-proven here.)
 *
 *   4. NO DUPLICATION — one logical op replicated + merged TWICE yields exactly ONE
 *      PG row on the receiver (the projection's keyed upsert is idempotent), so a
 *      re-merge can't amplify a row across instances.
 *
 * Proof boundary: REAL corestores/logs, REAL Hyperswarm/Noise over a local testnet
 * DHT, REAL announce signature verification, REAL `applyOpVia` dispatch, and REAL PG
 * projections bound to per-peer throwaway databases for the cells that assert "a PG
 * row". STOOD-IN (offline-deterministic, exactly as every sibling): the channel-2
 * GitHub-binding fetch → `verifyBindingOverride`.
 *
 * Resource hygiene: every handle/swarm/testnet/db/dir is torn down newest-first in
 * afterEach so a thrown assertion can never leak a DHT node (which would hang the run).
 *
 * NOTE: this file does NOT touch the cross-machine kill-authority deployment E2E
 * (`lib/deployment/hive-cross-machine.integration.test.ts`, owned by another agent) —
 * its scope is the federation DATA plane (content → projection → PG; admission), not
 * the Track-B claim-authority dispatch.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import {
  bootHarnessSubstrate as bootHarnessSubstrateImpl,
  type BootedHarnessHandle,
  type BootHarnessOpts,
} from '../boot';
import { type HyperswarmLike } from '../swarm';
import type { OpEnvelope } from '../op-envelope-types';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';
import { _resetBootHistoryForTests } from '../boot-history';
import {
  applyOpVia,
  type ProjectionLookup,
  type TableProjection,
} from '../projection';
import { buildHarnessFeaturesProjection } from '../projections/harness-features';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, SUBSTRATE_OUTBOX_DDL } from '../../../../test/_work-items-schema';

// These unregistered local peers have no owner Hive policy. Inject that
// definitive result at the existing policy-store seam for EVERY merge pass.
// The real projection clients below still use their per-peer throwaway DBs;
// production policy lookup and the protected-live-PG guard remain fail-closed.
vi.mock('../../../hive-policy-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../hive-policy-store')>(),
  getHivePolicyCached: vi.fn(async () => null),
}));

/**
 * These fake local peers exercise transport, admission and explicit projection
 * clients, without a registered Hive or epoch-key source. Use the existing boot
 * seam so every peer stays independent of the production Hive registry/PG pool.
 * Production re-key lookup still fails closed; epoch encryption has its own suite.
 */
function bootHarnessSubstrate(opts: BootHarnessOpts) {
  return bootHarnessSubstrateImpl({ rekeyDepsOverride: null, ...opts });
}

// ── Shared identity / swarm constants. Same binding on both peers → same topic. ──
const WORKSPACE_ID = 'ws-fed-adversarial';
const HARNESS_SLUG = 'fed-adv';
const BINDING = {
  kind: 'local' as const,
  workspace_id: WORKSPACE_ID,
  harness_slug: HARNESS_SLUG,
};
// The two registered projection tableTags this file exercises (the CORRECT keys
// `feature-issue-op-keys.ts` maps the raw table_names onto). See test 2.
const FEATURE_TAG = 'features-by-id';
const RAW_FEATURE_TABLE = 'harness_features_consolidated';

// ── Async resource teardown (newest-first). ──
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      // best-effort — a thrown assertion must never leak a swarm/dir/db/DHT node
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
 *  self-generated Ed25519 keypair (no OS keychain / gh) — mirrors every sibling. */
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

async function makeTestnet() {
  const testnet = await createTestnet(3);
  cleanups.push(async () => {
    try {
      await testnet.destroy();
    } catch {
      /* ignore */
    }
  });
  return testnet;
}

// ── Real-PG projection wiring (for the cells that assert an actual PG row). ──

/** Cluster-global framework roles the migration GRANTs reference. Idempotent;
 *  roles are cluster-wide so creating them on one throwaway DB suffices. */
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
 * Build a peer's DB with the column-faithful features table + the real
 * migration-102 capture trigger (so this is the production send-side, not a
 * re-implementation). Mirrors `feature-content-federation.integration.test.ts`'s
 * `setupPeerSchema`, trimmed to the one table these tests touch.
 */
async function setupFeatureSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(FRAMEWORK_ROLES_DDL);
  // P-010 unification: work_items base + hfc/ei compat views + the outbox table. These
  // tests append ops to the own log DIRECTLY (not via the CDC drain), so no capture
  // trigger is needed — and archive/102's hfc-capture would fail on the compat view.
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await sql.unsafe(SUBSTRATE_OUTBOX_DDL);
}

/** A per-peer projection apply bound to THIS peer's `sql` (the features projection
 *  only — the single table these tests federate). Threads `ownLogKeyHex` so
 *  `applyOpVia` stamps origin from log-source exactly as production does. */
function buildFeatureApply(
  sql: postgres.Sql,
  ownLogKeyHex: string,
): (op: OpEnvelope) => Promise<boolean> {
  const proj = buildHarnessFeaturesProjection({
    workspaceId: WORKSPACE_ID,
    harnessSlug: HARNESS_SLUG,
    sql,
  }) as TableProjection<unknown>;
  const scoped = new Map<string, TableProjection<unknown>>([[proj.tableTag, proj]]);
  const lookup: ProjectionLookup = (tag) => scoped.get(tag) ?? null;
  return (op: OpEnvelope) => applyOpVia(lookup, op, { ownLogKeyHex });
}

/**
 * A COMPLETE feature value the real `isHarnessFeatureRow` validator accepts. The
 * validator rejects `undefined` for every optional field (it only allows `null` or
 * the typed value), so the PG-backed cells must send a full row or `decodeValue`
 * drops it. The capture-sink cells (which use a `vi.fn` apply, not the real
 * projection) can pass a minimal value.
 */
function fullFeatureValue(id: string, title: string) {
  return {
    harness_slug: HARNESS_SLUG,
    feature_id: id,
    title,
    summary: null,
    status: 'todo',
    attempts: null,
    claims: null,
    notes: null,
    metadata: null,
    kind: null,
    project_id: null,
    expected_cost_cents: null,
    tags: null,
    needs_human_review: false, // NOT NULL in the prod-faithful work_items (helper); a real federated feature always carries it
    ts: null,
    created_ts: null,
    updated_ts: null,
    parent_id: null,
    goal_id: null,
    taken_by: null,
    taken_at: null,
    expires_at: null,
  };
}

async function readFeature(sql: postgres.Sql, featureId: string) {
  const rows = await sql<
    Array<{ feature_id: string; title: string | null; status: string | null; origin: string }>
  >`
    SELECT feature_id, title, status, origin
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${HARNESS_SLUG} AND feature_id = ${featureId}
  `;
  return rows[0];
}

async function countFeature(sql: postgres.Sql, featureId: string): Promise<number> {
  const rows = await sql<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${HARNESS_SLUG} AND feature_id = ${featureId}
  `;
  return Number(rows[0]?.n ?? 0);
}

// ── boot helper: a capture-sink peer (no PG) for transport-level assertions. ──
interface CaptureBootResult {
  handle: BootedHarnessHandle;
  apply: ReturnType<typeof vi.fn>;
}

async function bootCapturePeer(opts: {
  testnetBootstrap: unknown;
  rootPrefix: string;
  identity: ReturnType<typeof makeIdentityOverride>;
  /** Conclusive admission predicate over the announcing peer's userId. */
  verify: (userId: number) => 'verified' | 'pending' | 'fail';
  loadRevoked?: () => Promise<Set<string>>;
}): Promise<CaptureBootResult> {
  const apply = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);
  const root = makeWorkspaceRoot(opts.rootPrefix);
  const handle = await bootHarnessSubstrate({
    workspaceRoot: root,
    workspaceId: WORKSPACE_ID,
    harnessSlug: HARNESS_SLUG,
    swarmBinding: BINDING,
    swarmOverride: makeSwarm(opts.testnetBootstrap),
    verifyBindingOverride: async (_pk, _login, userId) => opts.verify(userId),
    applyOverride: apply,
    mergePollMs: 0,
    pendingRetryMs: 0,
    reverifyIntervalMs: 0,
    loadRevokedOverride: opts.loadRevoked ?? (async () => new Set()),
    announceIdentityOverride: opts.identity.override,
  });
  cleanups.push(async () => {
    await handle.close();
    await closeHarnessStore({ workspaceRoot: root, harnessSlug: HARNESS_SLUG });
  });
  return { handle, apply };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Track A content round-trips A→B (the core no-loss assertion).
// ════════════════════════════════════════════════════════════════════════════
describe('federation adversarial — Track A no-loss round-trip A→B', () => {
  it(
    'a feature + a coord-message op written on peer A reaches peer B over the real DHT (no cross-instance loss)',
    async () => {
      const testnet = await makeTestnet();
      const idA = makeIdentityOverride('alice', 42, 'kc-alice');
      const idB = makeIdentityOverride('bob', 7, 'kc-bob');

      // Each peer admits the OTHER's userId (the canonical mutual-admission shape).
      const peerB = await bootCapturePeer({
        testnetBootstrap: testnet.bootstrap,
        rootPrefix: 'advA-B-',
        identity: idB,
        verify: (uid) => (uid === idA.userId ? 'verified' : 'fail'),
      });
      const peerA = await bootCapturePeer({
        testnetBootstrap: testnet.bootstrap,
        rootPrefix: 'advA-A-',
        identity: idA,
        verify: (uid) => (uid === idB.userId ? 'verified' : 'fail'),
      });

      expect(peerA.handle.swarm).not.toBeNull();
      expect(peerB.handle.swarm).not.toBeNull();
      expect(peerA.handle.swarm!.topicHex).toBe(peerB.handle.swarm!.topicHex);

      // Two Track-A content ops on A's OWN log: a WORK record + a COORD-content record.
      await peerA.handle.append({
        type: 'put',
        table: FEATURE_TAG,
        hbKey: 'F-noloss-1',
        value: { harness_slug: HARNESS_SLUG, feature_id: 'F-noloss-1', title: 'no-loss', status: 'todo' },
        ts: 1000,
        schema_version: 1,
        writerPubkey: idA.devicePubkey,
      });
      let coordWritten = false;
      const deliveries = await pollUntil(
        async () => {
          await peerB.handle.mergeNow();
          const work = peerB.apply.mock.calls.find((c) => c[0].hbKey === 'F-noloss-1')?.[0];
          const coord = peerB.apply.mock.calls.find((c) => c[0].hbKey === 'msg-noloss-1')?.[0];
          if (work && !coordWritten) {
            // Exercise separate arrivals over the real wire. The first feature
            // cannot satisfy a contract that also requires a coordination op.
            expect(coord).toBeUndefined();
            coordWritten = true;
            await peerA.handle.append({
              type: 'put',
              table: 'coord-messages',
              hbKey: 'msg-noloss-1',
              value: { harness_slug: HARNESS_SLUG, msg_id: 'msg-noloss-1', surface: 'messages', writer_key: 'su-A', body: { hi: 1 }, ts: 1001 },
              ts: 1001,
              schema_version: 1,
              writerPubkey: idA.devicePubkey,
            });
          }
          return work && coord ? { work, coord } : undefined;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      const gotWork = deliveries?.work;
      const gotCoord = deliveries?.coord;

      expect(gotWork, "peer B never received peer A's feature op (cross-instance LOSS)").toBeTruthy();
      expect(gotWork).toMatchObject({ table: FEATURE_TAG, hbKey: 'F-noloss-1' });
      expect(gotCoord, "peer B never received peer A's coord-message op").toBeTruthy();
      expect(gotCoord).toMatchObject({ table: 'coord-messages', hbKey: 'msg-noloss-1' });

      // B admitted A's log over the real wire (own + A's remote).
      expect(peerB.handle.admitted.size).toBeGreaterThanOrEqual(2);
    },
    35_000,
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Adversarial: an op carrying the RAW table_name (not the tableTag) is
//    silently dropped, while the correctly-tagged sibling projects.
// ════════════════════════════════════════════════════════════════════════════
describe('federation adversarial — wrong tableTag is silently dropped', () => {
  it(
    'a direct applyOpVia dispatch drops a raw-table_name op but applies the tableTag op',
    async () => {
      // Pure-dispatch proof (no swarm/PG): the invariant `applyOpVia` enforces.
      const seen: string[] = [];
      const proj: TableProjection<{ feature_id: string }> = {
        tableTag: FEATURE_TAG,
        composeKey: (r) => r.feature_id,
        decodeValue: (raw) =>
          raw && typeof raw === 'object' && typeof (raw as { feature_id?: unknown }).feature_id === 'string'
            ? (raw as { feature_id: string })
            : null,
        writeToPg: async (r) => {
          seen.push(r.feature_id);
        },
        deleteFromPg: async () => {},
      };
      const lookup: ProjectionLookup = (tag) => (tag === FEATURE_TAG ? (proj as TableProjection<unknown>) : null);

      // Correct tableTag → applied.
      const okApplied = await applyOpVia(lookup, {
        type: 'put',
        table: FEATURE_TAG,
        hbKey: 'F-1',
        value: { feature_id: 'F-1' },
        ts: 1,
      });
      // RAW table_name (the bug a mismapped feature-issue-op-keys.ts would emit) → dropped.
      const rawApplied = await applyOpVia(lookup, {
        type: 'put',
        table: RAW_FEATURE_TABLE,
        hbKey: 'F-2',
        value: { feature_id: 'F-2' },
        ts: 2,
      });

      expect(okApplied, 'a correctly-tagged op must apply').toBe(true);
      expect(rawApplied, 'an op carrying the raw table_name (not the tableTag) must be DROPPED').toBe(false);
      expect(seen, 'only the correctly-tagged op should reach the projection writer').toEqual(['F-1']);
    },
  );

  it(
    "the raw-table_name op does NOT project to B's PG over the real wire, while the tableTag op does",
    async () => {
      const dbB: FreshPgDb = await createFreshPgDb('advB');
      cleanups.push(() => dbB.cleanup());
      await setupFeatureSchema(dbB.sql);

      const testnet = await makeTestnet();
      const idA = makeIdentityOverride('alice', 42, 'kc-alice');
      const idB = makeIdentityOverride('bob', 7, 'kc-bob');

      // Peer A: a plain capture sink (we only care WHAT A publishes, not what A receives).
      const peerA = await bootCapturePeer({
        testnetBootstrap: testnet.bootstrap,
        rootPrefix: 'advB-A-',
        identity: idA,
        verify: (uid) => (uid === idB.userId ? 'verified' : 'fail'),
      });

      // Peer B: a REAL features projection bound to B's throwaway DB.
      const rootB = makeWorkspaceRoot('advB-B-');
      let handleB: BootedHarnessHandle | undefined;
      let applyB: ((op: OpEnvelope) => Promise<boolean>) | undefined;
      handleB = await bootHarnessSubstrate({
        workspaceRoot: rootB,
        workspaceId: WORKSPACE_ID,
        harnessSlug: HARNESS_SLUG,
        swarmBinding: BINDING,
        swarmOverride: makeSwarm(testnet.bootstrap),
        verifyBindingOverride: async (_pk, _login, uid) => (uid === idA.userId ? 'verified' : 'fail'),
        applyOverride: (op, ctx) => {
          applyB ??= buildFeatureApply(dbB.sql, ctx.ownLogKeyHex);
          return applyB(op);
        },
        mergePollMs: 0,
        pendingRetryMs: 0,
        reverifyIntervalMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idB.override,
      });
      cleanups.push(async () => {
        await handleB?.close();
        await closeHarnessStore({ workspaceRoot: rootB, harnessSlug: HARNESS_SLUG });
      });

      expect(peerA.handle.swarm!.topicHex).toBe(handleB.swarm!.topicHex);

      // A appends BOTH: one correctly tagged, one with the raw table_name (the bug).
      await peerA.handle.append({
        type: 'put',
        table: FEATURE_TAG, // correct
        hbKey: 'F-good',
        value: fullFeatureValue('F-good', 'correctly tagged'),
        ts: 2000,
        schema_version: 1,
        writerPubkey: idA.devicePubkey,
      });
      await peerA.handle.append({
        type: 'put',
        table: RAW_FEATURE_TABLE, // WRONG — raw table_name, not the registered tableTag
        hbKey: 'F-bad',
        value: fullFeatureValue('F-bad', 'wrong tableTag'),
        ts: 2001,
        schema_version: 1,
        writerPubkey: idA.devicePubkey,
      });

      // Poll until the GOOD op lands in B's PG. Both ops replicate together (ordered
      // on A's single-writer log), so once F-good is present F-bad has been merged
      // too (and dropped) — making the negative assertion below deterministic, not racy.
      const good = await pollUntil(
        async () => {
          await handleB!.mergeNow();
          return await readFeature(dbB.sql, 'F-good');
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );

      expect(good, "the correctly-tagged feature never reached B's PG").toBeTruthy();
      expect(good).toMatchObject({ feature_id: 'F-good', title: 'correctly tagged', origin: 'remote' });

      // THE ADVERSARIAL ASSERTION: the raw-table_name op was merged but DROPPED by
      // applyOpVia (unknown tableTag → no projection), so no row exists. A regression
      // that mismaps a table to the raw name would surface here as a MISSING row.
      expect(
        await countFeature(dbB.sql, 'F-bad'),
        'an op carrying the raw table_name must NOT project (silently dropped, not swallowed into PG)',
      ).toBe(0);
    },
    35_000,
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Admission + revocation gate WHO can federate.
// ════════════════════════════════════════════════════════════════════════════
describe('federation adversarial — admission + revocation gate the data plane', () => {
  it(
    'a peer B that conclusively REJECTS A never federates A’s content; an admitted peer does',
    async () => {
      const testnet = await makeTestnet();
      const idA = makeIdentityOverride('alice', 42, 'kc-alice');
      const idReject = makeIdentityOverride('rejector', 99, 'kc-rej');

      // Peer B rejects EVERY announcing peer (incl. A) → must never admit A's log.
      const peerB = await bootCapturePeer({
        testnetBootstrap: testnet.bootstrap,
        rootPrefix: 'advC-Brej-',
        identity: idReject,
        verify: () => 'fail',
      });
      const peerA = await bootCapturePeer({
        testnetBootstrap: testnet.bootstrap,
        rootPrefix: 'advC-A-',
        identity: idA,
        verify: () => 'verified', // A would admit anyone; B is the gate under test
      });

      expect(peerA.handle.swarm!.topicHex).toBe(peerB.handle.swarm!.topicHex);

      await peerA.handle.append({
        type: 'put',
        table: FEATURE_TAG,
        hbKey: 'F-rejected',
        value: { harness_slug: HARNESS_SLUG, feature_id: 'F-rejected', title: 'should not cross', status: 'todo' },
        ts: 3000,
        schema_version: 1,
        writerPubkey: idA.devicePubkey,
      });

      // Drive several merge passes — a rejected peer's log is never admitted, so the
      // op can NEVER appear in B's sink no matter how long we merge. Bound the work.
      for (let i = 0; i < 12; i++) {
        await peerB.handle.mergeNow();
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(
        peerB.apply.mock.calls.find((c) => c[0].hbKey === 'F-rejected'),
        "rejected peer A's content reached B despite a conclusive admission FAIL",
      ).toBeUndefined();
      // B admitted only its OWN log (no remote admitted).
      expect(peerB.handle.admitted.size).toBe(1);

      // ── Control: a freshly-booted B that ADMITS A does receive the same content,
      // proving the negative above is the admission gate, not a broken transport. ──
      const idB2 = makeIdentityOverride('bob', 7, 'kc-bob');
      const peerB2 = await bootCapturePeer({
        testnetBootstrap: testnet.bootstrap,
        rootPrefix: 'advC-Badmit-',
        identity: idB2,
        verify: (uid) => (uid === idA.userId ? 'verified' : 'fail'),
      });
      const got = await pollUntil(
        async () => {
          await peerB2.handle.mergeNow();
          return peerB2.apply.mock.calls.find((c) => c[0].hbKey === 'F-rejected')?.[0];
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(got, 'the admitted control peer should receive A’s content (transport works)').toBeTruthy();
    },
    45_000,
  );

  it(
    'a mid-session published revocation drops the admitted peer so its NEW content no longer projects',
    async () => {
      const testnet = await makeTestnet();
      const idA = makeIdentityOverride('alice', 42, 'kc-alice');
      const idB = makeIdentityOverride('bob', 7, 'kc-bob');

      // B's revoked set is MUTABLE — applyRevocationRefresh re-reads it every mergeNow.
      let revokedSet = new Set<string>();

      const peerB = await bootCapturePeer({
        testnetBootstrap: testnet.bootstrap,
        rootPrefix: 'advD-B-',
        identity: idB,
        verify: (uid) => (uid === idA.userId ? 'verified' : 'fail'),
        loadRevoked: async () => new Set(revokedSet),
      });
      const peerA = await bootCapturePeer({
        testnetBootstrap: testnet.bootstrap,
        rootPrefix: 'advD-A-',
        identity: idA,
        verify: (uid) => (uid === idB.userId ? 'verified' : 'fail'),
      });

      expect(peerA.handle.swarm!.topicHex).toBe(peerB.handle.swarm!.topicHex);

      // 1. Pre-revocation content federates (A is admitted).
      await peerA.handle.append({
        type: 'put',
        table: FEATURE_TAG,
        hbKey: 'F-before-revoke',
        value: { harness_slug: HARNESS_SLUG, feature_id: 'F-before-revoke', title: 'before', status: 'todo' },
        ts: 4000,
        schema_version: 1,
        writerPubkey: idA.devicePubkey,
      });
      const before = await pollUntil(
        async () => {
          await peerB.handle.mergeNow();
          return peerB.apply.mock.calls.find((c) => c[0].hbKey === 'F-before-revoke')?.[0];
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(before, "A's pre-revocation content should federate while admitted").toBeTruthy();
      expect(peerB.handle.admitted.size).toBeGreaterThanOrEqual(2); // own + A

      // 2. Publish a revocation of A's device pubkey → B's loadRevoked now returns it.
      //    The next mergeNow's applyRevocationRefresh drops A's admitted log.
      revokedSet = new Set([idA.devicePubkey]);
      await peerB.handle.mergeNow(); // triggers applyRevocationRefresh → drop A
      expect(
        peerB.handle.admitted.size,
        'B should have dropped the revoked peer’s admitted log',
      ).toBe(1); // only own log remains

      // 3. NEW content from the revoked peer must NOT newly project on B.
      const callsBeforeNew = peerB.apply.mock.calls.length;
      await peerA.handle.append({
        type: 'put',
        table: FEATURE_TAG,
        hbKey: 'F-after-revoke',
        value: { harness_slug: HARNESS_SLUG, feature_id: 'F-after-revoke', title: 'after', status: 'todo' },
        ts: 4001,
        schema_version: 1,
        writerPubkey: idA.devicePubkey,
      });
      for (let i = 0; i < 10; i++) {
        await peerB.handle.mergeNow();
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(
        peerB.apply.mock.calls.find((c) => c[0].hbKey === 'F-after-revoke'),
        "a revoked peer's NEW content must NOT federate (admitted log was dropped)",
      ).toBeUndefined();
      // Sanity: B's revoked-set drop also means no fresh applies for the dropped log.
      const callsAfter = peerB.apply.mock.calls.filter((c) => c[0].hbKey === 'F-after-revoke').length;
      expect(callsAfter).toBe(0);
      void callsBeforeNew;
    },
    45_000,
  );

  it(
    'C-001 (release gap): a removed member can no longer WRITE, but STILL READS new content (write-only revocation)',
    async () => {
      // Demonstrates finding C-001 (shared-pot-release-testing/findings-C.md):
      // revoking a member drops its log from OTHER peers' admitted sets (so its
      // WRITES stop propagating hive-wide), but does NOT stop the removed member
      // from READING — its own admission of the owner's log is untouched and
      // corestore replication is unconditional for any topic peer. So "remove
      // member" silences B's writes yet B keeps reading everything new.
      //
      // ⚠ When read-plane revocation lands (re-key / gate-replication / evict —
      // see findings-C.md fix options), the "STILL reads" assertion below MUST
      // flip to .toBeUndefined(). Until then this pins the gap as a regression guard.
      const testnet = await makeTestnet();
      const idA = makeIdentityOverride('owner', 42, 'kc-owner');
      const idB = makeIdentityOverride('member', 7, 'kc-member');

      let aRevoked = new Set<string>(); // the owner's published revocations
      const peerA = await bootCapturePeer({
        testnetBootstrap: testnet.bootstrap,
        rootPrefix: 'c001-A-',
        identity: idA,
        verify: (uid) => (uid === idB.userId ? 'verified' : 'fail'),
        loadRevoked: async () => new Set(aRevoked),
      });
      const peerB = await bootCapturePeer({
        testnetBootstrap: testnet.bootstrap,
        rootPrefix: 'c001-B-',
        identity: idB,
        verify: (uid) => (uid === idA.userId ? 'verified' : 'fail'),
        // a removed member revokes no one — its read path stays fully open.
      });
      expect(peerA.handle.swarm!.topicHex).toBe(peerB.handle.swarm!.topicHex);

      // Baseline: B reads the owner's content while still a member.
      await peerA.handle.append({
        type: 'put', table: FEATURE_TAG, hbKey: 'F-member',
        value: { harness_slug: HARNESS_SLUG, feature_id: 'F-member', title: 'member-era', status: 'todo' },
        ts: 5000, schema_version: 1, writerPubkey: idA.devicePubkey,
      });
      const baseline = await pollUntil(
        async () => {
          await peerB.handle.mergeNow();
          return peerB.apply.mock.calls.find((c) => c[0].hbKey === 'F-member')?.[0];
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(baseline, 'baseline: a member reads owner content').toBeTruthy();

      // Owner REMOVES B (publishes a revocation of B's device pubkey).
      aRevoked = new Set([idB.devicePubkey]);
      await peerA.handle.mergeNow(); // owner drops the removed member's log
      expect(peerA.handle.admitted.size, 'owner dropped the removed member’s log').toBe(1);

      // (1) WRITE plane IS cut — B's NEW write must NOT reach the owner.
      await peerB.handle.append({
        type: 'put', table: FEATURE_TAG, hbKey: 'G-after-remove',
        value: { harness_slug: HARNESS_SLUG, feature_id: 'G-after-remove', title: 'removed-write', status: 'todo' },
        ts: 5001, schema_version: 1, writerPubkey: idB.devicePubkey,
      });
      for (let i = 0; i < 10; i++) {
        await peerA.handle.mergeNow();
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(
        peerA.apply.mock.calls.find((c) => c[0].hbKey === 'G-after-remove'),
        'WRITE plane: a removed member’s new write must NOT reach the owner',
      ).toBeUndefined();

      // (2) READ plane is NOT cut (THE GAP) — the owner's NEW content STILL reaches B.
      await peerA.handle.append({
        type: 'put', table: FEATURE_TAG, hbKey: 'F-after-remove',
        value: { harness_slug: HARNESS_SLUG, feature_id: 'F-after-remove', title: 'post-removal', status: 'todo' },
        ts: 5002, schema_version: 1, writerPubkey: idA.devicePubkey,
      });
      const stillReads = await pollUntil(
        async () => {
          await peerB.handle.mergeNow();
          return peerB.apply.mock.calls.find((c) => c[0].hbKey === 'F-after-remove')?.[0];
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      // ⚠ GAP: today this is truthy (B still reads after removal). Flip to
      // .toBeUndefined() when read-plane revocation is implemented (C-001 fixed).
      expect(
        stillReads,
        'C-001 GAP: a removed member STILL reads owner content (write-only revocation) — flip when fixed',
      ).toBeTruthy();
    },
    60_000,
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 4. No duplication — one op merged twice yields exactly ONE PG row.
// ════════════════════════════════════════════════════════════════════════════
describe('federation adversarial — no cross-instance duplication', () => {
  it(
    'one feature op replicated + merged TWICE yields exactly ONE PG row on the receiver (idempotent keyed upsert)',
    async () => {
      const dbB: FreshPgDb = await createFreshPgDb('advDup');
      cleanups.push(() => dbB.cleanup());
      await setupFeatureSchema(dbB.sql);

      const testnet = await makeTestnet();
      const idA = makeIdentityOverride('alice', 42, 'kc-alice');
      const idB = makeIdentityOverride('bob', 7, 'kc-bob');

      const peerA = await bootCapturePeer({
        testnetBootstrap: testnet.bootstrap,
        rootPrefix: 'advDup-A-',
        identity: idA,
        verify: (uid) => (uid === idB.userId ? 'verified' : 'fail'),
      });

      const rootB = makeWorkspaceRoot('advDup-B-');
      let handleB: BootedHarnessHandle | undefined;
      let applyB: ((op: OpEnvelope) => Promise<boolean>) | undefined;
      handleB = await bootHarnessSubstrate({
        workspaceRoot: rootB,
        workspaceId: WORKSPACE_ID,
        harnessSlug: HARNESS_SLUG,
        swarmBinding: BINDING,
        swarmOverride: makeSwarm(testnet.bootstrap),
        verifyBindingOverride: async (_pk, _login, uid) => (uid === idA.userId ? 'verified' : 'fail'),
        applyOverride: (op, ctx) => {
          applyB ??= buildFeatureApply(dbB.sql, ctx.ownLogKeyHex);
          return applyB(op);
        },
        mergePollMs: 0,
        pendingRetryMs: 0,
        reverifyIntervalMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idB.override,
      });
      cleanups.push(async () => {
        await handleB?.close();
        await closeHarnessStore({ workspaceRoot: rootB, harnessSlug: HARNESS_SLUG });
      });

      expect(peerA.handle.swarm!.topicHex).toBe(handleB.swarm!.topicHex);

      await peerA.handle.append({
        type: 'put',
        table: FEATURE_TAG,
        hbKey: 'F-dup',
        value: fullFeatureValue('F-dup', 'once'),
        ts: 5000,
        schema_version: 1,
        writerPubkey: idA.devicePubkey,
      });

      const landed = await pollUntil(
        async () => {
          await handleB!.mergeNow();
          return await readFeature(dbB.sql, 'F-dup');
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(landed, "A's feature never reached B's PG").toBeTruthy();
      expect(await countFeature(dbB.sql, 'F-dup')).toBe(1);

      // Re-merge MANY more times: the op is already at/behind B's cursor and the
      // projection's put is keyed (PK harness_slug, feature_id), so a second delivery
      // can only UPSERT the same row — never insert a duplicate. The defining
      // no-duplication invariant across instances.
      for (let i = 0; i < 6; i++) await handleB.mergeNow();
      expect(
        await countFeature(dbB.sql, 'F-dup'),
        'repeated replication/merge of one op must NOT create a duplicate PG row',
      ).toBe(1);
    },
    45_000,
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Poisoning / DoS — a malicious peer's malformed ops must not crash or WEDGE
//    an honest peer's merge pipeline (Brief C #6). Liveness check: a valid op
//    after a garbage barrage still federates.
// ════════════════════════════════════════════════════════════════════════════
describe('federation adversarial — malformed/poisoning ops do not crash or wedge an honest peer', () => {
  it(
    'garbage ops (NaN ts, oversized payload, junk schema, null value) cannot wedge the pipeline — a later valid op still federates',
    async () => {
      const testnet = await makeTestnet();
      const idA = makeIdentityOverride('attacker', 42, 'kc-atk');
      const idB = makeIdentityOverride('honest', 7, 'kc-honest');
      const peerB = await bootCapturePeer({
        testnetBootstrap: testnet.bootstrap,
        rootPrefix: 'mal-B-',
        identity: idB,
        verify: (uid) => (uid === idA.userId ? 'verified' : 'fail'),
      });
      const peerA = await bootCapturePeer({
        testnetBootstrap: testnet.bootstrap,
        rootPrefix: 'mal-A-',
        identity: idA,
        verify: () => 'verified',
      });
      expect(peerA.handle.swarm!.topicHex).toBe(peerB.handle.swarm!.topicHex);

      // A appends a barrage of malformed ops. `as never` bypasses the compile-time
      // envelope shape — the attacker controls its own log bytes.
      const garbage = [
        { type: 'put', table: FEATURE_TAG, hbKey: 'M-nan', value: { harness_slug: HARNESS_SLUG, feature_id: 'M-nan' }, ts: Number.NaN, schema_version: 1, writerPubkey: idA.devicePubkey },
        { type: 'put', table: FEATURE_TAG, hbKey: 'M-big', value: { harness_slug: HARNESS_SLUG, feature_id: 'M-big', title: 'x'.repeat(1_000_000) }, ts: 1, schema_version: 1, writerPubkey: idA.devicePubkey },
        { type: 'put', table: FEATURE_TAG, hbKey: 'M-junkschema', value: { harness_slug: HARNESS_SLUG, feature_id: 'M-junkschema' }, ts: 2, schema_version: 999_999, writerPubkey: idA.devicePubkey },
        { type: 'put', table: FEATURE_TAG, hbKey: '', value: null, ts: 3, schema_version: 1, writerPubkey: idA.devicePubkey },
        { type: 'weird-op-type', table: FEATURE_TAG, hbKey: 'M-badtype', value: {}, ts: 4, schema_version: 1, writerPubkey: idA.devicePubkey },
      ];
      for (const g of garbage) {
        try {
          await peerA.handle.append(g as never);
        } catch {
          /* append may itself reject malformed input — that's a valid defense too */
        }
      }
      // Drive merges over the garbage — must not throw or hang.
      for (let i = 0; i < 8; i++) {
        await peerB.handle.mergeNow();
        await new Promise((r) => setTimeout(r, 100));
      }

      // LIVENESS: a subsequent VALID op STILL federates — the garbage did not wedge
      // the merge/decode/dispatch pipeline (the DoS-resistance invariant).
      await peerA.handle.append({
        type: 'put', table: FEATURE_TAG, hbKey: 'M-valid',
        value: { harness_slug: HARNESS_SLUG, feature_id: 'M-valid', title: 'good', status: 'todo' },
        ts: 100, schema_version: 1, writerPubkey: idA.devicePubkey,
      });
      const got = await pollUntil(
        async () => {
          await peerB.handle.mergeNow();
          return peerB.apply.mock.calls.find((c) => c[0].hbKey === 'M-valid')?.[0];
        },
        { timeoutMs: 75_000, intervalMs: 250 },
      );
      expect(
        got,
        'a valid op after a malformed barrage must still federate (pipeline not wedged by garbage)',
      ).toBeTruthy();
    },
    120_000,
  );
});
