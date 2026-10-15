/**
 * owner-content-to-joiner-faithful.repro.test.ts
 *
 * FAITHFUL hermetic reproduction of the shared-hive OWNER→JOINER content gap.
 *
 * THE BUG (plan shared-hive-member-content-federation-2026-06-20): when the hive
 * OWNER writes content (a feature row in `harness_features_consolidated`) to its OWN
 * hive-home harness, that content does NOT materialize on a JOINER peer — even at
 * epoch 0 (plaintext, no encryption). Membership/roster federates fine; content rows
 * don't.
 *
 * WHY THE EXISTING TESTS DON'T CATCH IT (D-015): the green WI-259 P-002 close-gate
 * case and the WI-261/WI-259 cases all inject an `applyOverride` carrying a HARDCODED
 * `resolveAuthorDevice` stub + a hardcoded `potHomeSlug`. That stub short-circuits
 * boot's REAL apply seam (`admittedIdentities → resolveAuthorDevice →
 * resolveHiveMemberDeviceSet`), so the boot-resolution path the live witness depends on
 * is never exercised. The WI-559/FED-1 case is faithful but only for the OTHER direction
 * (MEMBER → OWNER, receiver = the hive-home owner via the `ownPotHomeSlug` fallback).
 *
 * THIS CASE is the FAITHFUL OWNER→JOINER proof — the direction WI-559 didn't cover:
 *  - The RECEIVER is the JOINER (a member harness whose hive home is a `remote_hive`
 *    VIEW). It boots with the REAL `bootHarnessSubstrate` scopedApply — NO
 *    `applyOverride`, NO stubbed `resolveAuthorDevice` — so boot's real
 *    `joinerPotHomeSlug` rebind AND the real `admittedIdentities → resolveAuthorDevice
 *    → resolveHiveMemberDeviceSet` chain are on the path end-to-end.
 *  - The OWNER (hive-home harness, slug IS the hive home) is the AUTHOR; it uses the
 *    throwaway per-peer `buildPeerApply` (its own content origin DB) exactly as the
 *    WI-559 member author does — its own apply is irrelevant to the assertion.
 *  - getOrgPg() is env-routed at a migrated org DB (harness_admin → RLS-bypass) so the
 *    JOINER's real projections write there, and boot's membership/registry reads
 *    (joinerPotHomeSlug, potHomeSlugForHarness, loadHiveMembers,
 *    resolveHiveMemberDeviceSet) all resolve against the seeded
 *    hives/pot_members/harness_registry there too.
 *  - pot_members seeds BOTH the owner device AND the joiner device as current verified
 *    members of the hive (the realistic post-membership-federation state).
 *
 * PAPERCUSP_A003_TRACE=1 is set inside the test so the member-guard + boot-resolution
 * decisions print (grep `[A-003]`).
 *
 * RUN (integration layer — real testcontainer PG):
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     --include '**\/owner-content-to-joiner-faithful.repro.test.ts'
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
// buildPeerApply (the author's throwaway apply) hardcodes this slug; the owner authors
// under HIVE_HOME, so its own merge-back is dropped by buildPeerApply's slug guard — a
// no-op (we never assert on the owner's own DB). Mirrors the WI-559 member author.
const HARNESS_SLUG = 'sheets';

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

/** Build the minimal-but-faithful federation schema in a peer's DB, then apply the REAL
 *  migration capture/fill SQL — mirrors feature-content-federation.integration.test.ts. */
