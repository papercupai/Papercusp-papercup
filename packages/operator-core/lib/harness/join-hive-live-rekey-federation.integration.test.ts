/**
 * join-hive-live-rekey-federation.integration.test.ts
 *
 * WI-971 follow-up (WI-3578, filed alongside WI-3542's registry/ordering proof
 * in join-hive-from-repo-incremental-federation.integration.test.ts). THAT test
 * stubs `rekeyHarness` (a spy that itself does a real registry read) to prove
 * ORDERING; it never drives the REAL `rekeyHarness` → `bootSingleHarness` →
 * `ensureSendSideWired` chain, so the actual production regression WI-971's
 * step "2c′" fixed — the joiner's home-VIEW substrate never booting until a
 * process restart, so any hive-scoped write it captures sits in
 * `substrate_outbox` UNDRAINED forever — has never been proven end-to-end in a
 * hermetic test. This test closes that gap.
 *
 * SCOPE: `joinHiveAsView`'s 2c′ home-view rekey fires UNCONDITIONALLY,
 * regardless of `memberLinks` (join-hive.ts ~L429-453, runs before the
 * per-member loop and is never skipped when there are zero members) — so this
 * test passes `memberLinks: []` and proves ONLY the home-view leg, which is
 * also the exact leg the 2026-07-03 live differential pinned failing
 * (shared-pot-release-testing/RELEASE-READINESS.md: "B's
 * default::hello-world-hive hive_epoch_keys rows undrained while every
 * member-scope row drained"). The per-member 2c leg is structurally identical
 * (same `rekeyHarness` call) and is exercised elsewhere; re-proving it here
 * would only add a second from-repo clone/attestation rig for no new coverage.
 *
 * REAL: `joinHiveAsView` (unstubbed rekeyHarness/mutateRegistry/loadRegistry/
 * upsertHiveIdentity — the last one write-real via `upsertRemoteHiveIdentity`
 * so `harness_shared.hives` carries the pubkey `resolveHiveSwarmBinding` needs);
 * the real `rekeyHarness`/`bootSingleHarness`/`ensureSendSideWired` chain from
 * boot-all.ts; a real Hyperswarm/testnet DHT; real `bootHarnessSubstrate` scoped
 * apply (NO applyOverride on the joiner — same as
 * owner-content-to-joiner-faithful.repro.integration.test.ts, whose OWNER-side
 * rig this file reuses verbatim); real Postgres (getOrgPg, env-routed).
 * STOOD IN (test seam, not the fix under test): `setSubstrateBootDefaults({
 * bootHarness })` supplies the joiner's test swarm/identity/verify overrides so
 * `bootSingleHarness`'s fresh-boot path (invoked BY the real `rekeyHarness`) boots
 * onto the shared testnet DHT instead of resolving a real corestore/swarm from
 * scratch — the boot FACTORY is swapped, never the join/rekey/wiring logic.
 *
 * RUN (integration layer — real testcontainer PG):
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     --include '**\/join-hive-live-rekey-federation.integration.test.ts'
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
import { bootHarnessSubstrate, type BootedHarnessHandle, type BootHarnessOpts } from '../sync/hyperbee/boot';
import {
  setSubstrateBootDefaults,
  _resetSubstrateBootDefaultsForTests,
  _resetHandleMapForTests,
} from '../sync/hyperbee/boot-all';
import { type HyperswarmLike } from '../sync/hyperbee/swarm';
import type { OpEnvelope } from '../sync/hyperbee/op-envelope-types';
import { _resetBootHistoryForTests } from '../sync/hyperbee/boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../sync/hyperbee/corestore';
import { drainOutboxOnce } from '../sync/hyperbee/outbox-drain';
import { applyOpVia, type ProjectionLookup, type TableProjection } from '../sync/hyperbee/projection';
import { buildHarnessFeaturesProjection } from '../sync/hyperbee/projections/harness-features';
import { buildIssuesProjection } from '../sync/hyperbee/projections/issues';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  SUBSTRATE_OUTBOX_DDL,
  FILL_WORKSPACE_ID_DDL,
  HARNESS_ISSUES_CONSOLIDATED_FED_DDL,
} from '../../test/_work-items-schema';
import { _resetForTests as resetDbOrgPools } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache the pool resolver memoizes
import { _resetUrlCacheForTests } from '../../../../libs/papercusp/libs/db/src/connection';
import { _resetHarnessAdminUrlCacheForTests } from '../embedded-pg-discovery';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { _clearHiveMemberDeviceSetCacheForTest } from '../sync/hyperbee/hive-member-identity-set';
import { joinHiveAsView, type JoinHiveDeps } from './join-hive';
import { mutateHarnessRegistry } from '../harness-registry';

const __dirname = dirname(fileURLToPath(import.meta.url));
// .../packages/operator-core/lib/harness → repo root is four levels up.
const REPO_ROOT = resolve(__dirname, '../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

const WORKSPACE_ID = 'ws-wi971-live-rekey';
const HIVE_HOME = 'owner-hive-live';
// The joiner's home-VIEW slug (== `potId` below — no existing view + no slug
// collision, so `freeSlug` picks it verbatim). `rekeyHarness` fires the SAME
// global `bootHarness` factory for BOTH the home-view (2c′) AND the joined
// MEMBER `widgets-live` (2c) — a plain `handleJoiner = h` in that closure gets
// clobbered by whichever finishes last, silently swapping in the member's
// handle instead of the home-view's. Gate the assignment on this slug so
// `handleJoiner` always ends up the home-view handle the proofs below need.
const HOME_VIEW_POT_ID = 'owner-hive-live-discovered';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* best-effort — a thrown assertion must never leak a swarm/dir/db/DHT node */
    }
  }
  _resetSubstrateBootDefaultsForTests();
  _resetHandleMapForTests();
}, 150_000); // two real substrate handles + a testnet DHT teardown can outrun the 90s default

