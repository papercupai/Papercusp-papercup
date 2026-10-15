/**
 * federation-content-matrix.repro.test.ts
 *
 * "ALL items that should be shared federate, BOTH directions" — a content-type ×
 * direction MATRIX over the SAME faithful 2-boot hermetic federation harness as
 * owner-content-to-joiner-faithful.repro.test.ts (real testnet-DHT swarm via
 * createTestnet + real testcontainer Postgres org DB; the REAL boot apply seam
 * `bootHarnessSubstrate` — NO applyOverride / NO resolveAuthorDevice stub on the
 * RECEIVER, so boot's real `joinerPotHomeSlug` rebind / owner-home fallback +
 * the `admittedIdentities → resolveAuthorDevice → resolveHiveMemberDeviceSet`
 * chain are on the path end-to-end).
 *
 * The faithful repro proves FEATURES owner→joiner. This file extends coverage to:
 *
 *   1. PLANS owner→joiner — the OWNER writes a `harness_plans` row (+ a
 *      `harness_plan_parts` row for the same plan) under its hive-home slug; assert
 *      BOTH materialize on the JOINER (origin='remote').
 *   2. WORK ITEMS joiner→owner — the JOINER (a member) writes a
 *      harness_features_consolidated row under its member slug; assert it
 *      materializes on the OWNER (origin='remote') via the owner-home content-guard
 *      fallback (WI-559/FED-1 direction).
 *   3. PLANS joiner→owner — same reverse direction for a plan (+ plan-part).
 *
 * SEND path for every case = the REAL mig-102/125/271 outbox trigger →
 * substrate_outbox → drainOutboxOnce → the peer's mergeNow (identical to the
 * features path the faithful repro drives). harness_plans federates as the
 * whole-blob `plans-by-slug` projection (membership-aware guard, like features);
 * harness_plan_parts federates as the `plan-parts` projection.
 *
 * PAPERCUSP_A003_TRACE=1 is set inside each test so the member-guard +
 * boot-resolution decisions print (grep `[A-003]`); console.error is redirected so
 * the repo's vitest-fail-on-console gate doesn't trip (same trick as the faithful
 * repro). The papercusp-plan-part-federation flag is pinned ON (its production
 * default) via PAPERCUSP_FLAG_* so the plan-parts projection's recompose path is
 * live and deterministic.
 *
 * RUN (real testcontainer PG):
 *   cd packages/operator-core && VITEST_UNIT_TIMEOUT_MS=180000 \
 *     npx vitest run lib/sync/hyperbee/__tests__/federation-content-matrix.repro.test.ts
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
import { bootHarnessSubstrate, type BootedHarnessHandle } from '../boot';
import { type HyperswarmLike } from '../swarm';
import type { OpEnvelope } from '../op-envelope-types';
import { _resetBootHistoryForTests } from '../boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';
import { drainOutboxOnce } from '../outbox-drain';
import { applyOpVia, type ProjectionLookup, type TableProjection } from '../projection';
import { buildHarnessFeaturesProjection } from '../projections/harness-features';
import { buildIssuesProjection } from '../projections/issues';
import { buildHarnessPlansProjection } from '../projections/harness-plans';
import { buildHarnessPlanPartsProjection } from '../projections/harness-plan-parts';
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

const __dirname = dirname(fileURLToPath(import.meta.url));
// .../packages/operator-core/lib/sync/hyperbee/__tests__ → repo root is six levels up.
const REPO_ROOT = resolve(__dirname, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

const WORKSPACE_ID = 'ws-fed-stage6';

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
 * harness_plans (mig 122) + its REAL federation capture triggers (mig 125), as a
 * test-friendly column SUPERSET (no RLS / grants / generated _search) bound to the
 * AUTHOR's throwaway DB. The capture function `capture_substrate_outbox` is created
 * by HARNESS_ISSUES_CONSOLIDATED_FED_DDL (applied first in setupPeerSchema), so this
 * only adds the table + triggers. Columns cover everything the harness-plans
 * projection INSERT consumes (initiative/template/template_data/promote_policy/
 * fed_ts/fed_hlc) so a captured row → op → remote apply round-trips faithfully.
 */
