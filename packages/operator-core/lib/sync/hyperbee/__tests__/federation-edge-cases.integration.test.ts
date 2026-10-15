/**
 * federation-edge-cases.integration.test.ts — PROPAGATION edge cases for the
 * shared-hive feature/issue federation, built on the SAME real 2-peer harness as
 * `feature-content-federation.integration.test.ts` (the Stage-6 acceptance). That
 * file proves the happy path (A→B feature/issue + echo-guard convergence); THIS
 * file pins the edges around it:
 *
 *   G1  DELETE federates end-to-end (A deletes → B removes over the wire), and a
 *       genuine recreate-after-delete (causally later) correctly resurrects on B.
 *   G1b The fed_ts del-guard: a STALE delete (older fed_ts than B's existing put)
 *       does NOT erase B's row (deleteFromPg's ts-guard — the no-tombstone floor).
 *   G2  contributor_usage_events (the 5th federated table, append-only) federates
 *       A→B with origin='remote' and a byte-equal payload.
 *   G3  a ~100KB jsonb field federates INTACT (deep-equal), and a ~64KB boundary
 *       payload also lands whole — never silently truncated.
 *   G4  15-20 rapid successive UPDATEs converge B to the FINAL state, never an
 *       intermediate — including a merge-between-each-update variant.
 *   G6  the verified_author_github_user_id column the receive-side projection
 *       stamps on a remote feature has the intended NULL-without-attestation
 *       semantics.
 *
 * Same boundary as the template: REAL capture trigger (migration 102/103 +
 * 108-style usage trigger), REAL outbox drain, REAL Hyperswarm over a local
 * testnet DHT, REAL per-peer PG projections into two SEPARATE databases. The
 * channel-2 GitHub binding is stood in by `verifyBindingOverride` (proven
 * separately). Harness helpers are copied from the template (they are in-file,
 * not exported); the inline boot is extracted into `bootTwoPeers()`.
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
import { encodeHlc } from '@papercusp/locks-core';
import { applyOpVia, type ProjectionLookup, type TableProjection } from '../projection';
import { buildHarnessFeaturesProjection } from '../projections/harness-features';
import { buildIssuesProjection } from '../projections/issues';
import { buildUsageProjection } from '../projections/usage';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  SUBSTRATE_OUTBOX_DDL,
  FILL_WORKSPACE_ID_DDL,
  HARNESS_ISSUES_CONSOLIDATED_FED_DDL,
} from '../../../../test/_work-items-schema';
import { stubHivePolicyReadsForSuite } from './_hive-policy-read-stubs';

// The merge pass reads the hive policy + roster through the LIVE org pool, and a failed
// read now leaves the pass unapplied (WI-10007530), so every pass here failed on the
// integration live-DSN guard (WI-6554700010008455). This suite federates a non-Hive
// harness: model the successful absent-policy read. Registered BEFORE the file's own
// afterEach so the stub outlives substrate teardown passes.
stubHivePolicyReadsForSuite();

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

// ── Shared identity / swarm constants. Same binding on both peers → same topic. ──
const WORKSPACE_ID = 'ws-fed-edges';
const HARNESS_SLUG = 'sheets';
const BINDING = {
  kind: 'local' as const,
  workspace_id: WORKSPACE_ID,
  harness_slug: HARNESS_SLUG,
};

// ── Async resource teardown (newest-first, mirrors the template). ──
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
 * Same as the template's setupPeerSchema, PLUS the `contributor_usage_events`
 * table + its capture trigger (the 5th federated table, G2). The features /
 * issues / projects DDL and the real migration-102/103 application are verbatim
 * copies so the send side this file exercises is the production trigger.
 */
