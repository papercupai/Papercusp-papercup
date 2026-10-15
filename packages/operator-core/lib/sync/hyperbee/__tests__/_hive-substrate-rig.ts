/**
 * _hive-substrate-rig.ts — a two-peer rig for the HIVE-LIFECYCLE federation suite
 * (shared-hive-federation-2026-06-08). Two REAL bootHarnessSubstrate Swarms of ONE
 * Hive on a loopback testnet DHT, each projecting the Hive's federated state
 * (`hive_members` admission + `hive_settings`) into its OWN throwaway PG via the
 * REAL projections + the REAL migration-189 / migration-186 capture triggers.
 *
 * This is the Hive-grain analog of `_cross-peer-rig.ts` (which federates presence)
 * and `feature-content-federation.integration.test.ts` (which federates feature/
 * issue content). It exists because the lifecycle gaps — dissolve / leave-hive
 * membership teardown (G24/G27), cross-hive grants (G25), hive_settings LWW (G26)
 * — all ride the SAME two federated tables (hive_members, hive_settings), and no
 * prior rig wires THOSE projections across two real peers.
 *
 * What is real vs stood-in is exactly the feature-content rig's boundary: two
 * corestores → two logs; real Hyperswarm/Noise over a local testnet DHT; real
 * verifyAnnounce; real capture triggers (mig 186 hive_settings + mig 189
 * hive_members); real outbox drain; real row→op mappers; real read-merge; real PG
 * projections on BOTH peers; two real Postgres databases. STOOD IN: the channel-2
 * GitHub-binding fetch → verifyBindingOverride admit-by-userId.
 */
import { expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { unsafeFederatedPotScope } from '../../../federated-pot-scope';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { moduleRepoRoot } from '../../../module-repo-root';
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
import { buildHiveMembersProjection } from '../projections/hive-members';
import { buildHiveSettingsProjection } from '../projections/hive-settings';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { drainCleanupsBounded } from './_cleanup-bounded';

const REPO_ROOT = moduleRepoRoot(import.meta.url);
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

// ── Shared identity / swarm constants. The Hive's home slug IS the projection
// demux scope — both peers project the SAME hive's ops. ──
export const WORKSPACE_ID = 'ws-hive-fed';
// WI-6312: branded at the rig's declaration so every consumer certifies once. The rig owns
// this synthetic slug end-to-end — it writes and reads it — so local == federated here.
export const HIVE_SLUG = unsafeFederatedPotScope(
  'acme-hive',
  'hive-substrate rig: the rig writes and reads its own synthetic hive home slug',
); // the Hive's home_slug
export const BINDING = {
  kind: 'local' as const,
  workspace_id: WORKSPACE_ID,
  harness_slug: HIVE_SLUG,
};

// ── Async resource teardown (newest-first). Drained by each file's afterEach. ──
export const cleanups: Array<() => void | Promise<void>> = [];
export async function rigAfterEach(): Promise<void> {
  // EI-10581: bound each teardown step + the whole drain. This rig closes several
  // real async resources per test (2 PG DBs, 2 Hyperswarms, a testnet DHT, temp
  // dirs); under load ONE hung close (e.g. `swarm.destroy()`) would block this
  // unbounded loop past vitest's 90s integration hookTimeout and redden a test whose
  // assertions already passed ("Hook timed out in 90000ms"). A hang/throw per step is
  // swallowed (a leaked handle at process exit is harmless); the drain never throws,
  // so the resets below ALWAYS run. On a healthy run every close settles far under the
  // bound, so behaviour is identical to the old loop — this only makes teardown fail
  // fast + clean, never slower.
  await drainCleanupsBounded(cleanups);
  _resetCacheForTests();
  _resetBootHistoryForTests();
}

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
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
}

