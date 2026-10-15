/**
 * owner-roster-rebind-race.repro.integration.test.ts
 *
 * DETERMINISTIC regression for the A-003 OWNER→JOINER roster-rebind TIMING RACE
 * (su-81f2e, the apply-side twin of the receive-side slug-scope buffer).
 *
 * ## The bug (now fixed)
 * Cross-machine shared-hive federation, owner device A → joiner device B. When B
 * joins via joinHiveAsView it boots at hive-home = <none>: the pot_members /
 * pot_settings projections are bound to B's MEMBER slug, NOT the HIVE-HOME slug.
 * The hive-home slug is only learned at the 2c REKEY (boot.ts `rekey()`), whose
 * rebind block re-binds those two projections to the hive-home slug.
 *
 * If B MERGES (admits + folds) A's already-admitted owner log BEFORE the rekey
 * rebind, A's `pot_members` roster row is applied against the MEMBER-slug binding:
 * the projection DROPS it at projections/hive-members.ts writeToPg (line ~104,
 * `row.pot_home_slug !== opts.harnessSlug`), the merge cursor marks the op DONE,
 * and — because the log SET didn't change — the cursor is never reset, so the op
 * is NEVER re-applied. B's roster stays EMPTY, A's content op defers/drops at the
 * member-content guard forever (member-content-guard.ts: no hiveHome / not-in-member-set),
 * so A's content never materializes on B.
 *
 * Live this raced RED. With PAPERCUSP_A003_TRACE=1 (the stderr-delay) it accidentally
 * passed — proving a scheduling race, not a fix.
 *
 * ## The fix this test exercises (boot.ts — DO NOT EDIT, only this file)
 * A one-shot `forceReFold` flag, declared by `let mergeCursor = createMergeCursor()`,
 * set to true inside rekey()'s rebind block (right after registerAllHarnessProjections),
 * checked + cleared UNDER the merge gate at the top of mergeOnePass (right after the
 * log-set-change cursor-reset loop), and driven by an `await mergeNow()` added at the
 * END of rekey() (after retryPendingOnce). It re-folds ALL admitted logs through the
 * freshly-rebound projection so A's pot_members op re-applies and lands, firing the
 * pendingMemberContent drain so A's content lands too.
 *
 * ## How this differs from owner-content-to-joiner-faithful.repro (the sibling)
 * That faithful repro takes the two shortcuts that HIDE this race, by construction:
 *   (1) it pre-stamps the registry so `joinerPotHomeSlug(JOINER)` resolves the home
 *       SYNCHRONOUSLY at boot → B boots ALREADY hive-home-bound, so rekey is a no-op
 *       rebind and the home=<none> window never exists;
 *   (2) it pre-inserts BOTH peers into pot_members → the roster is never empty.
 * THIS test AVOIDS BOTH: it drives the joinerPotHomeSlugOverride seam to return null
 * at boot (the live fresh-joiner home=<none> window) and starts B with an EMPTY roster
 * (only the hives identity + the owner-device binding for ownerDeviceForHive bootstrap-
 * admit), then forces the BAD ordering (merge BEFORE rekey) and asserts the bug state,
 * then rekeys and asserts the fixed state.
 *
 * ## Teeth
 * Reverting EITHER half of the fix — the `await mergeNow()` at the end of rekey() OR
 * the `forceReFold` reset in mergeOnePass — leaves A's already-folded-and-dropped
 * pot_members op un-re-applied: B's roster stays EMPTY and A's content count stays 0
 * AFTER the rekey → the step-(f) assertions flip RED. (Verified by the author.)
 *
 * ## Restart-survival extension (WI-5369, added 2026-07-18)
 * Steps (g)/(h) go one step further than the fix's own teeth: after the repair lands
 * (step f), the JOINER's process is FULLY RESTARTED — close + re-boot on the SAME
 * on-disk corestore dir + SAME PG (mirroring the live gate's `rig_kill_sidecar` +
 * `rig_restart_sidecar`, which both the `reconnect_catchup` and `restart_durability`
 * scenarios use and both assert "roster intact" after). This was added while chasing
 * WI-5369's still-open live symptom (the identical drop→rebind→forceReFold trace
 * signature fires live, yet the roster reads EMPTY at the end of `reconnect_catchup`).
 * This test's restart step PASSES — a cold restart with PG preserved does NOT lose the
 * already-repaired roster row here — so a plain "restart loses PG state" mechanism is
 * REFUTED as WI-5369's live cause (at least under this deterministic reproduction). Kept
 * as a permanent regression guard for restart-survival specifically, since no prior test
 * combined the home=<none> race+repair with a subsequent cold restart.
 *
 * RUN (integration layer — real testcontainer PG; needs Docker):
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/sync/hyperbee/__tests__/owner-roster-rebind-race.repro.integration.test.ts
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import {
  buildHiveMembersProjection,
  __resetA003DropWarnThrottleForTest,
} from '../projections/hive-members';
import { _resetForTests as resetDbOrgPools } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache the pool resolver memoizes
import { _resetUrlCacheForTests } from '../../../../../../libs/papercusp/libs/db/src/connection';
import { _resetHarnessAdminUrlCacheForTests } from '../../../embedded-pg-discovery';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { mutateHarnessRegistry } from '../../../harness-registry';
import { _clearHiveMemberDeviceSetCacheForTest } from '../hive-member-identity-set';
// Brief 11 review follow-up (snapshot-ON variant): compact the owner log so the roster/content
// ops are SUMMARIZED into a `__snapshot__` op, then prove the rekey forceReFold re-fold still
// re-applies the dropped roster op through the seedCursorFromSnapshots seed path.
import { produceLogSnapshot } from '../log-snapshot';
import { findLatestSnapshotIndex } from '../read-merge';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';

const WORKSPACE_ID = 'ws-roster-rebind-race';

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
  __resetA003DropWarnThrottleForTest();
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
 *  self-generated Ed25519 keypair (no OS keychain / gh) — mirrors the sibling repros. */