async function setupPeerSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(FRAMEWORK_ROLES_DDL);

  // P-010 unification: work_items base + hfc/ei compat views (instead of hand-rolled hfc/issues).
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
    -- G2: the 5th federated table. Mirrors 000-baseline's contributor_usage_events
    -- (ts TIMESTAMPTZ) + the 108-migration echo-guard origin column.
    CREATE TABLE harness_shared.contributor_usage_events (
      harness_slug   TEXT NOT NULL,
      event_id       TEXT NOT NULL,
      github_user_id BIGINT NOT NULL,
      device_pubkey  TEXT NOT NULL,
      kind           TEXT NOT NULL,
      ref_id         TEXT,
      payload        JSONB,
      ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
      schema_version BIGINT NOT NULL DEFAULT 1,
      origin         TEXT NOT NULL DEFAULT 'local',
      PRIMARY KEY (harness_slug, event_id)
    );
  `);

  await sql`
    INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id, created_ts, updated_ts)
    VALUES ('p-fed', 'Fed', 'active', ${HARNESS_SLUG}, ${WORKSPACE_ID}, 0, 0)
  `;

  // P-010 unification send-side: the outbox (+ the D-001 op_hlc column), the workspace_id
  // fill on work_items, the legacy harness_issues_consolidated federated table, and the
  // work_items CDC capture (mig 375) — which stamps table_name harness_features_consolidated
  // / engineer_issues per family so the read-side projections demux unchanged.
  await sql.unsafe(SUBSTRATE_OUTBOX_DDL);
  await sql.unsafe(`ALTER TABLE harness_shared.substrate_outbox ADD COLUMN IF NOT EXISTS op_hlc TEXT;`);
  await sql.unsafe(FILL_WORKSPACE_ID_DDL);
  await sql.unsafe(HARNESS_ISSUES_CONSOLIDATED_FED_DDL);
  const stripMig = (s: string) =>
    s
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('\\') && !/^(begin|commit);$/i.test(t);
      })
      .join('\n');
  // usage-events workspace_id fill (mig 301, attaches to contributor_usage_events).
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '301-usage-events-workspace-id-fill-trigger.sql'), 'utf8')));
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '375-work-items-cdc-capture.sql'), 'utf8')));
  // G2: usage-events capture trigger (mirrors migration 108 — key column 'event_id').
  await sql.unsafe(`
    CREATE OR REPLACE TRIGGER capture_substrate_outbox_trg
      AFTER INSERT OR UPDATE OR DELETE ON harness_shared.contributor_usage_events
      FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('event_id');
  `);
}

/**
 * Per-peer scoped projection apply bound to THIS peer's `sql`, with the three
 * federated tables this file's ops touch (features + issues + usage). Threads
 * `ownLogKeyHex` so `applyOpVia` derives origin from log-source.
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
    buildUsageProjection(opts),
  ] as TableProjection<unknown>[]) {
    scoped.set(p.tableTag, p);
  }
  const lookup: ProjectionLookup = (tag) => scoped.get(tag) ?? null;
  return (op: OpEnvelope) => applyOpVia(lookup, op, { ownLogKeyHex });
}

// ── per-peer PG read helpers ────────────────────────────────────────────────
async function readFeature(sql: postgres.Sql, featureId: string) {
  const rows = await sql<
    Array<{
      feature_id: string;
      title: string | null;
      status: string | null;
      summary: string | null;
      origin: string;
      workspace_id: string;
      payload: unknown;
      tags: unknown;
      verified_author_github_user_id: string | number | null;
    }>
  >`
    SELECT feature_id, title, status, summary, origin, workspace_id, payload, tags,
           verified_author_github_user_id
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${HARNESS_SLUG} AND feature_id = ${featureId}
  `;
  return rows[0];
}

async function readUsage(sql: postgres.Sql, eventId: string) {
  const rows = await sql<
    Array<{
      event_id: string;
      github_user_id: string | number;
      device_pubkey: string;
      kind: string;
      ref_id: string | null;
      payload: unknown;
      origin: string;
      schema_version: string | number;
    }>
  >`
    SELECT event_id, github_user_id, device_pubkey, kind, ref_id, payload, origin, schema_version
      FROM harness_shared.contributor_usage_events
     WHERE harness_slug = ${HARNESS_SLUG} AND event_id = ${eventId}
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

interface BootedPeer {
  handle: BootedHarnessHandle;
  pg: postgres.Sql;
  identity: ReturnType<typeof makeIdentityOverride>;
}

interface TwoPeers {
  peerA: BootedPeer;
  peerB: BootedPeer;
  /** Drive one merge tick on both peers (real swarm has already crossed logs). */
  mergeBoth: () => Promise<void>;
}