export function makeIdentity(login: string, userId: number, keychainId: string) {
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

export async function pollUntil<T>(
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

/** Cluster-global framework roles the archive-102 outbox GRANTs reference. */
const FRAMEWORK_ROLES_DDL = `
  DO $r$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN CREATE ROLE harness_admin NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN CREATE ROLE harness_zero NOLOGIN; END IF;
  END $r$;
`;

function stripMeta(sqlText: string): string {
  return sqlText
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith('\\')) return false;
      if (/^(begin|commit);$/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

/**
 * Build the federation schema in a peer's DB from the REAL migrations: the
 * archive-102 outbox + generic capture fn, then 184 (hives) + 185 (hive_members
 * admission, FK→hives) + 189 (hive_members federation cols + custom capture) + 186
 * (hive_settings + its capture trigger). Both consolidated tables that mig 102's
 * generic triggers attach to are stubbed (column-faithful) first, exactly as the
 * hive_members-federation-trigger integration test does, so 102 loads.
 */
export async function setupHivePeerSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(FRAMEWORK_ROLES_DDL);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (
      workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
      feature_id TEXT NOT NULL, author_pubkey TEXT,
      origin TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (harness_slug, feature_id)
    );
    CREATE TABLE IF NOT EXISTS harness_shared.harness_issues_consolidated (
      workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
      issue_id TEXT NOT NULL, author_pubkey TEXT,
      origin TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (harness_slug, issue_id)
    );
  `);
  await sql.unsafe(readFileSync(resolve(SQL_DIR, 'archive/102-substrate-outbox.sql'), 'utf8'));
  for (const m of [
    '184-hives-table.sql',
    '185-hive-members-admission.sql',
    '189-hive-members-federation-cols.sql',
    '186-hive-settings.sql',
  ]) {
    await sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, m), 'utf8')));
  }
  await applyPot557RenameAndFixups(sql);
}

/**
 * EI-9396: shared by every test rig that hand-builds its federation-CRUD schema
 * from the PRE-rename archive migrations (184-hives-table / 185-hive-members-
 * admission / 189-hive-members-federation-cols / 186-hive-settings). Call this
 * AFTER applying whatever subset of those archive migrations the caller needs —
 * it forwards the schema to the pot_* names exactly as live migration 557 (cup-
 * lexicon phase 3) does, then re-applies the two post-557 trigger-body fixups
 * that a bare RENAME can't cover (mig 565 + its own prerequisites), so callers
 * never have to hand-roll (and re-discover the same bugs in) this block.
 * Every step is EXISTENCE-GUARDED (mirrors 557's own `to_regclass` idempotency
 * style) so it's safe to call regardless of which archive migrations a given
 * caller loaded (e.g. omitting 186 ⇒ no hive_settings ⇒ that rename is skipped).
 */
export async function applyPot557RenameAndFixups(sql: postgres.Sql): Promise<void> {
  // WI-3953 (mig 557, cup-lexicon phase 3): the live projections now target the
  // pot_* names. Rename the tables forward exactly as 557 does in production.
  // RENAME TABLE/COLUMN carries the PK/FK/index/policy AND the capture triggers
  // along automatically (there is no capture-fn fixup migration for hives/hive_
  // settings — they key off TG_TABLE_NAME, so the trigger follows).
  await sql.unsafe(`
    DO $$ BEGIN
      IF to_regclass('harness_shared.hives') IS NOT NULL AND to_regclass('harness_shared.pots') IS NULL THEN
        ALTER TABLE harness_shared.hives RENAME TO pots;
        ALTER TABLE harness_shared.pots RENAME COLUMN home_slug TO pot_home_slug;
      END IF;
    END $$;
    DO $$ BEGIN
      IF to_regclass('harness_shared.hive_members') IS NOT NULL AND to_regclass('harness_shared.pot_members') IS NULL THEN
        ALTER TABLE harness_shared.hive_members RENAME TO pot_members;
        ALTER TABLE harness_shared.pot_members RENAME COLUMN hive_home_slug TO pot_home_slug;
      END IF;
    END $$;
    DO $$ BEGIN
      IF to_regclass('harness_shared.hive_settings') IS NOT NULL AND to_regclass('harness_shared.pot_settings') IS NULL THEN
        ALTER TABLE harness_shared.hive_settings RENAME TO pot_settings;
      END IF;
    END $$;
    -- EI-18777176681958978: CONSTRAINTS DO NOT FOLLOW A TABLE RENAME — they keep their
    -- original names, so after the rename above this rig still carried 185's
    -- hive_members_hive_fkey / hive_members_pkey while production carries the 557 names.
    -- That is not cosmetic: a LATER migration that guards on the PRODUCTION constraint name
    -- SILENTLY NO-OPS here. Migration 686 (repoint pot_members_pot_fkey at
    -- canonical_pot_home_slug) does exactly that (AND c.conname = 'pot_members_pot_fkey'),
    -- so a test replaying 185 -> this helper -> 686 got an FK still demanding the LOCAL handle
    -- and a divergent-joiner INSERT failed with a constraint name that does not exist in the
    -- live DB (verified 2026-07-27: live pot_members has ONE fkey, pot_members_pot_fkey,
    -- already pointing at canonical_pot_home_slug). Mirror 557's explicit renames (its lines
    -- 74-75) so the rig's constraint names match production.
    DO $$ BEGIN
      IF to_regclass('harness_shared.pot_members') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hive_members_pkey'
                     AND conrelid = 'harness_shared.pot_members'::regclass) THEN
          ALTER TABLE harness_shared.pot_members RENAME CONSTRAINT hive_members_pkey TO pot_members_pkey;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hive_members_hive_fkey'
                     AND conrelid = 'harness_shared.pot_members'::regclass) THEN
          ALTER TABLE harness_shared.pot_members RENAME CONSTRAINT hive_members_hive_fkey TO pot_members_pot_fkey;
        END IF;
      END IF;
    END $$;
  `);
  // mig 565 (P-011 live-verification finding, 2026-07-11): ALTER TABLE ... RENAME COLUMN
  // does NOT rewrite function bodies — capture_hive_members_outbox() (mig 189/477's live
  // def) still hard-coded `v_row ->> 'hive_home_slug'` after the column above became
  // pot_home_slug, so that JSONB lookup silently returned NULL and every INSERT/DELETE on
  // pot_members hard-failed substrate_outbox's harness_slug NOT NULL constraint. Re-apply
  // the fixed trigger function (idempotent CREATE OR REPLACE) so this rig doesn't reproduce
  // the same bug the live migration had to patch. Only meaningful once pot_members exists.
  //
  // mig 565's body also writes substrate_outbox.op_hlc and calls harness_shared.hlc_now() —
  // both introduced by mig 314, which these rigs never apply (314's OTHER ALTER TABLEs touch
  // tables these minimal rigs don't have, e.g. harness_feature_prs/shared_presence, so loading
  // 314 wholesale would error). Inline just the two prerequisites 565 needs, verbatim from 314
  // (no GRANTs — the test connection already owns the schema).
  const [{ hasPotMembers, hasOutbox }] = await sql.unsafe<Array<{ hasPotMembers: boolean; hasOutbox: boolean }>>(`
    SELECT to_regclass('harness_shared.pot_members') IS NOT NULL AS "hasPotMembers",
           to_regclass('harness_shared.substrate_outbox') IS NOT NULL AS "hasOutbox"
  `);
  // Only meaningful when BOTH exist: no pot_members ⇒ nothing to capture; no substrate_outbox
  // ⇒ nowhere for the capture trigger to write (some rigs, e.g. hive-membership-store's, apply
  // 184/185/406 WITHOUT ever loading archive-102, so substrate_outbox never exists there).
  if (hasPotMembers && hasOutbox) {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS harness_shared.hlc_clock (
        id          smallint PRIMARY KEY DEFAULT 1,
        last_ms     bigint   NOT NULL DEFAULT 0,
        last_count  integer  NOT NULL DEFAULT 0,
        CONSTRAINT hlc_clock_singleton CHECK (id = 1)
      );
      INSERT INTO harness_shared.hlc_clock (id, last_ms, last_count)
        VALUES (1, 0, 0) ON CONFLICT (id) DO NOTHING;
      CREATE OR REPLACE FUNCTION harness_shared.hlc_now() RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER
        AS $fn$
      DECLARE
        now_ms  bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
        l_ms    bigint;
        l_count integer;
        n_ms    bigint;
        n_count integer;
      BEGIN
        SELECT last_ms, last_count INTO l_ms, l_count
          FROM harness_shared.hlc_clock WHERE id = 1 FOR UPDATE;
        IF l_ms IS NULL THEN
          INSERT INTO harness_shared.hlc_clock (id, last_ms, last_count) VALUES (1, 0, 0)
            ON CONFLICT (id) DO NOTHING;
          l_ms := 0; l_count := 0;
        END IF;
        IF now_ms > l_ms THEN
          n_ms := now_ms; n_count := 0;
        ELSIF l_count >= 65535 THEN
          n_ms := l_ms + 1; n_count := 0;
        ELSE
          n_ms := l_ms; n_count := l_count + 1;
        END IF;
        UPDATE harness_shared.hlc_clock SET last_ms = n_ms, last_count = n_count WHERE id = 1;
        RETURN lpad(n_ms::text, 15, '0') || ':' || lpad(n_count::text, 5, '0');
      END;
      $fn$;
      ALTER TABLE harness_shared.substrate_outbox ADD COLUMN IF NOT EXISTS op_hlc TEXT;
    `);
    await sql.unsafe(
      stripMeta(readFileSync(resolve(SQL_DIR, '565-fix-capture-hive-members-outbox-pot-rename.sql'), 'utf8')),
    );
  }
  // D-001 (mig 314): the fed_hlc ordering column the pot projections now write — needed
  // whenever the table exists, independent of whether substrate_outbox/capture-trigger
  // machinery is also present (e.g. hive-membership-store's rig applies 184/185/406 without
  // ever loading archive-102, so it has pot_members but no substrate_outbox at all).
  if (hasPotMembers) {
    await sql.unsafe(`ALTER TABLE harness_shared.pot_members ADD COLUMN IF NOT EXISTS fed_hlc TEXT`);
  }
  if ((await sql.unsafe(`SELECT to_regclass('harness_shared.pot_settings') AS t`))[0]?.t) {
    await sql.unsafe(`ALTER TABLE harness_shared.pot_settings ADD COLUMN IF NOT EXISTS fed_hlc TEXT`);
  }
  // EI-6983-class gap (mig 495): the drainer's own-log-key attribution column on
  // substrate_outbox, written by outbox-drain.ts's drainOutboxOnce. These rigs only
  // apply the archive-102 baseline for that table, which predates mig 495.
  if ((await sql.unsafe(`SELECT to_regclass('harness_shared.substrate_outbox') AS t`))[0]?.t) {
    await sql.unsafe(`ALTER TABLE harness_shared.substrate_outbox ADD COLUMN IF NOT EXISTS drained_log_key TEXT`);
  }
  // WI-559 (mig 686): the FEDERATED scope key on the Pot identity row. These rigs build
  // `pots` from archive-184 + the 557 rename, both of which predate 686 — but hive-store's
  // SELECT_COLS reads `canonical_pot_home_slug` UNCONDITIONALLY on every SELECT/RETURNING,
  // so without this column insertHiveIfAbsent() throws `column "canonical_pot_home_slug"
  // does not exist` and takes down every rig-built suite in beforeAll. That is exactly what
  // happened when 686 landed: 13 files use this rig and none of them reference the gym or
  // the pots schema directly, so the breakage surfaced far from its cause.
  //
  // Deliberately NULLABLE here, unlike production. 686 makes it NOT NULL and installs a
  // BEFORE-INSERT trigger defaulting it to pot_home_slug; the rig would have to mirror the
  // trigger too, or every INSERT that omits the column (hive-store's COLS omits it ON
  // PURPOSE — see its comment) would fail. Nullable + the backfill below is behaviorally
  // equivalent for these tests, because rowToRecord resolves
  // `canonical_pot_home_slug ?? pot_home_slug` — the same value 686 backfills, so the
  // fallback can never disagree with the stored column.
  if ((await sql.unsafe(`SELECT to_regclass('harness_shared.pots') AS t`))[0]?.t) {
    await sql.unsafe(
      `ALTER TABLE harness_shared.pots ADD COLUMN IF NOT EXISTS canonical_pot_home_slug TEXT`,
    );
    await sql.unsafe(
      `UPDATE harness_shared.pots SET canonical_pot_home_slug = pot_home_slug WHERE canonical_pot_home_slug IS NULL`,
    );
  }
}

