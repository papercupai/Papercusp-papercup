/**
 * plan-item-assignment-two-peer-federation.integration.test.ts —
 * Phase-4 leg (a) of plan-item-assignment-claim-liveness-2026-06-04: a plan-item
 * ASSIGNMENT written on peer A genuinely lands in ANOTHER peer B's Postgres,
 * through the REAL CDC-outbox + Hypercore log + in-process Hyperswarm + the real
 * 'item-assignments' projection — exactly the harness Stage-6 feature-content
 * federation uses, but for the assignment surface.
 *
 * This is the in-process two-PEER acceptance (two corestores, two logs, a real
 * Hyperswarm over a local testnet DHT, TWO separate PG databases). It is strictly
 * stronger than the single-process drain/projection tests: the receiving peer runs
 * the real projection into its OWN database, so we prove the row truly crosses.
 * The remaining gap to the plan's literal "two physical VMs" is only the OS/network
 * boundary — the federation MECHANISM is fully exercised here.
 *
 * The CLAIM half is authority-mediated and never federates, so it has no analogue
 * here (correctly).
 *
 * Mirrors feature-content-federation.integration.test.ts (same real-vs-stood-in
 * boundary: real swarm/logs/triggers/drain/merge/projections + two real DBs; the
 * channel-2 GitHub-binding fetch is the verifyBindingOverride admit-by-userId).
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
import { bootHarnessSubstrate, type BootedHarnessHandle } from '../boot';
import { type HyperswarmLike } from '../swarm';
import type { OpEnvelope } from '../op-envelope-types';
import { _resetBootHistoryForTests } from '../boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';
import { drainOutboxOnce } from '../outbox-drain';
import { applyOpVia, type ProjectionLookup, type TableProjection } from '../projection';
import { buildPlanItemAssignmentsProjection } from '../projections/plan-item-assignments';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { stubHivePolicyReadsForSuite } from './_hive-policy-read-stubs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

const WORKSPACE_ID = 'ws-pia-fed';
const HARNESS_SLUG = 'sheets';
const PLAN = 'demo-plan';
const BINDING = { kind: 'local' as const, workspace_id: WORKSPACE_ID, harness_slug: HARNESS_SLUG };

// Before this file's own afterEach, so the stub outlives substrate teardown (WI-6554700010008561).
stubHivePolicyReadsForSuite();
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* best-effort */
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

function makeSwarm(bootstrap: unknown): HyperswarmLike {
  const swarm = new Hyperswarm({ bootstrap }) as unknown as HyperswarmLike & { destroy(): Promise<void> };
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

const FRAMEWORK_ROLES_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN CREATE ROLE harness_zero NOLOGIN; END IF;
  END $pg$;
`;

/** Strip psql meta + the bare BEGIN/COMMIT wrapper (postgres-js refuses them over a pool). */
function stripMeta(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('\\') && !/^(begin|commit);$/i.test(t);
    })
    .join('\n');
}

/**
 * Build a peer's federation schema: the consolidated-table stubs migration-102's
 * triggers attach to, the REAL outbox + capture function (102), then my assignment
 * table (140) + my capture triggers (145). The CLAIM table (141) is NOT needed —
 * claims don't federate.
 */
async function setupPeerSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(FRAMEWORK_ROLES_DDL);
  await sql.unsafe(`
    CREATE TABLE harness_shared.harness_features_consolidated (
      workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
      feature_id TEXT NOT NULL, author_pubkey TEXT,
      origin TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (harness_slug, feature_id)
    );
    CREATE TABLE harness_shared.harness_issues_consolidated (
      workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
      issue_id TEXT NOT NULL, author_pubkey TEXT,
      origin TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (harness_slug, issue_id)
    );
  `);
  await sql.unsafe(readFileSync(join(SQL_DIR, 'archive/102-substrate-outbox.sql'), 'utf8'));
  // WI-3192 cluster (2): migration 495 added drained_log_key so outbox-drain
  // can stamp which own-log key drained each row — the live drain writer
  // always writes it, but this fixture only replays the creating migration.
  await sql.unsafe(`ALTER TABLE harness_shared.substrate_outbox ADD COLUMN IF NOT EXISTS drained_log_key TEXT`);
  await sql.unsafe(stripMeta(readFileSync(join(SQL_DIR, '140-plan-item-assignments.sql'), 'utf8')));
  await sql.unsafe(stripMeta(readFileSync(join(SQL_DIR, '145-plan-item-assignments-federation.sql'), 'utf8')));
  // EI-79 step 2 (mig 181): the PG-level LWW guard column the writer stamps.
  await sql.unsafe(`ALTER TABLE harness_shared.plan_item_assignments ADD COLUMN IF NOT EXISTS fed_ts BIGINT`);
  await sql.unsafe(`ALTER TABLE harness_shared.plan_item_assignments ADD COLUMN IF NOT EXISTS fed_hlc TEXT`);
}

/** Per-peer projection apply bound to THIS peer's sql — only the assignment projection. */
function buildPeerApply(sql: postgres.Sql, ownLogKeyHex: string): (op: OpEnvelope) => Promise<boolean> {
  const opts = { workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG, sql };
  const scoped = new Map<string, TableProjection<unknown>>();
  const p = buildPlanItemAssignmentsProjection(opts) as TableProjection<unknown>;
  scoped.set(p.tableTag, p);
  const lookup: ProjectionLookup = (tag) => scoped.get(tag) ?? null;
  return (op: OpEnvelope) => applyOpVia(lookup, op, { ownLogKeyHex });
}

async function readAssignment(sql: postgres.Sql, itemId: string) {
  const rows = await sql<
    Array<{ item_id: string; assignee_name: string | null; assigned_by_user: string | null; origin: string; workspace_id: string }>
  >`
    SELECT item_id, assignee_name, assigned_by_user, origin, workspace_id
      FROM harness_shared.plan_item_assignments
     WHERE harness_slug = ${HARNESS_SLUG} AND plan_slug = ${PLAN} AND item_id = ${itemId}
  `;
  return rows[0];
}

async function countOutbox(sql: postgres.Sql, key: string): Promise<number> {
  const rows = await sql<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM harness_shared.substrate_outbox
     WHERE table_name = 'plan_item_assignments' AND key = ${key}
  `;
  return Number(rows[0]?.n ?? 0);
}