/**
 * Extract of the template's inline boot: two fresh DBs, the local testnet DHT,
 * two real swarms, and two booted peers (A admits B, B admits A) whose REAL PG
 * projections write into the two SEPARATE databases. Returns both peers + a
 * `mergeBoth()` helper. Every resource is registered for afterEach teardown.
 */
async function bootTwoPeers(dbTag: string): Promise<TwoPeers> {
  const dbA: FreshPgDb = await createFreshPgDb(`${dbTag}A`);
  cleanups.push(() => dbA.cleanup());
  const dbB: FreshPgDb = await createFreshPgDb(`${dbTag}B`);
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

  const idA = makeIdentityOverride('alice', 42, 'kc-alice');
  const idB = makeIdentityOverride('bob', 7, 'kc-bob');
  const swarmA = makeSwarm(testnet.bootstrap);
  const swarmB = makeSwarm(testnet.bootstrap);
  const rootA = makeWorkspaceRoot(`${dbTag}-A-`);
  const rootB = makeWorkspaceRoot(`${dbTag}-B-`);

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

  // Both joined the swarm on the same topic.
  expect(peerA.handle.swarm).not.toBeNull();
  expect(peerB.handle.swarm).not.toBeNull();
  expect(peerA.handle.swarm!.topicHex).toBe(peerB.handle.swarm!.topicHex);

  const mergeBoth = async () => {
    await Promise.all([peerA.handle.mergeNow(), peerB.handle.mergeNow()]);
  };

  return { peerA, peerB, mergeBoth };
}

/** Insert a local feature on a peer (the production CDC entry-point). */
async function insertFeature(
  pg: postgres.Sql,
  featureId: string,
  fields: { title: string; status?: string; summary?: string; ts: number; payload?: unknown; tags?: unknown },
): Promise<void> {
  await pg`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts,
       payload, tags)
    VALUES (${HARNESS_SLUG}, ${featureId}, ${fields.title}, ${fields.summary ?? null},
            ${fields.status ?? 'todo'}, 0, 'local', ${fields.ts}, ${fields.ts}, ${fields.ts},
            ${fields.payload == null ? null : JSON.stringify(fields.payload)}::text::jsonb,
            ${fields.tags == null ? null : JSON.stringify(fields.tags)}::text::jsonb)
  `;
}