/** Per-peer apply over the REAL hive_members + hive_settings projections bound to
 *  THIS peer's `sql`, demuxed to HIVE_SLUG (the Hive home scope). */
export function buildHivePeerApply(sql: postgres.Sql, ownLogKeyHex: string): (op: OpEnvelope) => Promise<boolean> {
  const opts = { workspaceId: WORKSPACE_ID, harnessSlug: HIVE_SLUG, sql };
  const projections = [
    buildHiveMembersProjection(opts) as TableProjection<unknown>,
    buildHiveSettingsProjection(opts) as TableProjection<unknown>,
  ];
  const scoped = new Map<string, TableProjection<unknown>>(projections.map((p) => [p.tableTag, p]));
  const lookup: ProjectionLookup = (tag) => scoped.get(tag) ?? null;
  return (op: OpEnvelope) => applyOpVia(lookup, op, { ownLogKeyHex });
}

/** Optional self-heal re-peer cadence overrides (WI-1534/WI-3593) — forwarded
 *  verbatim to `bootHarnessSubstrate`'s `swarmRefreshMs`/`swarmFastWindowMs`/
 *  `swarmSlowRefreshMs`. Omitted ⇒ production defaults (existing callers are
 *  byte-identical). `refreshMs: 0` disables the self-heal loop entirely (the
 *  pre-WI-752 control case). */