afterEach(async () => {
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
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
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
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
      CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
      CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd';
    END IF;
  END $pg$;
`;

/** OWNER-side schema — verbatim from owner-content-to-joiner-faithful (the author's
 *  own throwaway content-origin DB; unrelated to the joiner's real getOrgPg apply). */
async function setupOwnerPeerSchema(sql: postgres.Sql, memberSlug: string): Promise<void> {
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

function buildOwnerApply(sql: postgres.Sql, ownLogKeyHex: string): (op: OpEnvelope) => Promise<boolean> {
  const opts = { workspaceId: WORKSPACE_ID, harnessSlug: HIVE_HOME, sql };
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
    Array<{ feature_id: string; title: string | null; status: string | null; origin: string }>
  >`
    SELECT feature_id, title, status, origin
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

describe('joinHiveAsView (WI-971 follow-up) — REAL rekeyHarness/bootSingleHarness/ensureSendSideWired boots the joiner home-view onto the owner`s live topic, no restart', () => {
  it(
    'the joiner`s home-view substrate boots via the real join→rekey→boot chain, joins the SAME testnet topic as the owner, and drains an owner-authored write AFTER the join with no process restart',
    async () => {
      // ── A-003 trace, same posture as owner-content-to-joiner-faithful (console.error
      //    capture so the fail-on-console harness doesn't choke on the [A-003] trace). ──
      const a003Lines: string[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        const line = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
        if (line.includes('[A-003]') || line.includes('[join-hive]')) a003Lines.push(line);
        process.stdout.write(line + '\n');
      });
      cleanups.push(() => {
        process.stdout.write(`\n===== TRACE (${a003Lines.length} lines) =====\n`);
        for (const l of a003Lines) process.stdout.write(l + '\n');
        process.stdout.write('===== END TRACE =====\n');
        errSpy.mockRestore();
      });

      // ── Env-route getOrgPg() at a migrated org DB — the joiner's REAL scopedApply,
      //    the REAL upsertRemoteHiveIdentity (hives row), and boot-all's REAL
      //    defaultResolveSwarmBinding (resolveHiveSwarmBinding → loadHarnessRegistry +
      //    getHiveBySlug) all resolve here. ──
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

      const idOwner = makeIdentityOverride('owner', 99, 'kc-owner-live');
      const idJoiner = makeIdentityOverride('joiner', 7, 'kc-joiner-live');

      // ── The Hive identity pubkey. NOTE: unlike the "faithful" test this file's
      //    intro comment references, we deliberately do NOT seed a
      //    `harness_shared.hives` row for HIVE_HOME under this same pubkey here.
      //    In production the owner and the joiner are two SEPARATE physical
      //    devices with two SEPARATE local Postgres databases — the owner's own
      //    `hives` row (home_slug=HIVE_HOME) never coexists, in one database,
      //    with the joiner's remote-view row (home_slug=potSlug) for the SAME
      //    pubkey, because `hives.public_key` is GLOBALLY unique (184-hives-table.sql:
      //    "a pubkey identifies one Hive everywhere") — exactly one row per real
      //    Hive identity, whichever role (owner or joiner) a given device plays.
      //    This test's single shared `orgDb` stands in for BOTH devices' PG at
      //    once (so the post-join registry/hives/features reads below all land
      //    in one place), so seeding the owner's row here would recreate a
      //    same-DB collision that can never happen for real (two real devices,
      //    two real databases) and would incorrectly fail the REAL
      //    `upsertRemoteHiveIdentity` insert this test exists to exercise
      //    (`hives_public_key_key` unique-violation). The owner's
      //    `bootHarnessSubstrate` call below is given its swarm binding directly
      //    (`swarmBinding: { kind: 'hive', hive_pubkey: hivePubkeyB64 }`), so it
      //    never needs a `hives` row to resolve its own topic, and neither
      //    `verifyBindingOverride`/`loadRevokedOverride` (both stubbed for owner
      //    and joiner) nor `resolveOwnerDevicePubkey`/`getLocalHive` (both
      //    stubbed in the `joinHiveAsView` call below) ever reads
      //    `harness_shared.hive_members`, so that table needs no seed rows either.
      const { publicKey: hivePub } = generateKeyPairSync('ed25519');
      const hivePubkeyB64 = rawPubkeyBase64(hivePub);

      // ── The OWNER's own throwaway content-origin DB + real boot (author side —
      //    unrelated to the fix under test, mirrors the faithful test exactly). ──
      const dbOwner: FreshPgDb = await createFreshPgDb('ownerhivelive');
      cleanups.push(() => dbOwner.cleanup());
      await setupOwnerPeerSchema(dbOwner.sql, HIVE_HOME);

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
      const rootOwner = makeWorkspaceRoot('owner-hive-live-');
      const rootJoiner = makeWorkspaceRoot('joiner-live-');

      let handleOwner: BootedHarnessHandle | undefined;
      let applyOwner: ((op: OpEnvelope) => Promise<boolean>) | undefined;

      handleOwner = await bootHarnessSubstrate({
        workspaceRoot: rootOwner,
        workspaceId: WORKSPACE_ID,
        harnessSlug: HIVE_HOME,
        swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
        swarmOverride: swarmOwner,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idJoiner.userId ? 'verified' : 'fail',
        applyOverride: (op, ctx) => {
          applyOwner ??= buildOwnerApply(dbOwner.sql, ctx.ownLogKeyHex);
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
      expect(handleOwner.swarm).not.toBeNull();

      // ── THE SEAM UNDER TEST: install a process-global boot factory so the REAL
      //    `rekeyHarness` (called by the REAL `joinHiveAsView` below) boots the
      //    joiner's home-view onto our shared testnet DHT via `bootSingleHarness`'s
      //    fresh-boot path — nothing about join/rekey/wiring is stubbed, only the
      //    swarm/identity/verify construction (the same substitution every rig in
      //    this suite makes at the `bootHarnessSubstrate` call site). ──
      let handleJoiner: BootedHarnessHandle | undefined;
      setSubstrateBootDefaults({
        bootHarness: (o: BootHarnessOpts) => {
          // bootSingleHarness resolves `swarmBinding` itself (via
          // defaultResolveSwarmBinding) BEFORE calling this factory, and
          // bootHarnessSubstrate gates the actual swarm.join() on that value being
          // truthy REGARDLESS of `swarmOverride` (boot.ts ~L3037 — "Only fires for
          // harnesses that pass swarmBinding"). On a freshly-created hive-home view
          // the real resolver can race the just-committed registry/hives rows and
          // come back null — so force the SAME hive-pubkey binding the owner uses
          // for both the home-view AND the member (both belong on this one Hive
          // topic per join-hive.ts's 2c′/2c intent) rather than trusting resolver
          // timing. This is test-seam plumbing (which topic to join), not the
          // join/rekey/wiring logic under test.
          return bootHarnessSubstrate({
            ...o,
            swarmBinding: o.swarmBinding ?? { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
            swarmOverride: swarmJoiner,
            verifyBindingOverride: async (_pk, _login, userId) =>
              userId === idOwner.userId ? 'verified' : 'fail',
            mergePollMs: 0,
            pendingRetryMs: 0,
            loadRevokedOverride: async () => new Set(),
            announceIdentityOverride: idJoiner.override,
            workspaceRoot: rootJoiner,
          }).then((h) => {
            if (o.harnessSlug === HOME_VIEW_POT_ID) handleJoiner = h;
            cleanups.push(async () => {
              await h.close();
              await closeHarnessStore({ workspaceRoot: rootJoiner, harnessSlug: o.harnessSlug });
            });
            return h;
          });
        },
      });
      cleanups.push(() => _resetSubstrateBootDefaultsForTests());

      // ── The REAL join. `joinHiveAsView` requires ≥1 member link (an
      //    `invalid_member_links` guard rejects an empty list) — but the 2c′
      //    home-view rekey under test fires UNCONDITIONALLY before/independent of
      //    the per-member loop, so ONE member link with a STUBBED `joinLink` (the
      //    from-repo GitHub clone/attestation — unrelated to the fix, same stub
      //    shape as join-hive-from-repo-incremental-federation.integration.test.ts)
      //    satisfies the gate without adding a second real substrate rig. Every
      //    OTHER dep (loadRegistry/mutateRegistry/rekeyHarness/resolveHivePubkey/
      //    upsertHiveIdentity) is the REAL default. ──
      const joinLinkStub: JoinHiveDeps['joinLink'] = async ({ slug }) => {
        // Mirrors production `handleJoinLink`'s real registry side-effect (insert the
        // member row) — WITHOUT the from-repo GitHub clone/attestation, which is
        // unrelated to the 2c′ home-view rekey under test. Uses the SAME `slug`
        // `joinHiveAsView` computed (freeSlug(kebab(repoName))) so the later
        // hive_slug-stamping mutate (which matches on `members[].slug`) finds this row.
        await mutateHarnessRegistry(
          (reg2) => ({
            ...reg2,
            projects: reg2.projects.some((p) => p.slug === slug)
              ? reg2.projects
              : [...reg2.projects, { slug, path: `/tmp/joined/${slug}` }],
          }),
          WORKSPACE_ID,
        );
        return { ok: true, detail: 'joined' };
      };
      const joinRes = await joinHiveAsView(
        {
          potId: HOME_VIEW_POT_ID,
          hivePubkey: hivePubkeyB64,
          memberLinks: [
            `papercusp://harness?topic=${'c'.repeat(64)}&github=acme%2Fwidgets-live&repo_id=9001`,
          ],
          workspaceId: WORKSPACE_ID,
        },
        {
          joinLink: joinLinkStub,
          ensureDir: async () => {},
          seedGitSync: async () => ({ seeded: false, reason: 'ineligible' }),
          // WI-787/WI-780 owner-log BOOTSTRAP admission (boot.ts
          // resolveSameHiveMember) is the keystone that lets a FRESH joiner
          // (empty hive_members) admit the owner's hive-home log at all: it
          // trusts the ONE device the signed, gh-verified hive-announce binds to
          // this joined hive — `owner_device_pubkey`, stamped on the registry
          // view from THIS resolver (or the member link's embedded coord, absent
          // here). Returning null here (as this test originally did) leaves the
          // view with no owner-device coord, so the joiner's home-view can never
          // admit the owner's announce and the join→rekey→boot chain stalls
          // forever waiting on `admitted` — supply the REAL owner device pubkey
          // (the same identity `idOwner.override`/the owner's real announce use).
          resolveOwnerDevicePubkey: async () => idOwner.devicePubkey,
          getLocalHive: async () => null,
          // loadRegistry/mutateRegistry/rekeyHarness/resolveHivePubkey/
          // upsertHiveIdentity: all REAL defaults (omitted).
        },
      );

      expect(joinRes.ok, `join failed: ${joinRes.error}`).toBe(true);
      const potSlug = joinRes.potSlug!;
      expect(joinRes.members.map((m) => m.ok)).toEqual([true]);

      // ── PROOF 1: the real rekeyHarness→bootSingleHarness chain actually booted the
      //    joiner's home-view substrate (not just registered it) — my installed
      //    bootHarness factory must have fired, and it must be on the OWNER's exact
      //    testnet topic (the whole point of the 2b/2c′ identity+rekey sequence). ──
      expect(handleJoiner, 'the real rekeyHarness never booted the home-view — 2c′ regressed').toBeTruthy();
      expect(handleJoiner!.swarm).not.toBeNull();
      expect(handleJoiner!.swarm!.topicHex).toBe(handleOwner.swarm!.topicHex);

      // ── PROOF 2: hives row materialized for real (upsertHiveIdentity NOT stubbed) —
      //    the precondition resolveHiveSwarmBinding needed to even pick the hive topic. ──
      const hiveRow = await orgDb.adminSql<Array<{ pot_home_slug: string }>>`
        SELECT pot_home_slug FROM harness_shared.pots WHERE workspace_id = ${WORKSPACE_ID} AND pot_home_slug = ${potSlug}
      `;
      expect(hiveRow.length, 'upsertHiveIdentity never materialized the joiner`s hives row').toBe(1);

      // ── Seed the OWNER's hive_members row on the JOINER's PG, standing in for
      //    hive_members FEDERATION (out of THIS test's scope — WI-971/2c′ is about
      //    the join→rekey→boot wiring draining the outbox, not about proving
      //    hive_members itself federates, which is covered elsewhere). In real
      //    production the owner self-registers into `hive_members` at Hive create
      //    (WI-280, agent-tools/hive/_create.ts) under `hive_home_slug=HIVE_HOME`
      //    (the OWNER's own local slug), and that row federates to every joiner —
      //    but on THIS joiner's home-view boot, `hiveHomeProjectionSlug` resolves to
      //    `potSlug` (this booted harness's OWN local view slug, since
      //    `joinerPotHomeSlug` treats a `kind:'hive'` home as its own home — see
      //    hive-federation.ts), so the wire row's `hive_home_slug=HIVE_HOME` would
      //    be DROPPED by the hive_members projection's own-slug guard
      //    (`row.hive_home_slug !== opts.harnessSlug`, boot.ts/hive-members.ts) even
      //    if it were federated live. Seeding it directly under `hive_home_slug =
      //    potSlug` is what a landed federation would produce locally, and is what
      //    `decideMemberContentOp` (member-content-guard.ts) needs to resolve the
      //    owner's device into the CURRENT member set — without it every piece of
      //    hive-home content the owner authors defers forever (no member row to
      //    confirm the author against), which is exactly the failure PROOF 3 below
      //    was hitting. ──
      await orgDb.adminSql`
        INSERT INTO harness_shared.pot_members
          (workspace_id, pot_home_slug, github_user_id, github_username, device_attestations)
        VALUES (
          ${WORKSPACE_ID}, ${potSlug}, ${idOwner.userId}, 'owner',
          ${JSON.stringify([{ device_pubkey: idOwner.devicePubkey }])}::text::jsonb
        )
        ON CONFLICT (workspace_id, pot_home_slug, github_user_id) DO UPDATE
          SET device_attestations = EXCLUDED.device_attestations
      `;
      _clearHiveMemberDeviceSetCacheForTest();

      // ── PROOF 3 (the actual WI-971 regression): AFTER the join has fully completed
      //    (no restart from here on), the OWNER authors NEW hive-home content, and it
      //    lands in the JOINER's real PG via the substrate that was booted BY THE JOIN
      //    ITSELF — proving the home-view's outbox-drain/merge loop is live, not just
      //    peer_connected. ──
      await dbOwner.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${HIVE_HOME}, 'F-live1', 'Post-join owner write', 'from owner post-join', 'todo', 0, 'local', 7001, 7001, 7001)
      `;
      expect(await countOutbox(dbOwner.sql, 'harness_features_consolidated', 'F-live1')).toBe(1);
      const drained = await drainOutboxOnce(handleOwner, dbOwner.sql);
      expect(drained, "the owner's F-live1 was not drained to its log").toBeGreaterThanOrEqual(1);

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
        'the JOINER (booted via the real join→rekey chain) never admitted the owner`s log',
      ).toBe(true);

      const landed = await pollUntil(
        async () => {
          await Promise.all([handleOwner!.mergeNow(), handleJoiner!.mergeNow()]);
          return (
            (await readFeatureForSlug(orgDb.adminSql, HIVE_HOME, 'F-live1')) ??
            (await readFeatureForSlug(orgDb.adminSql, potSlug, 'F-live1'))
          );
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(
        landed,
        'the post-join owner write never reached the joiner`s PG via the substrate the ' +
          'real join→rekey chain booted — the WI-971 2c′ regression (undrained home-view ' +
          'outbox until restart) is back',
      ).toBeTruthy();
      expect(landed).toMatchObject({
        feature_id: 'F-live1',
        title: 'Post-join owner write',
        status: 'todo',
        origin: 'remote',
      });
    },
    // Generous: pays the first-time org-template build (~280 migrations) + two real
    // substrate boots + a real testnet DHT inside the body.
    180_000,
  );
});