const HARNESS_PLANS_FED_DDL = `
  -- The shared HARNESS_FEATURES_CONSOLIDATED_DDL (applied FIRST in setupPeerSchema) creates a
  -- MINIMAL harness_plans stub (workspace_id, harness_slug, plan_slug, status — NO content) for
  -- the claim-path read-completeness doctrine. A bare CREATE TABLE IF NOT EXISTS below then
  -- NO-OPs against that stub (IF NOT EXISTS can't add columns), leaving \`content\` absent — so
  -- the capture UPDATE trigger's \`WHEN (OLD.content …)\` fails to create with
  -- \`column old.content does not exist\` (this test regressed the day the stub landed, EI-9524).
  -- Drop any prior stub so this AUTHORITATIVE full definition always wins; nothing has written
  -- harness_plans yet at this point in setupPeerSchema, so the drop is safe.
  DROP TABLE IF EXISTS harness_shared.harness_plans CASCADE;
  CREATE TABLE IF NOT EXISTS harness_shared.harness_plans (
    workspace_id  text NOT NULL,
    harness_slug  text NOT NULL,
    plan_slug     text NOT NULL,
    title         text,
    status        text,
    created       text,
    updated       text,
    owner         text,
    initiative    text,
    template      text,
    template_data jsonb,
    promote_policy jsonb,
    supersedes    text[] NOT NULL DEFAULT '{}'::text[],
    superseded_by text,
    content       text NOT NULL DEFAULT '',
    content_hash  text NOT NULL DEFAULT '',
    version       bigint NOT NULL DEFAULT 0,
    op_status     text,
    op_started_at timestamptz,
    op_updated_at timestamptz,
    current_wave  text,
    op_priority   integer,
    archived      boolean NOT NULL DEFAULT false,
    is_legacy     boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    author_pubkey text,
    origin        text NOT NULL DEFAULT 'local',
    fed_ts        bigint,
    fed_hlc       text,
    PRIMARY KEY (workspace_id, harness_slug, plan_slug)
  );
  DROP TRIGGER IF EXISTS capture_harness_plans_outbox_trg ON harness_shared.harness_plans;
  CREATE TRIGGER capture_harness_plans_outbox_trg
    AFTER INSERT OR DELETE ON harness_shared.harness_plans
    FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('plan_slug');
  DROP TRIGGER IF EXISTS capture_harness_plans_outbox_upd_trg ON harness_shared.harness_plans;
  CREATE TRIGGER capture_harness_plans_outbox_upd_trg
    AFTER UPDATE ON harness_shared.harness_plans
    FOR EACH ROW WHEN (
         OLD.content       IS DISTINCT FROM NEW.content
      OR OLD.content_hash  IS DISTINCT FROM NEW.content_hash
      OR OLD.title         IS DISTINCT FROM NEW.title
      OR OLD.status        IS DISTINCT FROM NEW.status
      OR OLD.created       IS DISTINCT FROM NEW.created
      OR OLD.updated       IS DISTINCT FROM NEW.updated
      OR OLD.owner         IS DISTINCT FROM NEW.owner
      OR OLD.supersedes    IS DISTINCT FROM NEW.supersedes
      OR OLD.superseded_by IS DISTINCT FROM NEW.superseded_by
      OR OLD.archived      IS DISTINCT FROM NEW.archived
      OR OLD.is_legacy     IS DISTINCT FROM NEW.is_legacy
    )
    EXECUTE FUNCTION harness_shared.capture_substrate_outbox('plan_slug');`;

/**
 * harness_plan_parts (mig 270) + its REAL capture triggers (mig 271), test-friendly
 * (no RLS) bound to the AUTHOR's throwaway DB. part_fed_key is the generated
 * `plan_slug || '/' || part_key` column the capture keys on + the projection's
 * composeKey. The capture trigger is NOT flag-gated at the SQL level (mig 271
 * attaches it unconditionally) — only the APP write-path is DARK — so a direct
 * origin='local' INSERT here fires capture exactly as production would post-cutover.
 */