describe('Federation propagation edge cases — DELETE, usage-events, large payloads, rapid updates, author stamp', () => {
  // ── G1 [P1]: DELETE federates end-to-end + stale/newer resurrection semantics ──
  it(
    'G1: A deletes a federated feature → B removes it over the wire; a genuine recreate-after-delete resurrects on B',
    async () => {
      const { peerA, peerB, mergeBoth } = await bootTwoPeers('g1');

      // (1) A inserts F-del → drain → it lands on B (the precondition).
      await insertFeature(peerA.pg, 'F-del', { title: 'will be deleted', ts: 1_000 });
      expect(await countOutbox(peerA.pg, 'harness_features_consolidated', 'F-del')).toBe(1);
      await drainOutboxOnce(peerA.handle, peerA.pg);

      const landed = await pollUntil(
        async () => {
          await mergeBoth();
          return await readFeature(peerB.pg, 'F-del');
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(landed, 'F-del never reached B (precondition for the delete test)').toBeTruthy();
      expect(landed).toMatchObject({ feature_id: 'F-del', origin: 'remote' });

      // (2) A DELETEs F-del → the capture trigger enqueues a `del` outbox row
      // (reads OLD.origin='local'). Drain it → a `del` op on A's log → replicates.
      await peerA.pg`
        DELETE FROM harness_shared.harness_features_consolidated
         WHERE harness_slug = ${HARNESS_SLUG} AND feature_id = 'F-del'
      `;
      // The 102 trigger fires AFTER DELETE → one `del` outbox row.
      const delRows = await peerA.pg<Array<{ op: string }>>`
        SELECT op FROM harness_shared.substrate_outbox
         WHERE table_name = 'harness_features_consolidated' AND key = 'F-del' AND op = 'del'
      `;
      expect(delRows.length, 'DELETE did not enqueue a del outbox row (send side broken)').toBe(1);
      await drainOutboxOnce(peerA.handle, peerA.pg);

      // THE G1 ACCEPTANCE: B's row is REMOVED over the wire.
      const removed = await pollUntil(
        async () => {
          await mergeBoth();
          const row = await readFeature(peerB.pg, 'F-del');
          return row === undefined ? { gone: true } : undefined;
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(removed?.gone, 'A deleted F-del but it was NOT removed from B (DELETE did not federate)').toBe(
        true,
      );

      // (3a) A genuine RECREATE-after-delete (a normal local re-insert) is
      // causally LATER than the delete (handle.append stamps a monotone HLC on
      // every op, so the re-appended put's HLC > the del's HLC) → `lwwPick`
      // correctly picks the put → F-del RESURRECTS on B. This is the intended
      // behavior: a same-author write that happens-after a delete must win. (A
      // "stale" resurrection in this system can only come from a DIFFERENT peer
      // whose op carries an OLDER HLC; the same-peer del-guard direction is
      // covered by (3b), the guard that actually exists in deleteFromPg.)
      await peerA.pg`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${HARNESS_SLUG}, 'F-del', 'fresh recreate', 'todo', 0, 'local', 9000, 9000, 9000)
      `;
      await drainOutboxOnce(peerA.handle, peerA.pg);

      const resurrected = await pollUntil(
        async () => {
          await mergeBoth();
          return await readFeature(peerB.pg, 'F-del');
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(
        resurrected,
        'a genuine recreate (causally after the delete) did NOT resurrect the row on B',
      ).toBeTruthy();
      expect(resurrected).toMatchObject({ feature_id: 'F-del', title: 'fresh recreate', origin: 'remote' });
    },
    90_000,
  );

  // ── G1b [P1]: the del-guard — an HLC-STALE delete must NOT erase a NEWER put ──
  // The complement of G1: deletes leave no PG tombstone, so the "stale op doesn't
  // clobber" floor for deletes lives in `deleteFromPg`'s guard. D-001 (mig 314)
  // made that guard order by the HLC key (`fed_hlc`) — the same key the merge
  // fold uses — with a `fed_ts` fallback. So "stale" now means HLC-stale: B holds
  // a fresh put (high fed_hlc); a del op carrying a LOWER (older) HLC arrives over
  // the wire — the guard must REFUSE it so the row survives. (We force BOTH the
  // outbox ts AND op_hlc to construct the inversion. The merge fold may select the
  // del as the per-key winner; the PG-level guard is the independent second floor
  // read-merge.ts documents.)
  it(
    'G1b: a STALE delete (older fed_ts than B’s existing put) does NOT erase the row from B',
    async () => {
      const { peerA, peerB, mergeBoth } = await bootTwoPeers('g1b');

      // A inserts F-keep with a HIGH outbox capture-ts so B's stored fed_ts is high.
      await insertFeature(peerA.pg, 'F-keep', { title: 'must survive stale del', ts: 1_000 });
      // Force the put's outbox capture-ts to a large value → B's fed_ts is large.
      const HIGH_TS = 9_000_000_000_000; // far-future epoch-ms
      // D-001: also force the put's HLC HIGH so B stores a high fed_hlc — the new
      // ordering key the del-guard compares (fed_ts is now only the fallback).
      const HIGH_HLC = encodeHlc({ ms: HIGH_TS, count: 0 });
      await peerA.pg`
        UPDATE harness_shared.substrate_outbox
           SET ts = ${HIGH_TS}, op_hlc = ${HIGH_HLC}
         WHERE table_name = 'harness_features_consolidated' AND key = 'F-keep'
           AND op = 'put' AND drained_at IS NULL
      `;
      await drainOutboxOnce(peerA.handle, peerA.pg);

      const landed = await pollUntil(
        async () => {
          await mergeBoth();
          return await readFeature(peerB.pg, 'F-keep');
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(landed, 'F-keep never reached B (precondition)').toBeTruthy();

      // A DELETEs F-keep, but the del op carries a STALE ts (below B's fed_ts).
      await peerA.pg`
        DELETE FROM harness_shared.harness_features_consolidated
         WHERE harness_slug = ${HARNESS_SLUG} AND feature_id = 'F-keep'
      `;
      await peerA.pg`
        UPDATE harness_shared.substrate_outbox
           SET ts = ${HIGH_TS - 5_000_000}, op_hlc = ${encodeHlc({ ms: HIGH_TS - 5_000_000, count: 0 })}
         WHERE table_name = 'harness_features_consolidated' AND key = 'F-keep'
           AND op = 'del' AND drained_at IS NULL
      `;
      await drainOutboxOnce(peerA.handle, peerA.pg);

      // Merge repeatedly; the stale del must NOT erase B's newer-fed_ts row.
      for (let i = 0; i < 8; i++) await mergeBoth();
      const survived = await readFeature(peerB.pg, 'F-keep');
      expect(
        survived,
        'a STALE delete (older fed_ts than B’s put) erased the row from B — the deleteFromPg ts-guard failed',
      ).toBeTruthy();
      expect(survived).toMatchObject({ feature_id: 'F-keep', title: 'must survive stale del' });
    },
    90_000,
  );

  // ── G2 [P2]: contributor_usage_events (the 5th federated table) federates ──
  // The table is declared sync:'peer-log' (harness-state/table-registry.ts) with a
  // capture trigger (mig 108) + projection (projections/usage.ts) + op-mapper
  // (feature-issue-op-keys.toUsageValue). WI-192 added migration 301 (workspace_id
  // column + BEFORE-INSERT fill trigger from harness_shared.projects), so usage
  // events now carry a REAL workspace_id → the standard real-workspace drain
  // matches them and they federate END-TO-END (the prior gap: the outbox row was
  // stamped workspace_id='' and the drain dropped it). This test proves the full
  // capture→drain→swarm→projection→PG path through the STANDARD drain — no manual
  // workspace_id patching.
  it(
    'G2: a usage event on A federates to B with origin=remote and a byte-equal payload',
    async () => {
      const { peerA, peerB, mergeBoth } = await bootTwoPeers('g2');

      const eventId = 'U-fed-1';
      const payload = { feature_id: 'F-x', cost_cents: 1234, nested: { a: [1, 2, 3], b: 'str' } };
      // Mirrors emitUsageEvent (harness/usage-events.ts) byte-for-byte: it does
      // NOT set workspace_id. WI-192's BEFORE-INSERT fill trigger (mig 301)
      // resolves it from harness_shared.projects by slug before the row is stored.
      await peerA.pg`
        INSERT INTO harness_shared.contributor_usage_events
          (harness_slug, event_id, github_user_id, device_pubkey, kind, ref_id, payload, ts, schema_version, origin)
        VALUES (${HARNESS_SLUG}, ${eventId}, 42, ${peerA.identity.devicePubkey},
                'feature_authored', 'F-x',
                ${JSON.stringify(payload)}::text::jsonb,
                to_timestamp(1700 / 1000.0), 1, 'local')
      `;

      // The capture trigger (mig 108) enqueued exactly one row (send side works).
      expect(await countOutbox(peerA.pg, 'contributor_usage_events', eventId)).toBe(1);

      // ── WI-192 FIX (was the G2 FINDING gap): the outbox row now carries the REAL
      // workspace_id ──
      // The BEFORE-INSERT fill trigger (mig 301) resolved the row's workspace_id
      // from harness_shared.projects (slug 'sheets' → WORKSPACE_ID) before the
      // AFTER-INSERT capture trigger ran, so the outbox row is stamped with the
      // real workspace_id — NOT '' — and the real-workspace drain matches it.
      const [obox] = await peerA.pg<Array<{ workspace_id: string }>>`
        SELECT workspace_id FROM harness_shared.substrate_outbox
         WHERE table_name = 'contributor_usage_events' AND key = ${eventId}
      `;
      expect(
        obox.workspace_id,
        'WI-192: usage-events outbox rows must now carry the REAL workspace_id ' +
          '(the mig-301 fill trigger), not "". If this is "", the fill trigger did not fire — ' +
          'the federation fix regressed.',
      ).toBe(WORKSPACE_ID);

      // THE WI-192 ACCEPTANCE: the STANDARD drain (real-workspace filter, NO manual
      // workspace_id patching) now picks up the usage row → usage events federate
      // through the same path as features/issues.
      const drained = await drainOutboxOnce(peerA.handle, peerA.pg);
      expect(
        drained,
        'WI-192: the standard real-workspace drain did NOT pick up the usage row — ' +
          'usage events still do not federate (the mig-301 fill gap is not fixed).',
      ).toBeGreaterThanOrEqual(1);

      const onB = await pollUntil(
        async () => {
          await mergeBoth();
          return await readUsage(peerB.pg, eventId);
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(onB, 'usage event never reached B (G2 A→B failed)').toBeTruthy();
      expect(onB).toMatchObject({
        event_id: eventId,
        kind: 'feature_authored',
        ref_id: 'F-x',
        device_pubkey: peerA.identity.devicePubkey,
        origin: 'remote', // B received it from A's log → stamped remote (echo guard)
      });
      expect(Number(onB!.github_user_id)).toBe(42);
      // Byte-equal payload jsonb (deep-equal).
      expect(onB!.payload).toEqual(payload);

      // Echo guard: B did NOT re-enqueue the remote usage event (origin='remote').
      expect(
        await countOutbox(peerB.pg, 'contributor_usage_events', eventId),
        'B re-enqueued the federated usage event → append-only echo loop',
      ).toBe(0);
    },
    90_000,
  );

  // ── G3 [P2]: large jsonb payload federates intact (never silently truncated) ──
  it(
    'G3: a ~100KB jsonb payload — and a ~64KB boundary payload — federate INTACT (deep-equal)',
    async () => {
      const { peerA, peerB, mergeBoth } = await bootTwoPeers('g3');

      // Build a deterministic ~100KB jsonb value: an array of distinct strings so
      // any truncation/corruption changes deep-equality. Each entry ~100 bytes.
      const big = {
        marker: 'G3-100kb',
        items: Array.from({ length: 1000 }, (_, i) => ({
          i,
          s: `item-${i}-${'x'.repeat(80)}`,
        })),
      };
      const bigBytes = Buffer.byteLength(JSON.stringify(big));
      expect(bigBytes, 'fixture should be ~100KB').toBeGreaterThan(100_000);

      await insertFeature(peerA.pg, 'F-big', { title: 'big payload', ts: 1_000, payload: big });
      await drainOutboxOnce(peerA.handle, peerA.pg);

      const onB = await pollUntil(
        async () => {
          await mergeBoth();
          const row = await readFeature(peerB.pg, 'F-big');
          return row?.payload != null ? row : undefined;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(onB, 'the ~100KB-payload feature never reached B').toBeTruthy();
      // Deep-equal — the entire structure crossed intact, not truncated.
      expect(onB!.payload).toEqual(big);

      // A ~64KB boundary payload (Hypercore default block size ~64KB) on `tags`.
      const boundary = {
        marker: 'G3-64kb',
        blob: 'b'.repeat(64 * 1024),
      };
      const boundaryBytes = Buffer.byteLength(JSON.stringify(boundary));
      expect(boundaryBytes).toBeGreaterThanOrEqual(64 * 1024);

      await insertFeature(peerA.pg, 'F-64k', { title: 'boundary', ts: 2_000, tags: boundary });
      await drainOutboxOnce(peerA.handle, peerA.pg);

      const onB2 = await pollUntil(
        async () => {
          await mergeBoth();
          const row = await readFeature(peerB.pg, 'F-64k');
          return row?.tags != null ? row : undefined;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(onB2, 'the ~64KB-boundary feature never reached B').toBeTruthy();
      expect(onB2!.tags).toEqual(boundary);
      // Explicit truncation check: the blob length is exactly what we sent.
      expect((onB2!.tags as { blob: string }).blob.length).toBe(64 * 1024);
    },
    90_000,
  );

  // ── G4 [P2]: rapid successive updates converge B to the FINAL state ──
  it(
    'G4: 15+ rapid UPDATEs on A converge B to the FINAL state (never an intermediate), both batched and merge-between',
    async () => {
      const { peerA, peerB, mergeBoth } = await bootTwoPeers('g4');

      // ── Variant 1: 18 rapid UPDATEs, THEN drain + merge (batched). ──
      await insertFeature(peerA.pg, 'F-rapid', { title: 'v0', status: 'todo', ts: 1_000 });
      const N = 18;
      for (let i = 1; i <= N; i++) {
        const ts = 1_000 + i;
        await peerA.pg`
          UPDATE harness_shared.harness_features_consolidated
             SET title = ${`v${i}`}, summary = ${`s${i}`}, ts = ${ts}, updated_ts = ${ts}
           WHERE harness_slug = ${HARNESS_SLUG} AND feature_id = 'F-rapid'
        `;
      }
      const finalTitle = `v${N}`;
      // Drain ALL captured ops (the insert + N updates) to A's log.
      await drainOutboxOnce(peerA.handle, peerA.pg);

      const converged = await pollUntil(
        async () => {
          await mergeBoth();
          const row = await readFeature(peerB.pg, 'F-rapid');
          return row?.title === finalTitle ? row : undefined;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(converged, 'B never converged to the final rapid-update state').toBeTruthy();
      expect(converged!.title, 'B converged to an INTERMEDIATE rapid-update state, not the final one').toBe(
        finalTitle,
      );
      // Stays at the final value across more merges (no late intermediate re-apply).
      for (let i = 0; i < 4; i++) await mergeBoth();
      expect((await readFeature(peerB.pg, 'F-rapid'))!.title).toBe(finalTitle);

      // ── Variant 2: merge BETWEEN each update (no double-apply / stuck mid-state). ──
      await insertFeature(peerA.pg, 'F-rapid2', { title: 'w0', status: 'todo', ts: 5_000 });
      const M = 15;
      let lastTitle = 'w0';
      for (let i = 1; i <= M; i++) {
        const ts = 5_000 + i;
        lastTitle = `w${i}`;
        await peerA.pg`
          UPDATE harness_shared.harness_features_consolidated
             SET title = ${lastTitle}, ts = ${ts}, updated_ts = ${ts}
           WHERE harness_slug = ${HARNESS_SLUG} AND feature_id = 'F-rapid2'
        `;
        await drainOutboxOnce(peerA.handle, peerA.pg);
        await mergeBoth();
      }
      // After draining + merging each step, B must hold the LAST title (monotone
      // forward — an out-of-order intermediate can never clobber a newer one
      // thanks to the fed_ts LWW guard).
      const finalB = await pollUntil(
        async () => {
          await mergeBoth();
          const row = await readFeature(peerB.pg, 'F-rapid2');
          return row?.title === lastTitle ? row : undefined;
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(finalB, 'merge-between-each-update did not converge B to the final state').toBeTruthy();
      expect(finalB!.title).toBe(lastTitle);
    },
    120_000,
  );

  // ── G6 [P3]: verified_author_github_user_id semantics on apply ──
  it(
    'G6: B stamps verified_author_github_user_id=NULL on a remote feature with no pot_members attestation',
    async () => {
      const { peerA, peerB, mergeBoth } = await bootTwoPeers('g6');

      await insertFeature(peerA.pg, 'F-author', { title: 'authored by A', ts: 1_000 });
      await drainOutboxOnce(peerA.handle, peerA.pg);

      const onB = await pollUntil(
        async () => {
          await mergeBoth();
          return await readFeature(peerB.pg, 'F-author');
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(onB, 'F-author never reached B').toBeTruthy();
      expect(onB).toMatchObject({ feature_id: 'F-author', origin: 'remote' });

      // The harness-features projection (writeToPg) only resolves a verified gh id
      // when origin='remote' AND a non-revoked pot_members device attestation
      // maps author_pubkey → a github_user_id. This test peer schema has NO
      // pot_members table/rows, so `resolveVerifiedAuthorGithubId` cannot verify
      // the sender → the column MUST be NULL (the conservative "refuse the
      // fast-path" default the trust gate consumes). A non-NULL value here would
      // mean an UNVERIFIED self-claimed id was trusted — a trust-gate hole.
      expect(
        onB!.verified_author_github_user_id,
        'a remote feature with no verifiable attestation got a non-NULL verified_author_github_user_id ' +
          '(the trust gate must refuse to stamp an unverified id)',
      ).toBeNull();
    },
    90_000,
  );
});