function makeIdentityOverride(login: string, userId: number, keychainId: string) {
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

/** The throwaway per-peer apply for the AUTHOR (its own state-origin DB). Both the
 *  pot_members and the feature projections are CDC-captured (skipOwnOps), so the
 *  author's own appended ops are no-ops here; the set just makes the op-dispatch
 *  lookup complete for those two table tags. */
function buildAuthorApply(
  sql: postgres.Sql,
  authorSlug: string,
  ownLogKeyHex: string,
): (op: OpEnvelope) => Promise<boolean> {
  const opts = { workspaceId: WORKSPACE_ID, harnessSlug: authorSlug, sql };
  const scoped = new Map<string, TableProjection<unknown>>();
  for (const p of [
    buildHiveMembersProjection(opts),
    buildHarnessFeaturesProjection(opts),
  ] as TableProjection<unknown>[]) {
    scoped.set(p.tableTag, p);
  }
  const lookup: ProjectionLookup = (tag) => scoped.get(tag) ?? null;
  return (op: OpEnvelope) => applyOpVia(lookup, op, { ownLogKeyHex });
}

async function countOutbox(sql: postgres.Sql, table: string, key: string): Promise<number> {
  const rows = await sql<Array<{ n: string | number }>>`
    SELECT COUNT(*)::int AS n FROM harness_shared.substrate_outbox
     WHERE table_name = ${table} AND key = ${key}
  `;
  return Number(rows[0]?.n ?? 0);
}

/** Read the github_user_ids currently in B's roster (pot_members) for the hive home. */
async function rosterUserIds(sql: postgres.Sql, hiveHome: string): Promise<Set<number>> {
  const rows = await sql<Array<{ github_user_id: number }>>`
    SELECT github_user_id::int AS github_user_id
      FROM harness_shared.pot_members
     WHERE workspace_id = ${WORKSPACE_ID} AND pot_home_slug = ${hiveHome}
  `;
  return new Set(rows.map((r) => Number(r.github_user_id)));
}

/** Count A's content rows on B. harness-features projects into `work_items` (the unified
 *  base table; `harness_features_consolidated` is the back-compat view over it). Count by
 *  the author's slug (content keeps the author slug per the membership-aware design). */
async function contentRowCount(sql: postgres.Sql, slug: string, featureId: string): Promise<number> {
  const rows = await sql<Array<{ n: string | number }>>`
    SELECT COUNT(*)::int AS n
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${slug} AND feature_id = ${featureId}
  `;
  return Number(rows[0]?.n ?? 0);
}

describe('A-003 OWNER→JOINER roster-rebind RACE (deterministic) — merge BEFORE rekey drops the owner roster row; the rekey forceReFold re-applies it (real boot apply seam, NO stub)', () => {
  it(
    'B boots home=<none> with an EMPTY roster, MERGES the owner log first (roster EMPTY, content 0), then rekey() resolves the home + re-folds → roster has A AND A content lands',
    async () => {
      const HIVE_HOME = 'rrr-owner-hive'; // the OWNER's harness slug IS the hive home
      const JOINER_SLUG = 'rrr-joined-owner-hive'; // B's fresh-joiner MEMBER slug (≠ the home)
      const FEATURE_ID = 'F-owner-rrr';

      // ── A-003 trace ON so the member-guard + boot-resolution + roster-drop decisions print.
      //    The repo's vitest-fail-on-console setup fails any test that calls console.error, and
      //    the [A-003] trace uses console.error — so redirect every console.error to stdout
      //    (still visible) and collect the [A-003] lines, bypassing fail-on-console WITHOUT
      //    suppressing the trace. Mirrors the sibling repros. ──
      const a003Lines: string[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        const line = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
        if (line.includes('[A-003]')) a003Lines.push(line);
        process.stdout.write(line + '\n');
      });
      const originalWarn = console.warn;
      const dropWarnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
        if (!String(args[0] ?? '').includes('[hive-members] DROPPING federated roster rows')) {
          originalWarn(...args);
        }
      });
      cleanups.push(() => {
        process.stdout.write(`\n===== [A-003] TRACE (${a003Lines.length} lines) =====\n`);
        for (const l of a003Lines) process.stdout.write(l + '\n');
        process.stdout.write('===== END [A-003] TRACE =====\n');
        dropWarnSpy.mockRestore();
        errSpy.mockRestore();
      });

      const prevA003 = process.env.PAPERCUSP_A003_TRACE;
      process.env.PAPERCUSP_A003_TRACE = '1';
      cleanups.push(() => {
        if (prevA003 === undefined) delete process.env.PAPERCUSP_A003_TRACE;
        else process.env.PAPERCUSP_A003_TRACE = prevA003;
      });

      // ── Env-route getOrgPg() at a migrated org DB: B's REAL scopedApply writes here
      //    (getOrgPg = harness_admin, RLS-bypass) AND B's boot reads (potHomeSlugForHarness /
      //    listHiveMembers / resolveHiveMemberDeviceSet) all resolve here. Mirrors the sibling
      //    repros exactly. ──
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

      // ── Seed ONLY the hive identity row in B's org DB. ──
      //    NO pot_members rows (the EMPTY-roster fresh-join state — shortcut #2 AVOIDED).
      //    The owner's device binding for the bootstrap-admit is supplied via the injected
      //    `ownerDeviceForHiveOverride` seam below (the binding lives in the offline
      //    hive-directory cache in production, NOT on the hives row), so the hives row only
      //    needs the Hive identity columns.
      const { publicKey: hivePub } = generateKeyPairSync('ed25519');
      const hivePubkeyB64 = rawPubkeyBase64(hivePub);
      await orgDb.adminSql`
        INSERT INTO harness_shared.pots
          (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, decode(${hivePubkeyB64}, 'base64'),
                'kc-owner-home', 'Owner Home', null, 1, 1)
      `;

      // Registry: HIVE_HOME materialized as a `remote_hive` VIEW + JOINER_SLUG.hive_slug → HIVE_HOME.
      // NOTE: this makes the PRODUCTION joinerPotHomeSlug(JOINER) resolve HIVE_HOME — but we do NOT
      // use it at boot. We inject `joinerPotHomeSlugOverride` (below) returning the CONTROLLED value
      // (null at boot → the home=<none> fresh-joiner window; the hive-home slug on rekey), so the
      // registry shape only matters for the post-rekey content-guard/STEP-1 reads, NOT for the boot
      // rebind. The override is the single source of truth for B's hive-home resolution timing
      // (shortcut #1 AVOIDED). ──
      await mutateHarnessRegistry(
        (r) => ({
          ...r,
          projects: [
            ...r.projects,
            { slug: HIVE_HOME, path: '/tmp/rrr-owner-hive', harness_kind: 'hive', remote_hive: true },
            { slug: JOINER_SLUG, path: '/tmp/rrr-joiner', hive_slug: HIVE_HOME },
          ],
        }),
        WORKSPACE_ID,
      );
      _clearHiveMemberDeviceSetCacheForTest();

      // ── The OWNER author's own state-origin DB (full migrated schema + the REAL mig-189
      //    pot_members capture + the work-items CDC capture). Seed the hive identity here too
      //    (pot_members has an FK → hives). ──
      const authorDb: OrgTestDb = await createOrgTestDb();
      cleanups.push(async () => {
        await authorDb?.cleanup();
      });
      await authorDb.adminSql`
        INSERT INTO harness_shared.pots
          (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, decode(${hivePubkeyB64}, 'base64'),
                'kc-owner-home', 'Owner Home', null, 1, 1)
      `;

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
      const rootOwner = makeWorkspaceRoot('rrr-owner-');
      const rootJoiner = makeWorkspaceRoot('rrr-joiner-');

      let handleOwner: BootedHarnessHandle | undefined;
      let handleJoiner: BootedHarnessHandle | undefined;
      let applyOwner: ((op: OpEnvelope) => Promise<boolean>) | undefined;

      // ── B's CONTROLLED hive-home resolver (the joinerPotHomeSlugOverride seam). Returns null
      //    until we flip it → B boots MEMBER-slug-bound (home=<none>), the live fresh-joiner window.
      //    Flipped to HIVE_HOME right before B.rekey() so the rebind engages. This is the single
      //    seam that controls the boot-vs-rekey timing the race hinges on. ──
      let joinerHomeResolves = false;
      const joinerPotHomeSlugOverride = async (): Promise<string | null> =>
        joinerHomeResolves ? HIVE_HOME : null;

      // ── Boot the OWNER (AUTHOR): harnessSlug = the hive home; throwaway per-peer apply on its
      //    own state-origin DB (skipOwnOps ⇒ its own merge-back is a no-op). ──
      handleOwner = await bootHarnessSubstrate({
        workspaceRoot: rootOwner,
        workspaceId: WORKSPACE_ID,
        harnessSlug: HIVE_HOME,
        swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
        swarmOverride: swarmOwner,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idJoiner.userId ? 'verified' : 'fail',
        applyOverride: (op, ctx) => {
          applyOwner ??= buildAuthorApply(authorDb.adminSql, HIVE_HOME, ctx.ownLogKeyHex);
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
      //    scopedApply (getOrgPg → orgDb). joinerPotHomeSlugOverride returns null at boot → B
      //    boots pot_members/pot_settings MEMBER-slug-bound (home=<none>). ownerDeviceForHive
      //    Override returns A's device so B can bootstrap-admit A's owner log with an EMPTY roster
      //    (the WI-787/WI-797 keystone — the roster that would admit A lives inside A's un-merged
      //    log). ──
      handleJoiner = await bootHarnessSubstrate({
        workspaceRoot: rootJoiner,
        workspaceId: WORKSPACE_ID,
        harnessSlug: JOINER_SLUG,
        swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
        swarmOverride: swarmJoiner,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idOwner.userId ? 'verified' : 'fail',
        joinerPotHomeSlugOverride,
        ownerDeviceForHiveOverride: async (hivePubkey) =>
          hivePubkey === hivePubkeyB64 ? idOwner.devicePubkey : null,
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

      // ── (c) The OWNER authors its pot_members roster row AND one content op under HIVE_HOME →
      //    REAL capture triggers → outbox → drain → owner's log. ──
      // Roster row (mig 189 custom capture → outbox.harness_slug := pot_home_slug = HIVE_HOME).
      await authorDb.adminSql`
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
      // Content op (a feature/work_item under the hive home → work-items CDC capture). We set
      // workspace_id EXPLICITLY (the fill_workspace_id_from_projects BEFORE-INSERT trigger would
      // otherwise resolve it from a `projects` row we deliberately don't seed → the outbox row
      // would carry workspace_id='default' and drainOutboxOnce — which filters by handle.workspaceId
      // — would skip it).
      await authorDb.adminSql`
        INSERT INTO harness_shared.harness_features_consolidated
          (workspace_id, harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${FEATURE_ID}, 'Owner→joiner feature', 'from owner', 'todo', 0, 'local', 7001, 7001, 7001)
      `;
      expect(await countOutbox(authorDb.adminSql, 'pot_members', String(idOwner.userId))).toBe(1);
      expect(await countOutbox(authorDb.adminSql, 'harness_features_consolidated', FEATURE_ID)).toBe(1);
      const drained = await drainOutboxOnce(handleOwner, authorDb.adminSql);
      expect(drained, "the owner's roster + content ops were not drained to its log").toBeGreaterThanOrEqual(2);

      // ── Precondition: B ADMITS the owner's log (STEP-1 owner-bootstrap, EMPTY roster). If it
      //    never admits, the op never reaches the apply seam, so the bug would be an ADMIT-layer
      //    miss, not the apply-side race under test — surface it explicitly. ──
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
        "B did NOT admit the owner's log — STEP-1 owner-bootstrap admission (ownerDeviceForHive) did not fire",
      ).toBe(true);

      // ── (d) FORCE THE BAD ORDERING: drive several FULL merge passes on B BEFORE the rekey, so
      //    B admits + FOLDS A's owner log while the pot_members projection is still MEMBER-slug-
      //    bound (home=<none>). A's roster op is DROPPED at hive-members.ts (row.pot_home_slug=
      //    HIVE_HOME ≠ JOINER_SLUG), the cursor marks it DONE, and the log SET doesn't change so it
      //    is never re-folded. A's content op DROPS at the member-guard (no resolved hiveHome).
      //    Refresh the membership cache so the next read reflects PG, not a stale set. ──
      for (let i = 0; i < 6; i++) {
        await Promise.all([handleOwner.mergeNow(), handleJoiner.mergeNow()]);
      }
      _clearHiveMemberDeviceSetCacheForTest();

      expect(
        dropWarnSpy.mock.calls.some(([message]) => {
          const line = String(message ?? '');
          return (
            line.includes('[hive-members] DROPPING federated roster rows') &&
            line.includes(`'${JOINER_SLUG}'`) &&
            line.includes(`'${HIVE_HOME}'`)
          );
        }),
        'pre-rekey: the intentional cross-Hive roster drop must emit its throttled diagnostic',
      ).toBe(true);

      // ── ASSERT THE BUG STATE (pre-rekey): B's roster is EMPTY and A's content count is 0. ──
      const rosterBefore = await rosterUserIds(orgDb.adminSql, HIVE_HOME);
      expect(
        rosterBefore.size,
        'pre-rekey: B booted home=<none>, so the owner roster op MUST drop against the member-slug ' +
          `binding → an EMPTY roster. Got ${rosterBefore.size} member(s): ${[...rosterBefore].join(',')}`,
      ).toBe(0);
      const contentBefore = await contentRowCount(orgDb.adminSql, HIVE_HOME, FEATURE_ID);
      expect(
        contentBefore,
        'pre-rekey: with an empty roster + home=<none>, A’s content op MUST NOT materialize on B',
      ).toBe(0);

      // ── (e) Flip the override to resolve the hive-home slug, then REKEY (the 2c re-key). The
      //    rebind block re-binds the pot_members/pot_settings projections to HIVE_HOME, sets
      //    forceReFold, and the `await mergeNow()` at the END of rekey() consumes it → the merge
      //    cursor resets → ALL admitted logs re-fold through the now-hive-home-bound projection →
      //    A's roster op re-applies (it was dropped+done before) → the pendingMemberContent drain
      //    fires → A's content op re-applies and lands. ──
      joinerHomeResolves = true;
      await handleJoiner.rekey({ kind: 'hive', hive_pubkey: hivePubkeyB64 });

      // A couple of belt-and-suspenders passes so a slow remote update()/drain converges; the fix's
      // own `await mergeNow()` already did the decisive re-fold, so these only cover swarm-timing
      // jitter, NOT the determinism (the assertions below would already hold after rekey() alone).
      await Promise.all([handleOwner.mergeNow(), handleJoiner.mergeNow()]);

      // ── (f) ASSERT THE FIXED STATE: B's roster now contains A, AND A's content row count > 0. ──
      const rosterAfter =
        (await pollUntil(
          async () => {
            await Promise.all([handleOwner.mergeNow(), handleJoiner!.mergeNow()]);
            const ids = await rosterUserIds(orgDb.adminSql, HIVE_HOME);
            return ids.has(idOwner.userId) ? ids : undefined;
          },
          { timeoutMs: 20_000, intervalMs: 250 },
        )) ?? new Set<number>();
      expect(
        rosterAfter.has(idOwner.userId),
        'post-rekey: the rekey forceReFold must re-apply the owner roster op that was dropped at ' +
          'home=<none> → B’s roster MUST contain A. If RED here, the rekey-end mergeNow() / the ' +
          'mergeOnePass forceReFold reset was reverted (the fix has no teeth).',
      ).toBe(true);

      const contentAfter =
        (await pollUntil(
          async () => {
            await Promise.all([handleOwner.mergeNow(), handleJoiner!.mergeNow()]);
            const n = await contentRowCount(orgDb.adminSql, HIVE_HOME, FEATURE_ID);
            return n > 0 ? n : undefined;
          },
          { timeoutMs: 20_000, intervalMs: 250 },
        )) ?? 0;
      expect(
        contentAfter,
        'post-rekey: once the owner roster row re-applies, the pendingMemberContent drain must land ' +
          'A’s content op → row count > 0. If RED here, the forceReFold re-fold never fired.',
      ).toBeGreaterThan(0);

      // ── (g) WI-5369 follow-up: RESTART the JOINER — a full process restart (cold re-open),
      //    mirroring `rig_kill_sidecar` + `rig_restart_sidecar` in the LIVE reconnect_catchup /
      //    restart_durability gate scenarios (both assert "roster intact" after exactly this kind
      //    of restart, and both are RED live with the identical pre-restart drop-then-rebind trace
      //    signature this test reproduces above). PG is untouched (real Postgres — the repaired
      //    pot_members row is durable); the corestore dir is reused (same on-disk hypercore log);
      //    only in-process boot state (admitted set, merge cursor, hiveHomeProjectionSlug,
      //    forceReFold) is destroyed and rebuilt from scratch. ──
      await handleJoiner.close();
      await closeHarnessStore({ workspaceRoot: rootJoiner, harnessSlug: JOINER_SLUG });

      // A REBOOTED (already-rekeyed) member resolves the hive-home IMMEDIATELY at boot — no more
      // home=<none> window (the registry already carries hive_slug + this member already rekeyed
      // once). `joinerHomeResolves` is already `true` from step (e), so this mirrors the live
      // evidence (WI-5369 checkpoint): "both resolve hiveHomeProjectionSlug=hello-world-pot
      // immediately on boot (no gap, no re-drop)".
      const swarmJoiner2 = makeSwarm(testnet.bootstrap);
      handleJoiner = await bootHarnessSubstrate({
        workspaceRoot: rootJoiner,
        workspaceId: WORKSPACE_ID,
        harnessSlug: JOINER_SLUG,
        swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
        swarmOverride: swarmJoiner2,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idOwner.userId ? 'verified' : 'fail',
        joinerPotHomeSlugOverride,
        ownerDeviceForHiveOverride: async (hivePubkey) =>
          hivePubkey === hivePubkeyB64 ? idOwner.devicePubkey : null,
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idJoiner.override,
      });
      cleanups.push(async () => {
        await handleJoiner?.close();
        await closeHarnessStore({ workspaceRoot: rootJoiner, harnessSlug: JOINER_SLUG });
      });

      // ── (h) ASSERT ROSTER SURVIVES THE RESTART. No fresh forceReFold should be needed — the
      //    repaired pot_members row already sits durably in PG, untouched by the restart — but
      //    this is EXACTLY the live "ROSTER FAIL: member roster EMPTY after reconnect/restart"
      //    symptom (WI-5369 / restart_durability gate RED). Read it back with ZERO extra merge
      //    passes first (pure PG durability, no re-fold credit). ──
      const rosterAfterRestart = await rosterUserIds(orgDb.adminSql, HIVE_HOME);
      expect(
        rosterAfterRestart.has(idOwner.userId),
        'RESTART-SURVIVAL (WI-5369): a cold process restart must NOT lose the pot_members roster ' +
          `row the forceReFold repair already landed durably in PG. Got: [${[...rosterAfterRestart].join(',')}]. ` +
          'If RED here, something on the fresh boot re-derives/re-applies state in a way that DROPS ' +
          'the existing roster row before the home resolves — this is the live reconnect_catchup / ' +
          'restart_durability gate RED, reproduced deterministically.',
      ).toBe(true);

      // The owner writes NEW content post-restart — must still federate to the reopened joiner
      // (the link is genuinely healed, not just a stale pre-restart PG read).
      const FEATURE_ID_POST = `${FEATURE_ID}-post-restart`;
      await authorDb.adminSql`
        INSERT INTO harness_shared.harness_features_consolidated
          (workspace_id, harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${FEATURE_ID_POST}, 'Owner→joiner post-restart feature', 'from owner', 'todo', 0, 'local', 7002, 7002, 7002)
      `;
      const drainedPost = await drainOutboxOnce(handleOwner, authorDb.adminSql);
      expect(drainedPost, 'post-restart owner content did not drain').toBeGreaterThanOrEqual(1);

      const contentAfterRestart =
        (await pollUntil(
          async () => {
            await Promise.all([handleOwner.mergeNow(), handleJoiner!.mergeNow()]);
            const n = await contentRowCount(orgDb.adminSql, HIVE_HOME, FEATURE_ID_POST);
            return n > 0 ? n : undefined;
          },
          { timeoutMs: 20_000, intervalMs: 250 },
        )) ?? 0;
      expect(
        contentAfterRestart,
        'LINK-HEALED after restart: a NEW owner write must federate to the cold-reopened joiner ' +
          '(ongoing federation resumed, not just a one-time catch-up).',
      ).toBeGreaterThan(0);
    },
    // Generous: pays the first-time org-template build (~280 migrations) inside the body
    // before the swarm/replication work, TWICE (author + receiver org DBs), PLUS a full
    // joiner process restart (cold re-open) at the end.
    240_000,
  );
});

/**
 * SNAPSHOT-ON variant (Brief 11 review follow-up — the ONE explicit gate before the
 * log-compaction/snapshot flag ships). Identical scenario as the sibling above, but with
 * `FLAGS.SUBSTRATE_LOG_SNAPSHOT` forced ON and the owner's log COMPACTED (a `__snapshot__`
 * op summarizing the roster + content ops) BEFORE the joiner merges.
 *
 * ## Why this is a distinct guard
 * With snapshots ON, boot.ts reads `snapshotEnabled=true`, so EVERY merge pass — INCLUDING the
 * `forceReFold` re-fold driven by rekey() — runs `seedCursorFromSnapshots(logs, cursor)` right
 * after the forceReFold cursor reset (boot.ts ~1480-1492):
 *     if (forceReFold) { mergeCursor = createMergeCursor(); forceReFold = false; }
 *     if (snapshotEnabled) await seedCursorFromSnapshots(logs, mergeCursor);
 * So the re-fold does NOT re-read the RAW roster op (index 0) — the seed advances the cursor to
 * the snapshot index and the fold reads the `__snapshot__` op FIRST, EXPANDING its summarized
 * rows (proven equivalent to a full fold-from-0 by snapshot-fold.test.ts). The owner's roster row
 * therefore re-applies through the newly-hive-home-bound projection VIA THE SNAPSHOT EXPANSION.
 *
 * Pre-rekey the drop STILL happens through the same snapshot path (the expanded roster row is
 * applied against the MEMBER-slug binding → dropped at hive-members.ts, cursor marks the snapshot
 * op done) → B's roster is EMPTY. Post-rekey the forceReFold re-seed+re-expand lands it.
 *
 * ## Teeth
 * Reverting EITHER the `forceReFold` cursor reset OR the snapshot re-seed on the re-fold path
 * (boot.ts) leaves the summarized roster op un-re-applied AFTER rekey → B's roster stays EMPTY
 * and A's content count stays 0 under snapshots ON, flipping the step-(f) assertions RED — WHILE
 * the flag-OFF sibling above stays green. That divergence pins a regression to the
 * snapshot × re-fold interaction specifically (the exact "does the re-fold skip the dropped op
 * when snapshots are on?" concern).
 */
describe('A-003 OWNER→JOINER roster-rebind + SUBSTRATE_LOG_SNAPSHOT ON — the rekey forceReFold re-fold re-applies the DROPPED owner roster op even when it is SUMMARIZED inside a log snapshot (real boot apply + snapshot seed, NO stub)', () => {
  it(
    'snapshots ON: owner authors roster+content then COMPACTS its log → B merges home=<none> (roster EMPTY via the snapshot expansion) → rekey() re-seeds at the snapshot + re-folds → roster has A AND A content lands',
    async () => {
      const HIVE_HOME = 'rrs-owner-hive'; // the OWNER's harness slug IS the hive home
      const JOINER_SLUG = 'rrs-joined-owner-hive'; // B's fresh-joiner MEMBER slug (≠ the home)
      const FEATURE_ID = 'F-owner-rrs';

      // ── SUBSTRATE_LOG_SNAPSHOT ON for this process (env override; precedence over the flag
      //    default, no PG needed). boot.ts reads `snapshotEnabled` ONCE at boot, so this MUST be
      //    set before either boot below. Restored in cleanup. ──
      const FLAG_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_SUBSTRATE_LOG_SNAPSHOT';
      const prevFlag = process.env[FLAG_ENV];
      process.env[FLAG_ENV] = '1';
      cleanups.push(() => {
        if (prevFlag === undefined) delete process.env[FLAG_ENV];
        else process.env[FLAG_ENV] = prevFlag;
      });

      // ── A-003 trace ON so the member-guard + roster-drop decisions print (redirected off
      //    console.error to survive fail-on-console; mirrors the sibling). ──
      const a003Lines: string[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        const line = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
        if (line.includes('[A-003]')) a003Lines.push(line);
        process.stdout.write(line + '\n');
      });
      const originalWarn = console.warn;
      const dropWarnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
        if (!String(args[0] ?? '').includes('[hive-members] DROPPING federated roster rows')) {
          originalWarn(...args);
        }
      });
      cleanups.push(() => {
        process.stdout.write(`\n===== [A-003] SNAPSHOT-ON TRACE (${a003Lines.length} lines) =====\n`);
        for (const l of a003Lines) process.stdout.write(l + '\n');
        process.stdout.write('===== END [A-003] TRACE =====\n');
        dropWarnSpy.mockRestore();
        errSpy.mockRestore();
      });

      const prevA003 = process.env.PAPERCUSP_A003_TRACE;
      process.env.PAPERCUSP_A003_TRACE = '1';
      cleanups.push(() => {
        if (prevA003 === undefined) delete process.env.PAPERCUSP_A003_TRACE;
        else process.env.PAPERCUSP_A003_TRACE = prevA003;
      });

      // ── Env-route getOrgPg() at a migrated org DB (B's REAL scopedApply writes + B's boot reads
      //    resolve here). Mirrors the sibling. ──
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

      const idOwner = makeIdentityOverride('owner', 99, 'kc-owner-rrs');
      const idJoiner = makeIdentityOverride('joiner', 7, 'kc-joiner-rrs');

      // ── Seed ONLY the hive identity row (EMPTY-roster fresh-join state; owner-device binding is
      //    injected via ownerDeviceForHiveOverride below). ──
      const { publicKey: hivePub } = generateKeyPairSync('ed25519');
      const hivePubkeyB64 = rawPubkeyBase64(hivePub);
      await orgDb.adminSql`
        INSERT INTO harness_shared.pots
          (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, decode(${hivePubkeyB64}, 'base64'),
                'kc-owner-home-rrs', 'Owner Home', null, 1, 1)
      `;

      await mutateHarnessRegistry(
        (r) => ({
          ...r,
          projects: [
            ...r.projects,
            { slug: HIVE_HOME, path: '/tmp/rrs-owner-hive', harness_kind: 'hive', remote_hive: true },
            { slug: JOINER_SLUG, path: '/tmp/rrs-joiner', hive_slug: HIVE_HOME },
          ],
        }),
        WORKSPACE_ID,
      );
      _clearHiveMemberDeviceSetCacheForTest();

      const authorDb: OrgTestDb = await createOrgTestDb();
      cleanups.push(async () => {
        await authorDb?.cleanup();
      });
      await authorDb.adminSql`
        INSERT INTO harness_shared.pots
          (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, decode(${hivePubkeyB64}, 'base64'),
                'kc-owner-home-rrs', 'Owner Home', null, 1, 1)
      `;

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
      const rootOwner = makeWorkspaceRoot('rrs-owner-');
      const rootJoiner = makeWorkspaceRoot('rrs-joiner-');

      let handleOwner: BootedHarnessHandle | undefined;
      let handleJoiner: BootedHarnessHandle | undefined;
      let applyOwner: ((op: OpEnvelope) => Promise<boolean>) | undefined;

      let joinerHomeResolves = false;
      const joinerPotHomeSlugOverride = async (): Promise<string | null> =>
        joinerHomeResolves ? HIVE_HOME : null;

      handleOwner = await bootHarnessSubstrate({
        workspaceRoot: rootOwner,
        workspaceId: WORKSPACE_ID,
        harnessSlug: HIVE_HOME,
        swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
        swarmOverride: swarmOwner,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idJoiner.userId ? 'verified' : 'fail',
        applyOverride: (op, ctx) => {
          applyOwner ??= buildAuthorApply(authorDb.adminSql, HIVE_HOME, ctx.ownLogKeyHex);
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

      handleJoiner = await bootHarnessSubstrate({
        workspaceRoot: rootJoiner,
        workspaceId: WORKSPACE_ID,
        harnessSlug: JOINER_SLUG,
        swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
        swarmOverride: swarmJoiner,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idOwner.userId ? 'verified' : 'fail',
        joinerPotHomeSlugOverride,
        ownerDeviceForHiveOverride: async (hivePubkey) =>
          hivePubkey === hivePubkeyB64 ? idOwner.devicePubkey : null,
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

      // ── (c) OWNER authors its roster row + one content op → capture → outbox → drain → own log. ──
      await authorDb.adminSql`
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
      await authorDb.adminSql`
        INSERT INTO harness_shared.harness_features_consolidated
          (workspace_id, harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${FEATURE_ID}, 'Owner→joiner feature (snapshot)', 'from owner', 'todo', 0, 'local', 7001, 7001, 7001)
      `;
      expect(await countOutbox(authorDb.adminSql, 'pot_members', String(idOwner.userId))).toBe(1);
      expect(await countOutbox(authorDb.adminSql, 'harness_features_consolidated', FEATURE_ID)).toBe(1);
      const drained = await drainOutboxOnce(handleOwner, authorDb.adminSql);
      expect(drained, "the owner's roster + content ops were not drained to its log").toBeGreaterThanOrEqual(2);

      // ── COMPACT the owner's log: append a `__snapshot__` op summarizing ALL current ops (the
      //    roster + content rows land inside it). NOW the owner's log tail IS a snapshot, so the
      //    joiner's snapshot-ON merge SEEDS at it and folds the roster row via the EXPANSION —
      //    not the raw index-0 op — which is exactly the path the re-fold must survive. ──
      const snap = await produceLogSnapshot(handleOwner.ownLog, {
        now: 8000,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      });
      expect(snap.appended, 'produceLogSnapshot must append a __snapshot__ op summarizing the owner log').toBe(true);
      expect(
        snap.rowCount,
        'the snapshot must summarize at least the roster + content rows',
      ).toBeGreaterThanOrEqual(2);
      const snapIdx = await findLatestSnapshotIndex(handleOwner.ownLog, 10_000, 0);
      expect(
        snapIdx,
        'the owner log must carry a latest snapshot for the joiner to seed at (seedCursorFromSnapshots)',
      ).not.toBeNull();
      expect(snapIdx!).toBeGreaterThan(0);

      // ── Precondition: B ADMITS the owner's log (STEP-1 owner-bootstrap, EMPTY roster). ──
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
        "B did NOT admit the owner's log — STEP-1 owner-bootstrap admission (ownerDeviceForHive) did not fire",
      ).toBe(true);

      // ── (d) FORCE THE BAD ORDERING: several FULL merge passes BEFORE the rekey. With snapshots
      //    ON, each pass seeds at the owner snapshot and expands it → A's roster row is applied
      //    against the MEMBER-slug binding → DROPPED, the cursor marks the snapshot op done, the log
      //    SET doesn't change → never re-folded. A's content op drops at the member-guard. ──
      for (let i = 0; i < 6; i++) {
        await Promise.all([handleOwner.mergeNow(), handleJoiner.mergeNow()]);
      }
      _clearHiveMemberDeviceSetCacheForTest();

      expect(
        dropWarnSpy.mock.calls.some(([message]) => {
          const line = String(message ?? '');
          return (
            line.includes('[hive-members] DROPPING federated roster rows') &&
            line.includes(`'${JOINER_SLUG}'`) &&
            line.includes(`'${HIVE_HOME}'`)
          );
        }),
        'pre-rekey (snapshots ON): the intentional cross-Hive roster drop must emit its throttled diagnostic',
      ).toBe(true);

      // ── ASSERT THE BUG STATE (pre-rekey): B's roster is EMPTY and A's content count is 0. ──
      const rosterBefore = await rosterUserIds(orgDb.adminSql, HIVE_HOME);
      expect(
        rosterBefore.size,
        'pre-rekey (snapshots ON): B booted home=<none>, so the owner roster row summarized in the ' +
          `snapshot MUST drop against the member-slug binding → an EMPTY roster. Got ${rosterBefore.size}: ${[...rosterBefore].join(',')}`,
      ).toBe(0);
      const contentBefore = await contentRowCount(orgDb.adminSql, HIVE_HOME, FEATURE_ID);
      expect(
        contentBefore,
        'pre-rekey (snapshots ON): with an empty roster + home=<none>, A’s content op MUST NOT materialize on B',
      ).toBe(0);

      // ── (e) Resolve the hive-home slug + REKEY. The rebind block re-binds pot_members/pot_settings
      //    to HIVE_HOME, sets forceReFold, and the `await mergeNow()` at the END of rekey() consumes it →
      //    the cursor resets → `seedCursorFromSnapshots` RE-seeds at the owner snapshot → the fold
      //    RE-EXPANDS the snapshot through the now-hive-home-bound projection → A's roster op re-applies →
      //    the pendingMemberContent drain fires → A's content op re-applies and lands. ──
      joinerHomeResolves = true;
      await handleJoiner.rekey({ kind: 'hive', hive_pubkey: hivePubkeyB64 });

      await Promise.all([handleOwner.mergeNow(), handleJoiner.mergeNow()]);

      // ── (f) ASSERT THE FIXED STATE: B's roster now contains A, AND A's content row count > 0. ──
      const rosterAfter =
        (await pollUntil(
          async () => {
            await Promise.all([handleOwner.mergeNow(), handleJoiner.mergeNow()]);
            const ids = await rosterUserIds(orgDb.adminSql, HIVE_HOME);
            return ids.has(idOwner.userId) ? ids : undefined;
          },
          { timeoutMs: 20_000, intervalMs: 250 },
        )) ?? new Set<number>();
      expect(
        rosterAfter.has(idOwner.userId),
        'post-rekey (snapshots ON): the forceReFold re-fold must RE-SEED at the owner snapshot and ' +
          're-apply the summarized roster op through the rebound projection → B’s roster MUST contain A. ' +
          'If RED here, the forceReFold reset OR the snapshot re-seed on the re-fold path was reverted — ' +
          'the re-fold skipped the dropped op when snapshots are on.',
      ).toBe(true);

      const contentAfter =
        (await pollUntil(
          async () => {
            await Promise.all([handleOwner.mergeNow(), handleJoiner.mergeNow()]);
            const n = await contentRowCount(orgDb.adminSql, HIVE_HOME, FEATURE_ID);
            return n > 0 ? n : undefined;
          },
          { timeoutMs: 20_000, intervalMs: 250 },
        )) ?? 0;
      expect(
        contentAfter,
        'post-rekey (snapshots ON): once the owner roster row re-applies from the snapshot, the ' +
          'pendingMemberContent drain must land A’s content op → row count > 0.',
      ).toBeGreaterThan(0);
    },
    180_000,
  );
});