const HARNESS_PLAN_PARTS_FED_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_plan_parts (
    workspace_id  text NOT NULL,
    harness_slug  text NOT NULL,
    plan_slug     text NOT NULL,
    part_key      text NOT NULL,
    kind          text NOT NULL,
    body          text NOT NULL DEFAULT '',
    ordinal       integer NOT NULL DEFAULT 0,
    fed_ts        bigint NOT NULL,
    author        text,
    tombstone     boolean NOT NULL DEFAULT false,
    origin        text NOT NULL DEFAULT 'local',
    part_fed_key  text GENERATED ALWAYS AS (plan_slug || '/' || part_key) STORED,
    created_at    bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
    updated_at    bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
    PRIMARY KEY (workspace_id, harness_slug, plan_slug, part_key)
  );
  DROP TRIGGER IF EXISTS capture_harness_plan_parts_outbox_trg ON harness_shared.harness_plan_parts;
  CREATE TRIGGER capture_harness_plan_parts_outbox_trg
    AFTER INSERT ON harness_shared.harness_plan_parts
    FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('part_fed_key');
  DROP TRIGGER IF EXISTS capture_harness_plan_parts_outbox_upd_trg ON harness_shared.harness_plan_parts;
  CREATE TRIGGER capture_harness_plan_parts_outbox_upd_trg
    AFTER UPDATE ON harness_shared.harness_plan_parts
    FOR EACH ROW WHEN (
      OLD.body IS DISTINCT FROM NEW.body
      OR OLD.ordinal IS DISTINCT FROM NEW.ordinal
      OR OLD.tombstone IS DISTINCT FROM NEW.tombstone
      OR OLD.kind IS DISTINCT FROM NEW.kind
      OR OLD.fed_ts IS DISTINCT FROM NEW.fed_ts
    )
    EXECUTE FUNCTION harness_shared.capture_substrate_outbox('part_fed_key');`;

/** Build the faithful federation schema in a peer's DB (features + issues + the real
 *  mig-375 work_items capture), THEN add the plans + plan-parts tables/capture. */
async function setupPeerSchema(sql: postgres.Sql, memberSlug: string): Promise<void> {
  await sql.unsafe(FRAMEWORK_ROLES_DDL);
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
  await sql`
    INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id, created_ts, updated_ts)
    VALUES ('p-fed', 'Fed', 'active', ${memberSlug}, ${WORKSPACE_ID}, 0, 0)
  `;
  await sql.unsafe(SUBSTRATE_OUTBOX_DDL);
  await sql.unsafe(FILL_WORKSPACE_ID_DDL);
  await sql.unsafe(HARNESS_ISSUES_CONSOLIDATED_FED_DDL); // defines capture_substrate_outbox
  await sql.unsafe(HARNESS_PLANS_FED_DDL);
  await sql.unsafe(HARNESS_PLAN_PARTS_FED_DDL);
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

/** The throwaway per-peer apply for the AUTHOR (its own content origin DB) — features,
 *  issues, plans, and plan-parts (all CDC-captured → skipOwnOps, so the author's own
 *  appended ops are no-ops here; the set just makes the lookup complete). */
function buildPeerApply(
  sql: postgres.Sql,
  authorSlug: string,
  ownLogKeyHex: string,
): (op: OpEnvelope) => Promise<boolean> {
  const opts = { workspaceId: WORKSPACE_ID, harnessSlug: authorSlug, sql };
  const scoped = new Map<string, TableProjection<unknown>>();
  for (const p of [
    buildHarnessFeaturesProjection(opts),
    buildIssuesProjection(opts),
    buildHarnessPlansProjection(opts),
    buildHarnessPlanPartsProjection(opts),
  ] as TableProjection<unknown>[]) {
    scoped.set(p.tableTag, p);
  }
  const lookup: ProjectionLookup = (tag) => scoped.get(tag) ?? null;
  return (op: OpEnvelope) => applyOpVia(lookup, op, { ownLogKeyHex });
}

async function readFeatureForSlug(sql: postgres.Sql, slug: string, featureId: string) {
  const rows = await sql<
    Array<{ feature_id: string; title: string | null; status: string | null; origin: string }>
  >`
    SELECT feature_id, title, status, origin
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${slug} AND feature_id = ${featureId}
  `;
  return rows[0];
}

async function readPlanForSlug(sql: postgres.Sql, slug: string, planSlug: string) {
  const rows = await sql<
    Array<{ plan_slug: string; title: string | null; status: string | null; content: string; origin: string }>
  >`
    SELECT plan_slug, title, status, content, origin
      FROM harness_shared.harness_plans
     WHERE harness_slug = ${slug} AND plan_slug = ${planSlug}
  `;
  return rows[0];
}

async function readPlanPartForSlug(sql: postgres.Sql, slug: string, planSlug: string, partKey: string) {
  const rows = await sql<
    Array<{ plan_slug: string; part_key: string; body: string; kind: string; origin: string }>
  >`
    SELECT plan_slug, part_key, body, kind, origin
      FROM harness_shared.harness_plan_parts
     WHERE harness_slug = ${slug} AND plan_slug = ${planSlug} AND part_key = ${partKey}
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