async function insertAssignment(sql: postgres.Sql, itemId: string, assignee: string, by: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.plan_item_assignments
      (workspace_id, harness_slug, plan_slug, item_id, assignee_name, assigned_by_user, assigned_ts, origin)
    VALUES (${WORKSPACE_ID}, ${HARNESS_SLUG}, ${PLAN}, ${itemId}, ${assignee}, ${by}, now(), 'local')
  `;
}

describe('Phase-4 (a): a plan-item assignment federates A↔B end-to-end through the REAL CDC + swarm', () => {
  it(
    'an assignment written on A lands in B (and B→A), with origin=remote + the echo-loop terminating',
    async () => {
      const dbA: FreshPgDb = await createFreshPgDb('piA');
      cleanups.push(() => dbA.cleanup());
      const dbB: FreshPgDb = await createFreshPgDb('piB');
      cleanups.push(() => dbB.cleanup());
      await setupPeerSchema(dbA.sql);
      await setupPeerSchema(dbB.sql);

      const [nameA] = await dbA.sql<Array<{ d: string }>>`SELECT current_database() AS d`;
      const [nameB] = await dbB.sql<Array<{ d: string }>>`SELECT current_database() AS d`;
      expect(nameA.d).not.toBe(nameB.d);

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
      const rootA = makeWorkspaceRoot('pia-A-');
      const rootB = makeWorkspaceRoot('pia-B-');

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
        verifyBindingOverride: async (_pk, _login, userId) => (userId === idB.userId ? 'verified' : 'fail'),
        // ctx, not `handleA`: a merge pass can run before bootHarnessSubstrate returns (WI-6554700010008561).
        applyOverride: (op, ctx) => {
          applyA ??= buildPeerApply(dbA.sql, ctx.ownLogKeyHex);
          return applyA(op);
        },
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idA.override,
        rekeyDepsOverride: null, // no re-key build through the live org-admin pool (WI-6554700010008561)
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
        verifyBindingOverride: async (_pk, _login, userId) => (userId === idA.userId ? 'verified' : 'fail'),
        applyOverride: (op, ctx) => {
          applyB ??= buildPeerApply(dbB.sql, ctx.ownLogKeyHex);
          return applyB(op);
        },
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idB.override,
        rekeyDepsOverride: null, // see boot A
      });
      cleanups.push(async () => {
        await handleB?.close();
        await closeHarnessStore({ workspaceRoot: rootB, harnessSlug: HARNESS_SLUG });
      });

      expect(handleA.swarm).not.toBeNull();
      expect(handleB.swarm).not.toBeNull();
      expect(handleA.swarm!.topicHex).toBe(handleB.swarm!.topicHex);

      // ── A→B: local assignment on A → real trigger → A's outbox → drain → A's log. ──
      await insertAssignment(dbA.sql, 'P-001', 'builder-1', 'alice');
      expect(await countOutbox(dbA.sql, 'demo-plan:P-001')).toBe(1);
      expect(await readAssignment(dbB.sql, 'P-001')).toBeUndefined(); // not on B yet
      const lenA0 = handleA.ownLog.length;
      expect(await drainOutboxOnce(handleA, dbA.sql)).toBeGreaterThanOrEqual(1);
      expect(handleA.ownLog.length).toBeGreaterThan(lenA0);

      // ── B→A: symmetric. ──
      await insertAssignment(dbB.sql, 'P-002', 'builder-2', 'bob');
      expect(await countOutbox(dbB.sql, 'demo-plan:P-002')).toBe(1);
      expect(await drainOutboxOnce(handleB, dbB.sql)).toBeGreaterThanOrEqual(1);

      // ── ACCEPTANCE: drive both merges until the cross-peer rows land in real PG. ──
      const result = await pollUntil(
        async () => {
          await Promise.all([handleA.mergeNow(), handleB.mergeNow()]);
          const aOnB = await readAssignment(dbB.sql, 'P-001');
          const bOnA = await readAssignment(dbA.sql, 'P-002');
          return aOnB && bOnA ? { aOnB, bOnA } : undefined;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );

      expect(result?.aOnB, "A's assignment P-001 never reached B's PG (A→B failed)").toBeTruthy();
      expect(result!.aOnB).toMatchObject({
        item_id: 'P-001',
        assignee_name: 'builder-1',
        assigned_by_user: 'alice',
        origin: 'remote', // B received it from A's log → stamped remote
        workspace_id: WORKSPACE_ID,
      });
      expect(result?.bOnA, "B's assignment P-002 never reached A's PG (B→A failed)").toBeTruthy();
      expect(result!.bOnA).toMatchObject({ item_id: 'P-002', assignee_name: 'builder-2', origin: 'remote' });

      // ── ECHO-GUARD: B's remote-origin write must NOT re-enqueue (loop terminates). ──
      expect(
        await countOutbox(dbB.sql, 'demo-plan:P-001'),
        "B re-enqueued A's federated assignment → echo loop",
      ).toBe(0);
      expect(await countOutbox(dbA.sql, 'demo-plan:P-002')).toBe(0);

      // ── CONVERGENCE: repeated merge+drain reaches a fixed point (no amplification). ──
      let converged = false;
      for (let pass = 0; pass < 8; pass++) {
        await Promise.all([handleA.mergeNow(), handleB.mergeNow()]);
        const a = await drainOutboxOnce(handleA, dbA.sql);
        const b = await drainOutboxOnce(handleB, dbB.sql);
        if (a === 0 && b === 0) {
          converged = true;
          break;
        }
      }
      expect(converged, 'assignment federation never reached a fixed point (outbox kept growing)').toBe(true);
    },
    60_000,
  );

  // WI-971 remnant (2026-07-16 live-fed gate + gate-matrix): item-assignments FAILS
  // the BACKFILL leg (a row that existed on A BEFORE B ever joined) while INCREMENTAL
  // (post-join) passes both directions — the one test gap the case above doesn't
  // cover (there, B is already booted+merging when A's insert happens). This
  // reproduces the backfill ordering exactly: A gets its assignment + drain BEFORE
  // B is even booted, so B's very first merge pass folds A's log from index 0
  // (the "full-history fold" boot.ts describes) instead of an on-append tick.
  it(
    'a PRE-EXISTING assignment (written + drained on A before B ever boots) backfills to B with origin=remote',
    async () => {
      const dbA: FreshPgDb = await createFreshPgDb('piA2');
      cleanups.push(() => dbA.cleanup());
      const dbB: FreshPgDb = await createFreshPgDb('piB2');
      cleanups.push(() => dbB.cleanup());
      await setupPeerSchema(dbA.sql);
      await setupPeerSchema(dbB.sql);

      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      const idA = makeIdentityOverride('alice2', 43, 'kc-alice2');
      const idB = makeIdentityOverride('bob2', 8, 'kc-bob2');
      const swarmA = makeSwarm(testnet.bootstrap);
      const swarmB = makeSwarm(testnet.bootstrap);
      const rootA = makeWorkspaceRoot('pia2-A-');
      const rootB = makeWorkspaceRoot('pia2-B-');

      let handleA: BootedHarnessHandle | undefined;
      let handleB: BootedHarnessHandle | undefined;
      let applyA: ((op: OpEnvelope) => Promise<boolean>) | undefined;
      let applyB: ((op: OpEnvelope) => Promise<boolean>) | undefined;
      // WI-971 backfill repro gotcha: unlike the incremental case above, B's swarm
      // peer-connect handshake can trigger an IMMEDIATE merge pass (onAnnounce →
      // admitPeer → mergeOnePass) SYNCHRONOUSLY inside bootHarnessSubstrate — i.e.
      // BEFORE the `handleB = await bootHarnessSubstrate(...)` assignment below
      // completes — because A already has content to fold on B's very first
      // connection. The apply closure therefore takes B's own-log key from the boot
      // ctx (known before the first merge pass), never from `handleB`
      // (WI-6554700010008569 — this replaced a pre-boot op buffer).

      // ── Boot ONLY A, write + drain the assignment, THEN close nothing — B does
      // not exist yet. This is the backfill precondition: the op is already in A's
      // log before any peer relationship forms. ──
      handleA = await bootHarnessSubstrate({
        workspaceRoot: rootA,
        workspaceId: WORKSPACE_ID,
        harnessSlug: HARNESS_SLUG,
        swarmBinding: BINDING,
        swarmOverride: swarmA,
        verifyBindingOverride: async (_pk, _login, userId) => (userId === idB.userId ? 'verified' : 'fail'),
        applyOverride: (op, ctx) => {
          applyA ??= buildPeerApply(dbA.sql, ctx.ownLogKeyHex);
          return applyA(op);
        },
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idA.override,
        rekeyDepsOverride: null, // no re-key build through the live org-admin pool (WI-6554700010008561)
      });
      cleanups.push(async () => {
        await handleA?.close();
        await closeHarnessStore({ workspaceRoot: rootA, harnessSlug: HARNESS_SLUG });
      });

      await insertAssignment(dbA.sql, 'P-SEED', 'builder-seed', 'alice2');
      expect(await countOutbox(dbA.sql, 'demo-plan:P-SEED')).toBe(1);
      const lenA0 = handleA.ownLog.length;
      expect(await drainOutboxOnce(handleA, dbA.sql)).toBeGreaterThanOrEqual(1);
      expect(handleA.ownLog.length).toBeGreaterThan(lenA0);

      // ── NOW boot B — it joins a hive that ALREADY has this content in A's log. ──
      handleB = await bootHarnessSubstrate({
        workspaceRoot: rootB,
        workspaceId: WORKSPACE_ID,
        harnessSlug: HARNESS_SLUG,
        swarmBinding: BINDING,
        swarmOverride: swarmB,
        verifyBindingOverride: async (_pk, _login, userId) => (userId === idA.userId ? 'verified' : 'fail'),
        applyOverride: (op, ctx) => {
          applyB ??= buildPeerApply(dbB.sql, ctx.ownLogKeyHex);
          return applyB(op);
        },
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idB.override,
        rekeyDepsOverride: null, // see boot A
      });
      cleanups.push(async () => {
        await handleB?.close();
        await closeHarnessStore({ workspaceRoot: rootB, harnessSlug: HARNESS_SLUG });
      });

      expect(handleA.swarm).not.toBeNull();
      expect(handleB.swarm).not.toBeNull();
      expect(handleA.swarm!.topicHex).toBe(handleB.swarm!.topicHex);

      const seedOnB = await pollUntil(
        async () => {
          await Promise.all([handleA.mergeNow(), handleB.mergeNow()]);
          return readAssignment(dbB.sql, 'P-SEED');
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );

      expect(seedOnB, "A's PRE-EXISTING assignment P-SEED never reached B's PG (backfill failed)").toBeTruthy();
      expect(seedOnB).toMatchObject({
        item_id: 'P-SEED',
        assignee_name: 'builder-seed',
        assigned_by_user: 'alice2',
        origin: 'remote', // WI-971: this is expected to currently FAIL as 'local'
        workspace_id: WORKSPACE_ID,
      });
    },
    60_000,
  );
});