async function setupPeerSchema(sql: postgres.Sql, memberSlug: string = HARNESS_SLUG): Promise<void> {
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

/** The throwaway per-peer apply for the AUTHOR (its own content origin DB). Copied
 *  verbatim from feature-content-federation.integration.test.ts. */
function buildPeerApply(sql: postgres.Sql, ownLogKeyHex: string): (op: OpEnvelope) => Promise<boolean> {
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

async function countOutbox(sql: postgres.Sql, table: string, key: string): Promise<number> {
  const rows = await sql<Array<{ n: string | number }>>`
    SELECT COUNT(*)::int AS n FROM harness_shared.substrate_outbox
     WHERE table_name = ${table} AND key = ${key}
  `;
  return Number(rows[0]?.n ?? 0);
}

describe('FAITHFUL repro — OWNER writes to its hive-home harness; does it federate to a JOINER? (real boot apply seam, NO stub)', () => {
  it(
    'an OWNER-authored feature on the hive-home harness federates-and-applies to a JOINER peer via the REAL boot scopedApply',
    async () => {
      const HIVE_HOME = 'owner-hive'; // the OWNER's harness slug IS the hive home
      const JOINER_SLUG = 'joined-owner-hive'; // the joiner's from-repo member slug (≠ the home)

      // ── A-003 trace ON so member-guard + boot-resolution decisions print. The repo's
      //    vitest-fail-on-console setup fails any test that calls console.error, and the
      //    [A-003] trace uses console.error — so capture it: redirect every console.error
      //    to stdout (still visible in output) and collect the [A-003] lines for diagnostics.
      //    This bypasses fail-on-console's recording wrapper WITHOUT suppressing the trace. ──
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
      cleanups.push(() => {
        if (prevA003 === undefined) delete process.env.PAPERCUSP_A003_TRACE;
        else process.env.PAPERCUSP_A003_TRACE = prevA003;
      });

      // ── Env-route getOrgPg() at a migrated org DB: the JOINER's REAL scopedApply writes here
      //    (getOrgPg = harness_admin, RLS-bypass) AND boot's joiner-rebind + STEP-1 + guard reads
      //    (joinerPotHomeSlug / potHomeSlugForHarness / loadHiveMembers / resolveHiveMemberDeviceSet)
      //    all resolve here. Mirrors the WI-559/FED-1 env-routing exactly. ──
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
      const idJoiner = makeIdentityOverride('joiner', 7, 'kc-joiner');

      // ── Seed the hive + BOTH members in the org DB. ──
      const { publicKey: hivePub } = generateKeyPairSync('ed25519');
      const hivePubkeyB64 = rawPubkeyBase64(hivePub);
      await orgDb.adminSql`
        INSERT INTO harness_shared.pots
          (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, decode(${hivePubkeyB64}, 'base64'),
                'kc-owner-home', 'Owner Home', null, 1, 1)
      `;
      // OWNER membership row — its device_attestations carries the owner's REAL announce
      // device_pubkey, so resolveHiveMemberDeviceSet(HIVE_HOME) contains it (the content guard
      // applies the owner's cross-member op iff its source-log device ∈ this set).
      await orgDb.adminSql`
        INSERT INTO harness_shared.pot_members
          (workspace_id, pot_home_slug, github_user_id, github_username,
           device_attestations, revoked_pubkeys, binding_status)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${idOwner.userId}, 'owner',
                ${JSON.stringify([
                  {
                    device_pubkey: idOwner.devicePubkey,
                    gist_id: 'gist-owner',
                    gist_url: 'https://gist.github.com/owner',
                    device_label: 'owner-dev',
                    created_at: 1,
                    signature_by_device: 'sig',
                  },
                ])}::text::jsonb,
                '{}'::text[], 'verified')
      `;
      // JOINER membership row too (the realistic post-membership-federation state — both peers
      // are current verified members of the hive on both peers, which share this getOrgPg DB).
      await orgDb.adminSql`
        INSERT INTO harness_shared.pot_members
          (workspace_id, pot_home_slug, github_user_id, github_username,
           device_attestations, revoked_pubkeys, binding_status)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${idJoiner.userId}, 'joiner',
                ${JSON.stringify([
                  {
                    device_pubkey: idJoiner.devicePubkey,
                    gist_id: 'gist-joiner',
                    gist_url: 'https://gist.github.com/joiner',
                    device_label: 'joiner-dev',
                    created_at: 1,
                    signature_by_device: 'sig',
                  },
                ])}::text::jsonb,
                '{}'::text[], 'verified')
      `;
      // Registry: HIVE_HOME materialized as a `remote_hive` VIEW so the JOINER's boot resolves
      // its hive-home projection slug via `joinerPotHomeSlug` (the real rebind, no override),
      // and JOINER_SLUG's `hive_slug` points at HIVE_HOME so potHomeSlugForHarness(JOINER)→HIVE_HOME.
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

      // ── Sanity: the SAME getOrgPg()-backed reads boot makes resolve as the repro relies on. ──
      const { potHomeSlugForHarness, joinerPotHomeSlug } = await import('../../../hive-federation');
      const { resolveHiveMemberDeviceSet } = await import('../hive-member-identity-set');
      expect(await potHomeSlugForHarness(WORKSPACE_ID, JOINER_SLUG)).toBe(HIVE_HOME);
      // The keystone for an OWNER→JOINER repro: the joiner must REBIND to the hive home.
      expect(await joinerPotHomeSlug(WORKSPACE_ID, JOINER_SLUG)).toBe(HIVE_HOME);
      const seededSet = await resolveHiveMemberDeviceSet(WORKSPACE_ID, HIVE_HOME);
      expect(seededSet.has(idOwner.devicePubkey)).toBe(true);
      _clearHiveMemberDeviceSetCacheForTest(); // drop the sanity-read cache so boot re-reads fresh

      // ── The OWNER author's per-peer content-origin DB (its own member slug = the hive home). ──
      const dbOwner: FreshPgDb = await createFreshPgDb('ownerhive');
      cleanups.push(() => dbOwner.cleanup());
      await setupPeerSchema(dbOwner.sql, HIVE_HOME);

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
      const rootOwner = makeWorkspaceRoot('owner-hive-');
      const rootJoiner = makeWorkspaceRoot('joiner-');

      let handleOwner: BootedHarnessHandle | undefined;
      let handleJoiner: BootedHarnessHandle | undefined;
      let applyOwner: ((op: OpEnvelope) => Promise<boolean>) | undefined;

      // ── Boot the OWNER (AUTHOR): harnessSlug = the hive home; throwaway per-peer apply (its
      //    own content origin DB). Both peers derive the SAME topic from the hive pubkey. ──
      handleOwner = await bootHarnessSubstrate({
        workspaceRoot: rootOwner,
        workspaceId: WORKSPACE_ID,
        harnessSlug: HIVE_HOME,
        swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
        swarmOverride: swarmOwner,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idJoiner.userId ? 'verified' : 'fail',
        applyOverride: (op, ctx) => {
          applyOwner ??= buildPeerApply(dbOwner.sql, ctx.ownLogKeyHex);
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

      // ── Boot the JOINER (RECEIVER): member slug JOINER_SLUG; NO applyOverride → the REAL boot
      //    scopedApply (getOrgPg → orgDb). This is what exercises the REAL
      //    joinerPotHomeSlug rebind + admittedIdentities → resolveAuthorDevice →
      //    resolveHiveMemberDeviceSet chain — the seam the existing tests stub. ──
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

      // ── The OWNER writes a feature (work_item) under the hive-home slug → real trigger → outbox
      //    → drain → owner's log. ──
      await dbOwner.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${HIVE_HOME}, 'F-owner1', 'Owner→joiner feature', 'from owner', 'todo', 0, 'local', 6001, 6001, 6001)
      `;
      expect(await countOutbox(dbOwner.sql, 'harness_features_consolidated', 'F-owner1')).toBe(1);
      const drained = await drainOutboxOnce(handleOwner, dbOwner.sql);
      expect(drained, "the owner's F-owner1 was not drained to its log").toBeGreaterThanOrEqual(1);

      // ── Precondition: the JOINER ADMITS the owner's log (STEP-1 by membership identity / owner
      //    bootstrap). If it never admits, the op never reaches the apply seam, so a content miss
      //    would be an ADMIT-layer failure — surfaced explicitly below. ──
      const joinerAdmittedOwner =
        (await pollUntil(
          async () => {
            await Promise.all([handleOwner!.mergeNow(), handleJoiner!.mergeNow()]);
            return handleJoiner!.admitted.has(handleOwner!.ownLog.keyHex) ? true : undefined;
          },
          { timeoutMs: 20_000, intervalMs: 250 },
        )) ?? false;
      expect(
        joinerAdmittedOwner,
        "the JOINER did NOT admit the owner's log — STEP-1 membership/owner-bootstrap admission did " +
          'not fire (seeded hives/pot_members/registry must resolve under getOrgPg())',
      ).toBe(true);

      // ── THE PROOF: the owner's feature LANDS in the JOINER's PG (getOrgPg/orgDb). Content keeps
      //    the author's slug (the hive home) per the membership-aware design. We also probe
      //    JOINER_SLUG in case a remap path writes there. ──
      const landed = await pollUntil(
        async () => {
          await Promise.all([handleOwner!.mergeNow(), handleJoiner!.mergeNow()]);
          return (
            (await readFeatureForSlug(orgDb.adminSql, HIVE_HOME, 'F-owner1')) ??
            (await readFeatureForSlug(orgDb.adminSql, JOINER_SLUG, 'F-owner1'))
          );
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(
        landed,
        "the owner's feature never reached the JOINER's PG — OWNER→JOINER content federation gap: " +
          "the owner's hive-home op was admitted+replicated but the JOINER's real boot apply seam " +
          'dropped it (check the [A-003] member-guard / boot-resolution trace lines)',
      ).toBeTruthy();
      expect(landed).toMatchObject({
        feature_id: 'F-owner1',
        title: 'Owner→joiner feature',
        status: 'todo',
        origin: 'remote',
      });
    },
    // Generous: this is the only case in the file, so it pays the first-time org-template
    // build (~280 migrations) inside the body before the swarm/replication work.
    180_000,
  );
});