// ── Shared env / A-003-trace / flag scaffolding installed per-test (mirrors the
//    faithful repro). Returns the collected [A-003] lines for diagnostics. ──
function installTraceAndEnv(orgDb: OrgTestDb): { a003Lines: string[] } {
  const a003Lines: string[] = [];
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const line = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    if (line.includes('[A-003]')) a003Lines.push(line);
    process.stdout.write(line + '\n');
  });
  cleanups.push(() => {
    process.stdout.write(`\n===== [A-003] TRACE (${a003Lines.length} lines) =====\n`);
    for (const l of a003Lines) process.stdout.write(l + '\n');
    process.stdout.write('===== END [A-003] TRACE =====\n');
    errSpy.mockRestore();
  });

  const prevA003 = process.env.PAPERCUSP_A003_TRACE;
  process.env.PAPERCUSP_A003_TRACE = '1';
  // Pin papercusp-plan-part-federation ON (its production default) so the plan-parts
  // projection's recompose path is live + deterministic regardless of the box's flag store.
  const prevPartFlag = process.env.PAPERCUSP_FLAG_PAPERCUSP_PLAN_PART_FEDERATION;
  process.env.PAPERCUSP_FLAG_PAPERCUSP_PLAN_PART_FEDERATION = '1';
  cleanups.push(() => {
    if (prevA003 === undefined) delete process.env.PAPERCUSP_A003_TRACE;
    else process.env.PAPERCUSP_A003_TRACE = prevA003;
    if (prevPartFlag === undefined) delete process.env.PAPERCUSP_FLAG_PAPERCUSP_PLAN_PART_FEDERATION;
    else process.env.PAPERCUSP_FLAG_PAPERCUSP_PLAN_PART_FEDERATION = prevPartFlag;
  });

  const prevAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
  const prevAppUrl = process.env.HARNESS_DATABASE_URL;
  const prevWs = process.env.PAPERCUSP_WORKSPACE_ID;
  const prevSkipDisc = process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
  const prevPgb = process.env.PAPERCUSP_PGBOUNCER;
  process.env.HARNESS_ADMIN_DATABASE_URL = orgDb.adminDsn;
  process.env.HARNESS_DATABASE_URL = orgDb.appDsn;
  process.env.PAPERCUSP_WORKSPACE_ID = WORKSPACE_ID;
  process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
  process.env.PAPERCUSP_PGBOUNCER = '0';
  _resetUrlCacheForTests();
  _resetHarnessAdminUrlCacheForTests();
  void resetDbOrgPools();
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
  });
  return { a003Lines };
}