export interface SwarmTimingOverride {
  refreshMs?: number;
  fastWindowMs?: number;
  slowRefreshMs?: number;
  stalledMaxRefreshMs?: number;
}

export interface HivePeer {
  handle: BootedHarnessHandle;
  pg: postgres.Sql;
  identity: ReturnType<typeof makeIdentity>;
  drain: () => Promise<number>;
  /** The REAL Hyperswarm instance backing this peer (test-only escape hatch —
   *  e.g. to force a real socket disconnect via `[...rawSwarm.connections]`,
   *  simulating a network partition without any owner-side write). */
  rawSwarm: HyperswarmLike & { connections: Set<unknown> };
}

async function bootHivePeer(opts: {
  testnetBootstrap: unknown;
  rootPrefix: string;
  identity: ReturnType<typeof makeIdentity>;
  pg: postgres.Sql;
  verify: (userId: number) => 'verified' | 'pending' | 'fail';
  swarmTiming?: SwarmTimingOverride;
}): Promise<HivePeer> {
  const root = makeWorkspaceRoot(opts.rootPrefix);
  const rawSwarm = makeSwarm(opts.testnetBootstrap) as HyperswarmLike & { connections: Set<unknown> };
  let handle: BootedHarnessHandle | undefined;
  let apply: ((op: OpEnvelope) => Promise<boolean>) | undefined;
  handle = await bootHarnessSubstrate({
    workspaceRoot: root,
    workspaceId: WORKSPACE_ID,
    harnessSlug: HIVE_SLUG,
    swarmBinding: BINDING,
    swarmOverride: rawSwarm,
    verifyBindingOverride: async (_pk, _login, userId) => opts.verify(userId),
    // ctx, not `handle`: a merge pass can run before bootHarnessSubstrate returns
    // (a rejoining peer already holds admitted logs) — WI-6554700010008561.
    applyOverride: (op, ctx) => {
      apply ??= buildHivePeerApply(opts.pg, ctx.ownLogKeyHex);
      return apply(op);
    },
    mergePollMs: 0,
    pendingRetryMs: 0,
    reverifyIntervalMs: 0,
    loadRevokedOverride: async () => new Set(),
    announceIdentityOverride: opts.identity.override,
    swarmRefreshMs: opts.swarmTiming?.refreshMs,
    swarmFastWindowMs: opts.swarmTiming?.fastWindowMs,
    swarmSlowRefreshMs: opts.swarmTiming?.slowRefreshMs,
    swarmStalledMaxRefreshMs: opts.swarmTiming?.stalledMaxRefreshMs,
  });
  cleanups.push(async () => {
    await handle?.close();
    await closeHarnessStore({ workspaceRoot: root, harnessSlug: HIVE_SLUG });
  });
  return { handle, pg: opts.pg, identity: opts.identity, drain: () => drainOutboxOnce(handle!, opts.pg), rawSwarm };
}

/** Insert the Hive identity row (FK parent for hive_members) into a peer's DB. */
export async function seedHive(sql: postgres.Sql, slug = HIVE_SLUG): Promise<void> {
  await sql`
    INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${WORKSPACE_ID}, ${slug}, ${Buffer.from([0])}, ${'kc-' + slug}, 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING
  `;
}

/** Read the github_user_ids currently in a peer's hive_members for HIVE_SLUG. */
export async function memberUserIds(sql: postgres.Sql, slug = HIVE_SLUG): Promise<Set<number>> {
  const rows = await sql<Array<{ github_user_id: number }>>`
    SELECT github_user_id FROM harness_shared.pot_members
     WHERE workspace_id = ${WORKSPACE_ID} AND pot_home_slug = ${slug}
  `;
  return new Set(rows.map((r) => Number(r.github_user_id)));
}

/** Read the JSON-decoded hive_settings value for a key on a peer (null if unset). */
export async function settingValue(sql: postgres.Sql, key: string, slug = HIVE_SLUG): Promise<unknown> {
  const rows = await sql<Array<{ value: string | null }>>`
    SELECT value FROM harness_shared.pot_settings
     WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${slug} AND setting_key = ${key}
  `;
  const raw = rows[0]?.value;
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Boot two Swarms of ONE Hive over the real wire, with the Hive identity seeded on
 * both. Returns both peers + DBs. The Hive members / settings are seeded by the
 * caller (each gap seeds what it needs), then federated via drainBoth + mergeBoth.
 */
export async function bootTwoHivePeers(opts?: { swarmTiming?: SwarmTimingOverride }) {
  const dbA: FreshPgDb = await createFreshPgDb('hiveFedA');
  cleanups.push(() => dbA.cleanup());
  const dbB: FreshPgDb = await createFreshPgDb('hiveFedB');
  cleanups.push(() => dbB.cleanup());
  await setupHivePeerSchema(dbA.sql);
  await setupHivePeerSchema(dbB.sql);
  await seedHive(dbA.sql);
  await seedHive(dbB.sql);

  // Confirm they are genuinely different databases (the meaningfulness precondition).
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

  const idA = makeIdentity('alice', 42, 'kc-alice');
  const idB = makeIdentity('bob', 7, 'kc-bob');

  // Each Swarm admits the OTHER's userId (mutual admission).
  const peerB = await bootHivePeer({
    testnetBootstrap: testnet.bootstrap,
    rootPrefix: 'hivefed-B-',
    identity: idB,
    pg: dbB.sql,
    verify: (uid) => (uid === idA.userId ? 'verified' : 'fail'),
    swarmTiming: opts?.swarmTiming,
  });
  const peerA = await bootHivePeer({
    testnetBootstrap: testnet.bootstrap,
    rootPrefix: 'hivefed-A-',
    identity: idA,
    pg: dbA.sql,
    verify: (uid) => (uid === idB.userId ? 'verified' : 'fail'),
    swarmTiming: opts?.swarmTiming,
  });

  expect(peerA.handle.swarm).not.toBeNull();
  expect(peerB.handle.swarm).not.toBeNull();
  expect(peerA.handle.swarm!.topicHex).toBe(peerB.handle.swarm!.topicHex);

  const mergeBoth = () => Promise.all([peerA.handle.mergeNow(), peerB.handle.mergeNow()]);
  const drainBoth = async () => (await peerA.drain()) + (await peerB.drain());

  return { dbA, dbB, idA, idB, peerA, peerB, mergeBoth, drainBoth };
}