async function seedHive(
  orgDb: OrgTestDb,
  hiveHome: string,
  members: Array<{ userId: number; login: string; devicePubkey: string }>,
): Promise<void> {
  const { publicKey: hivePub } = generateKeyPairSync('ed25519');
  const hivePubkeyB64 = rawPubkeyBase64(hivePub);
  await orgDb.adminSql`
    INSERT INTO harness_shared.pots
      (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
    VALUES (${WORKSPACE_ID}, ${hiveHome}, decode(${hivePubkeyB64}, 'base64'),
            'kc-hive-home', 'Hive Home', null, 1, 1)
  `;
  for (const m of members) {
    await orgDb.adminSql`
      INSERT INTO harness_shared.pot_members
        (workspace_id, pot_home_slug, github_user_id, github_username,
         device_attestations, revoked_pubkeys, binding_status)
      VALUES (${WORKSPACE_ID}, ${hiveHome}, ${m.userId}, ${m.login},
              ${JSON.stringify([
                {
                  device_pubkey: m.devicePubkey,
                  gist_id: `gist-${m.login}`,
                  gist_url: `https://gist.github.com/${m.login}`,
                  device_label: `${m.login}-dev`,
                  created_at: 1,
                  signature_by_device: 'sig',
                },
              ])}::text::jsonb,
              '{}'::text[], 'verified')
    `;
  }
}

describe('federation content matrix — ALL shared content types federate BOTH directions (faithful 2-boot, real swarm + PG, NO stubs)', () => {
  // ────────────────────────────────────────────────────────────────────────────
  // DIRECTION A: OWNER → JOINER. Covers cases (1) plans→joiner [harness_plans] and
  // (2) plan-parts→joiner [harness_plan_parts]. The OWNER's slug IS the hive home;
  // the JOINER boots a member harness whose hive home is a remote_hive VIEW → boot's
  // real joinerPotHomeSlug rebind + membership chain are on the path.
  // ────────────────────────────────────────────────────────────────────────────
  it(
    'OWNER→JOINER: a harness_plans row (+ harness_plan_parts row) authored on the OWNER federates to the JOINER',
    async () => {
      const HIVE_HOME = 'owner-hive';
      const JOINER_SLUG = 'joined-owner-hive';

      const orgDb: OrgTestDb = await createOrgTestDb();
      cleanups.push(async () => {
        await orgDb?.cleanup();
      });
      installTraceAndEnv(orgDb);

      const idOwner = makeIdentityOverride('owner', 99, 'kc-owner');
      const idJoiner = makeIdentityOverride('joiner', 7, 'kc-joiner');

      await seedHive(orgDb, HIVE_HOME, [
        { userId: idOwner.userId, login: 'owner', devicePubkey: idOwner.devicePubkey },
        { userId: idJoiner.userId, login: 'joiner', devicePubkey: idJoiner.devicePubkey },
      ]);
      // Registry: HIVE_HOME a remote_hive VIEW (so the JOINER rebinds its hive-home
      // projection slug via joinerPotHomeSlug), JOINER_SLUG.hive_slug → HIVE_HOME.
      await mutateHarnessRegistry(
        (r) => ({
          ...r,
          projects: [
            ...r.projects,
            { slug: HIVE_HOME, path: '/tmp/owner-hive', harness_kind: 'hive', remote_hive: true },
            { slug: JOINER_SLUG, path: '/tmp/joiner', hive_slug: HIVE_HOME },
          ],
        }),
        WORKSPACE_ID,
      );

      const { potHomeSlugForHarness, joinerPotHomeSlug } = await import('../../../hive-federation');
      const { resolveHiveMemberDeviceSet } = await import('../hive-member-identity-set');
      expect(await potHomeSlugForHarness(WORKSPACE_ID, JOINER_SLUG)).toBe(HIVE_HOME);
      expect(await joinerPotHomeSlug(WORKSPACE_ID, JOINER_SLUG)).toBe(HIVE_HOME);
      expect((await resolveHiveMemberDeviceSet(WORKSPACE_ID, HIVE_HOME)).has(idOwner.devicePubkey)).toBe(true);
      _clearHiveMemberDeviceSetCacheForTest();

      const dbOwner: FreshPgDb = await createFreshPgDb('matrixOwnerHive');
      cleanups.push(() => dbOwner.cleanup());
      await setupPeerSchema(dbOwner.sql, HIVE_HOME);

      const hivePubRow = await orgDb.adminSql<Array<{ pk: string }>>`
        SELECT encode(public_key, 'base64') AS pk FROM harness_shared.pots
         WHERE workspace_id = ${WORKSPACE_ID} AND pot_home_slug = ${HIVE_HOME}
      `;
      const hivePubkeyB64 = hivePubRow[0]!.pk;

      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      const swarmOwner = makeSwarm(testnet.bootstrap);
      const swarmJoiner = makeSwarm(testnet.bootstrap);
      const rootOwner = makeWorkspaceRoot('matrix-owner-');
      const rootJoiner = makeWorkspaceRoot('matrix-joiner-');

      let handleOwner: BootedHarnessHandle | undefined;
      let handleJoiner: BootedHarnessHandle | undefined;
      let applyOwner: ((op: OpEnvelope) => Promise<boolean>) | undefined;

      // OWNER = AUTHOR (throwaway per-peer apply on its own content-origin DB).
      handleOwner = await bootHarnessSubstrate({
        workspaceRoot: rootOwner,
        workspaceId: WORKSPACE_ID,
        harnessSlug: HIVE_HOME,
        swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
        swarmOverride: swarmOwner,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idJoiner.userId ? 'verified' : 'fail',
        applyOverride: (op, ctx) => {
          applyOwner ??= buildPeerApply(dbOwner.sql, HIVE_HOME, ctx.ownLogKeyHex);
          return applyOwner(op);
        },
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idOwner.override,
      });
      cleanups.push(async () => {
        await handleOwner?.close();
        await closeHarnessStore({ workspaceRoot: rootOwner, harnessSlug: HIVE_HOME });
      });

      // JOINER = RECEIVER (REAL boot scopedApply → getOrgPg/orgDb; NO applyOverride).
      handleJoiner = await bootHarnessSubstrate({
        workspaceRoot: rootJoiner,
        workspaceId: WORKSPACE_ID,
        harnessSlug: JOINER_SLUG,
        swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
        swarmOverride: swarmJoiner,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idOwner.userId ? 'verified' : 'fail',
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idJoiner.override,
      });
      cleanups.push(async () => {
        await handleJoiner?.close();
        await closeHarnessStore({ workspaceRoot: rootJoiner, harnessSlug: JOINER_SLUG });
      });

      expect(handleOwner.swarm).not.toBeNull();
      expect(handleJoiner.swarm).not.toBeNull();
      expect(handleOwner.swarm!.topicHex).toBe(handleJoiner.swarm!.topicHex);

      // ── OWNER writes a PLAN (harness_plans) + a PLAN-PART (harness_plan_parts) under
      //    the hive-home slug → real capture → outbox → drain → owner's log. ──
      const planContent = '---\ntitle: Owner Plan\nstatus: active\n---\n\n## Items\n\n- **P-001** todo first\n';
      await dbOwner.sql`
        INSERT INTO harness_shared.harness_plans
          (workspace_id, harness_slug, plan_slug, title, status, created, updated, owner,
           supersedes, content, content_hash, version, origin)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, 'owner-plan-1', 'Owner Plan', 'active', '2026-06-29', '2026-06-29', 'owner',
                '{}'::text[], ${planContent}, 'hash-owner-1', 0, 'local')
      `;
      await dbOwner.sql`
        INSERT INTO harness_shared.harness_plan_parts
          (workspace_id, harness_slug, plan_slug, part_key, kind, body, ordinal, fed_ts, author, origin)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, 'owner-plan-1', 'item:P-001', 'item',
                '- **P-001** todo first', 10, 6101, ${idOwner.devicePubkey}, 'local')
      `;
      expect(await countOutbox(dbOwner.sql, 'harness_plans', 'owner-plan-1')).toBe(1);
      expect(await countOutbox(dbOwner.sql, 'harness_plan_parts', 'owner-plan-1/item:P-001')).toBe(1);
      const drained = await drainOutboxOnce(handleOwner, dbOwner.sql);
      expect(drained, "the owner's plan/part were not drained to its log").toBeGreaterThanOrEqual(2);

      // ── Precondition: the JOINER ADMITS the owner's log. ──
      const joinerAdmittedOwner =
        (await pollUntil(
          async () => {
            await Promise.all([handleOwner!.mergeNow(), handleJoiner!.mergeNow()]);
            return handleJoiner!.admitted.has(handleOwner!.ownLog.keyHex) ? true : undefined;
          },
          { timeoutMs: 20_000, intervalMs: 250 },
        )) ?? false;
      expect(joinerAdmittedOwner, "the JOINER did NOT admit the owner's log (STEP-1 admission)").toBe(true);

      // ── CASE 1 (plans→joiner): the owner's harness_plans row lands on the JOINER. ──
      const landedPlan = await pollUntil(
        async () => {
          await Promise.all([handleOwner!.mergeNow(), handleJoiner!.mergeNow()]);
          return (
            (await readPlanForSlug(orgDb.adminSql, HIVE_HOME, 'owner-plan-1')) ??
            (await readPlanForSlug(orgDb.adminSql, JOINER_SLUG, 'owner-plan-1'))
          );
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(landedPlan, 'CASE plans→joiner: the owner plan never reached the JOINER PG').toBeTruthy();
      expect(landedPlan).toMatchObject({ plan_slug: 'owner-plan-1', title: 'Owner Plan', origin: 'remote' });
      expect(landedPlan!.content).toContain('Owner Plan');

      // ── CASE 2 (plan-parts→joiner): harness_plan_parts — FIXED (D-027). ──
      // Previously a DOCUMENTED GAP: plan-parts' applyPart used ONLY a bare
      // `if (row.harness_slug !== opts.harnessSlug) return;` slug guard, so (unlike plan
      // ROWS) the owner's cross-slug part op was dropped on the JOINER — the plan document
      // crossed but its ITEMS silently did not. D-027 gave plan-parts the SAME WI-259
      // membership-aware guard (decideMemberContentOp) the 6 content projections use, and
      // routes the parts store + recompose under the op's AUTHORED slug (row.harness_slug,
      // == HIVE_HOME here), matching where harness-plans landed the plan document. The part
      // now federates: the owner's item:P-001 lands on the JOINER under the hive-home slug,
      // origin='remote'.
      for (let i = 0; i < 8; i++) await Promise.all([handleOwner!.mergeNow(), handleJoiner!.mergeNow()]);
      const partOnJoiner =
        (await readPlanPartForSlug(orgDb.adminSql, HIVE_HOME, 'owner-plan-1', 'item:P-001')) ??
        (await readPlanPartForSlug(orgDb.adminSql, JOINER_SLUG, 'owner-plan-1', 'item:P-001'));
      expect(
        partOnJoiner,
        'CASE plan-parts→joiner (D-027): the owner plan-part must now federate to the JOINER ' +
          'via the membership-aware guard added to harness-plan-parts.ts applyPart.',
      ).toBeTruthy();
      expect(partOnJoiner).toMatchObject({ part_key: 'item:P-001', origin: 'remote' });
    },
    180_000,
  );

  // ────────────────────────────────────────────────────────────────────────────
  // DIRECTION B: JOINER → OWNER. Covers cases (3) work-item joiner→owner
  // [harness_features_consolidated] and (4) plan joiner→owner [harness_plans] (+
  // plan-part reverse). The OWNER's RECEIVING harness IS the hive home, so it
  // exercises the owner-home content-guard fallback (WI-559/FED-1).
  // ────────────────────────────────────────────────────────────────────────────
  it(
    'JOINER→OWNER: a feature + a plan (+ plan-part) authored on the JOINER federate to the OWNER (owner-home fallback)',
    async () => {
      const HIVE_HOME = 'fed-owner-home';
      const MEMBER_SLUG = 'fed-member';

      const orgDb: OrgTestDb = await createOrgTestDb();
      cleanups.push(async () => {
        await orgDb?.cleanup();
      });
      installTraceAndEnv(orgDb);

      const idOwner = makeIdentityOverride('owner', 99, 'kc-owner');
      const idMember = makeIdentityOverride('member', 7, 'kc-member');

      await seedHive(orgDb, HIVE_HOME, [
        { userId: idMember.userId, login: 'member', devicePubkey: idMember.devicePubkey },
        { userId: idOwner.userId, login: 'owner', devicePubkey: idOwner.devicePubkey },
      ]);
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

      const { potHomeSlugForHarness } = await import('../../../hive-federation');
      const { resolveHiveMemberDeviceSet } = await import('../hive-member-identity-set');
      expect(await potHomeSlugForHarness(WORKSPACE_ID, HIVE_HOME)).toBe(HIVE_HOME);
      expect((await resolveHiveMemberDeviceSet(WORKSPACE_ID, HIVE_HOME)).has(idMember.devicePubkey)).toBe(true);
      _clearHiveMemberDeviceSetCacheForTest();

      const dbMember: FreshPgDb = await createFreshPgDb('matrixMember');
      cleanups.push(() => dbMember.cleanup());
      await setupPeerSchema(dbMember.sql, MEMBER_SLUG);

      const hivePubRow = await orgDb.adminSql<Array<{ pk: string }>>`
        SELECT encode(public_key, 'base64') AS pk FROM harness_shared.pots
         WHERE workspace_id = ${WORKSPACE_ID} AND pot_home_slug = ${HIVE_HOME}
      `;
      const hivePubkeyB64 = hivePubRow[0]!.pk;

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
      const rootOwner = makeWorkspaceRoot('matrix-fed-owner-');
      const rootMember = makeWorkspaceRoot('matrix-fed-member-');

      let handleOwner: BootedHarnessHandle | undefined;
      let handleMember: BootedHarnessHandle | undefined;
      let applyMember: ((op: OpEnvelope) => Promise<boolean>) | undefined;

      // OWNER = RECEIVER (REAL boot scopedApply → orgDb; owner-home fallback engages).
      handleOwner = await bootHarnessSubstrate({
        workspaceRoot: rootOwner,
        workspaceId: WORKSPACE_ID,
        harnessSlug: HIVE_HOME,
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

      // MEMBER (JOINER) = AUTHOR (throwaway per-peer apply on its own content-origin DB).
      handleMember = await bootHarnessSubstrate({
        workspaceRoot: rootMember,
        workspaceId: WORKSPACE_ID,
        harnessSlug: MEMBER_SLUG,
        swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
        swarmOverride: swarmMember,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idOwner.userId ? 'verified' : 'fail',
        applyOverride: (op, ctx) => {
          applyMember ??= buildPeerApply(dbMember.sql, MEMBER_SLUG, ctx.ownLogKeyHex);
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

      // ── MEMBER writes a FEATURE + a PLAN + a PLAN-PART under its member slug. ──
      await dbMember.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${MEMBER_SLUG}, 'F-member1', 'Member→owner feature', 'from member', 'todo', 0, 'local', 7001, 7001, 7001)
      `;
      const planContent = '---\ntitle: Member Plan\nstatus: active\n---\n\n## Items\n\n- **P-001** todo m\n';
      await dbMember.sql`
        INSERT INTO harness_shared.harness_plans
          (workspace_id, harness_slug, plan_slug, title, status, created, updated, owner,
           supersedes, content, content_hash, version, origin)
        VALUES (${WORKSPACE_ID}, ${MEMBER_SLUG}, 'member-plan-1', 'Member Plan', 'active', '2026-06-29', '2026-06-29', 'member',
                '{}'::text[], ${planContent}, 'hash-member-1', 0, 'local')
      `;
      await dbMember.sql`
        INSERT INTO harness_shared.harness_plan_parts
          (workspace_id, harness_slug, plan_slug, part_key, kind, body, ordinal, fed_ts, author, origin)
        VALUES (${WORKSPACE_ID}, ${MEMBER_SLUG}, 'member-plan-1', 'item:P-001', 'item',
                '- **P-001** todo m', 10, 7101, ${idMember.devicePubkey}, 'local')
      `;
      expect(await countOutbox(dbMember.sql, 'harness_features_consolidated', 'F-member1')).toBe(1);
      expect(await countOutbox(dbMember.sql, 'harness_plans', 'member-plan-1')).toBe(1);
      expect(await countOutbox(dbMember.sql, 'harness_plan_parts', 'member-plan-1/item:P-001')).toBe(1);
      const drained = await drainOutboxOnce(handleMember, dbMember.sql);
      expect(drained, "the member's feature/plan/part were not drained").toBeGreaterThanOrEqual(3);

      const ownerAdmittedMember =
        (await pollUntil(
          async () => {
            await Promise.all([handleOwner!.mergeNow(), handleMember!.mergeNow()]);
            return handleOwner!.admitted.has(handleMember!.ownLog.keyHex) ? true : undefined;
          },
          { timeoutMs: 20_000, intervalMs: 250 },
        )) ?? false;
      expect(ownerAdmittedMember, "the OWNER did NOT admit the member's log (STEP-1 admission)").toBe(true);

      // ── CASE 3 (work-item joiner→owner): the member feature lands on the OWNER. ──
      const landedFeature = await pollUntil(
        async () => {
          await Promise.all([handleOwner!.mergeNow(), handleMember!.mergeNow()]);
          return await readFeatureForSlug(orgDb.adminSql, MEMBER_SLUG, 'F-member1');
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(landedFeature, 'CASE work-item joiner→owner: the member feature never reached the OWNER PG').toBeTruthy();
      expect(landedFeature).toMatchObject({
        feature_id: 'F-member1',
        title: 'Member→owner feature',
        status: 'todo',
        origin: 'remote',
      });

      // ── CASE 4 (plan joiner→owner): the member harness_plans row lands on the OWNER. ──
      const landedPlan = await pollUntil(
        async () => {
          await Promise.all([handleOwner!.mergeNow(), handleMember!.mergeNow()]);
          return await readPlanForSlug(orgDb.adminSql, MEMBER_SLUG, 'member-plan-1');
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(landedPlan, 'CASE plan joiner→owner: the member plan never reached the OWNER PG').toBeTruthy();
      expect(landedPlan).toMatchObject({ plan_slug: 'member-plan-1', title: 'Member Plan', origin: 'remote' });

      // ── plan-part reverse (joiner→owner): harness_plan_parts. SAME DOCUMENTED GAP. ──
      // The member plan-part op is captured + drained + admitted & replicated (the
      // sibling member plan + feature on the SAME log applied above), but the OWNER's
      // plan-parts projection drops it at the SAME bare slug guard (opts.harnessSlug=
      // 'fed-owner-home' ≠ row.harness_slug='fed-member'; harness-plan-parts.ts:143).
      // The owner-home content-guard fallback that lets harness_plans/features cross
      // (decideMemberContentOp) is never consulted for plan-parts. Flips RED when fixed.
      for (let i = 0; i < 8; i++) await Promise.all([handleOwner!.mergeNow(), handleMember!.mergeNow()]);
      const partOnOwner =
        (await readPlanPartForSlug(orgDb.adminSql, MEMBER_SLUG, 'member-plan-1', 'item:P-001')) ??
        (await readPlanPartForSlug(orgDb.adminSql, HIVE_HOME, 'member-plan-1', 'item:P-001'));
      expect(
        partOnOwner,
        'CASE plan-part joiner→owner (D-027): the member plan-part must now federate to the ' +
          'OWNER via the membership-aware guard added to harness-plan-parts.ts applyPart.',
      ).toBeTruthy();
      expect(partOnOwner).toMatchObject({ part_key: 'item:P-001', origin: 'remote' });
    },
    180_000,
  );
});
