/**
 * sidecar-joiner-owner-bootstrap-admit.repro.test.ts
 *
 * Plan: shared-hive-member-content-federation-2026-06-20 (D-052, D-053).
 *
 * ## THE LIVE BUG (run 18, both Hetzner frames queried directly)
 * In SUBSTRATE_SIDECAR mode the fresh JOINER B receives NOTHING from the OWNER A:
 * pot_members=0, pot_settings=0, pot_epoch_keys=0, 0 remote content. Both peers
 * swarm-`peer_connected`, but B never admits A's log → never merges → 0 roster.
 *
 * ## WHY THE EXISTING TESTS DON'T CATCH IT
 * `federation-sidecar-swarm-peering.repro.test.ts` and the faithful
 * `owner-content-to-joiner-faithful.repro.test.ts` BOTH pre-seed the joiner's
 * `pot_members` (so the member-set admission path admits the owner) AND stub the
 * announce identity. The live bug is in the UN-seeded path: a FRESH joiner with an
 * EMPTY `pot_members` roster must admit the owner's log via the WI-787/D-010
 * OWNER-LOG BOOTSTRAP-ADMIT (`loadHiveOwnerDevicePubkey` from the verified
 * `pot_directory_cache` owner binding). This repro exercises that REAL path.
 *
 * ## What this repro proves
 * Boot OWNER + a FRESH JOINER through the REAL substrate sidecar HOST
 * (createSubstrateSidecarHost + real bootHarnessSubstrate → real swarm / announce /
 * admission / merge), with:
 *   - the JOINER's `pot_members` EMPTY (no seed) — it MUST bootstrap-admit, and
 *   - a verified `pot_directory_cache` owner binding seeded for the joiner, and
 *   - the REAL `loadHiveOwnerDevicePubkey` owner-bootstrap (NO ownerDeviceForHiveOverride).
 *
 * Asserts the JOINER ADMITS the owner's log. Parameterised over the swarm-binding
 * KIND the joiner boots on: a real invite/link joiner boots on `kind:'topic'` (it
 * learns the Hive's TOPIC HASH, not its pubkey — see boot-all.ts
 * defaultResolveSwarmBinding step 2), while a backfilled joiner boots `kind:'hive'`.
 *
 * RUN (real testcontainer PG):
 *   cd packages/operator-core && VITEST_UNIT_TIMEOUT_MS=180000 \
 *     npx vitest run lib/sync/hyperbee/__tests__/sidecar-joiner-owner-bootstrap-admit.repro.test.ts
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import {
  bootHarnessSubstrate,
  type BootedHarnessHandle,
  type BootHarnessOpts,
} from '../boot';
import { deriveSwarmTopic, type SwarmBinding } from '../derive-swarm-topic';
import {
  createSubstrateSidecarHost,
  type SubstrateSidecarHost,
} from '../substrate-sidecar-host';
import { type HyperswarmLike } from '../swarm';
import type { OpEnvelope } from '../op-envelope-types';
import { listBootHistory, _resetBootHistoryForTests } from '../boot-history';
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
import { applyPot557RenameAndFixups } from './_hive-substrate-rig';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

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

/** Strip psql meta + bare BEGIN/COMMIT so a migration file applies via sql.unsafe(). */
function stripMig(s: string): string {
  return s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('\\') && !/^(begin|commit);$/i.test(t);
    })
    .join('\n');
}

/**
 * The OWNER author's content-origin schema: harness_features_consolidated + the
 * CDC capture (375) PLUS the Hive schema (184 hives + 185 pot_members + 189
 * federation-cols/custom capture) so the owner can author its ROSTER and have it
 * drain to its log (the joiner federates the roster from there).
 */
async function setupOwnerSchema(sql: postgres.Sql, hiveHome: string, hivePubkeyB64: string): Promise<void> {
  await sql.unsafe(FRAMEWORK_ROLES_DDL);
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await sql.unsafe(`
    CREATE TABLE harness_shared.projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, slug TEXT,
      workspace_id TEXT, created_ts BIGINT NOT NULL, updated_ts BIGINT NOT NULL
    );
  `);
  await sql`
    INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id, created_ts, updated_ts)
    VALUES ('p-fed', 'Fed', 'active', ${hiveHome}, ${WORKSPACE_ID}, 0, 0)
  `;
  await sql.unsafe(SUBSTRATE_OUTBOX_DDL);
  await sql.unsafe(FILL_WORKSPACE_ID_DDL);
  await sql.unsafe(HARNESS_ISSUES_CONSOLIDATED_FED_DDL);
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '375-work-items-cdc-capture.sql'), 'utf8')));
  // Hive schema so the owner can author its pot_members roster → outbox → log.
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '184-hives-table.sql'), 'utf8')));
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '185-hive-members-admission.sql'), 'utf8')));
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '189-hive-members-federation-cols.sql'), 'utf8')));
  await applyPot557RenameAndFixups(sql);
  await sql`
    INSERT INTO harness_shared.pots
      (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
    VALUES (${WORKSPACE_ID}, ${hiveHome}, decode(${hivePubkeyB64}, 'base64'),
            'kc-owner-home', 'Owner Home', null, 1, 1)
  `;
}

/** The OWNER's throwaway per-peer apply (its own content origin DB). */
function buildOwnerApply(sql: postgres.Sql, hiveHome: string, ownLogKeyHex: string): (op: OpEnvelope) => Promise<boolean> {
  const opts = { workspaceId: WORKSPACE_ID, harnessSlug: hiveHome, sql };
  const scoped = new Map<string, TableProjection<unknown>>();
  for (const p of [buildHarnessFeaturesProjection(opts), buildIssuesProjection(opts)] as TableProjection<unknown>[]) {
    scoped.set(p.tableTag, p);
  }
  const lookup: ProjectionLookup = (tag) => scoped.get(tag) ?? null;
  return (op: OpEnvelope) => applyOpVia(lookup, op, { ownLogKeyHex });
}

const WORKSPACE_ID = 'ws-sidecar-bootstrap';

const cleanups: Array<() => void | Promise<void>> = [];

function resetFixturePoolState(): void {
  // Each scenario owns a different OrgTestDb. Its process-level cursor pool and
  // identity pin must not survive that fixture, independently of db-org's pools.
  _resetLongLivedAdminPoolsForTests();
  _resetStoreIdentityForTests();
}

// EI/WI-4027: `notifyRegistryChanged` (harness-registry.ts) fires a best-effort,
// self-caught, fire-and-forget dynamic import of ./sync-sse after every registry
// mutation — not wired up in this test's env, so it lands as
// `console.warn('[harness-registry] sync invalidate failed:', ...)`. It never throws
// into the caller, but vitest-fail-on-console treats ANY console.warn as a hard
// failure, and — because it's fire-and-forget — the warn can resolve during a LATER
// test in the same file (this repro calls mutateHarnessRegistry more than once per
// scenario, mirroring the real join-hive.ts 2b-then-2c ordering). Swallow ONLY this
// known-benign, already-self-caught message; anything else still reaches the real
// (fail-on-console-wrapped) console.warn.
let originalConsoleWarn: typeof console.warn;
beforeEach(() => {
  originalConsoleWarn = console.warn;
  console.warn = ((...args: unknown[]) => {
    if (String(args[0] ?? '').includes('[harness-registry] sync invalidate failed')) return;
    originalConsoleWarn(...args);
  }) as typeof console.warn;
});

afterEach(async () => {
  console.warn = originalConsoleWarn;
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      // best-effort
    }
  }
  resetFixturePoolState();
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

interface PeerControl {
  handle: BootedHarnessHandle;
  storeId: string;
  append(op: Record<string, unknown>): Promise<void>;
  mergeNow(): Promise<number>;
}

/** Boot one peer THROUGH a dedicated substrate sidecar HOST (its own "process"). */
async function bootViaSidecarHost(args: {
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
    workspaceId: WORKSPACE_ID,
    harnessSlug: args.harnessSlug,
    workspaceRoot: args.root,
    swarmBinding: args.binding,
  })) as { storeId: string };
  if (!captured) throw new Error('bootHarnessImpl did not run (host boot failed)');

  return {
    handle: captured,
    storeId: booted.storeId,
    append: async (op) => {
      await host.methods['substrate:appendOp']({ storeId: booted.storeId, op });
    },
    mergeNow: async () => {
      const r = (await host.methods['substrate:triggerMergeNow']({
        storeId: booted.storeId,
      })) as { mergedOps: number };
      return r.mergedOps;
    },
  };
}

/**
 * Run the fresh-joiner owner-bootstrap-admit scenario for a given JOINER binding KIND.
 * Returns whether the joiner admitted the owner's log + a diagnostic dump.
 */
async function runScenario(
  joinerBindingKind: 'hive' | 'topic',
  scenarioOpts: { unresolvedHomeUntilRekey?: boolean } = {},
): Promise<{
  joinerAdmittedOwner: boolean;
  joinerEvents: ReturnType<typeof listBootHistory>;
}> {
  const HIVE_HOME = 'owner-hive';
  const JOINER_SLUG = 'joined-owner-hive';
  // recv-but-no-admit-during-rekey regression: when set, the JOINER boots with its hive-home
  // UNRESOLVED (home=<none> — the real first-join state before the 2c rekey) via the
  // joinerPotHomeSlugOverride seam; the owner's announce arrives in that window, then we rekey.
  const unresolvedHome = scenarioOpts.unresolvedHomeUntilRekey === true;
  let homeResolved = !unresolvedHome;

  // ── env-route getOrgPg at a migrated org DB = the JOINER's PG view. ──
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

  const idOwner = makeIdentityOverride('owner', 99, 'kc-owner');
  const idJoiner = makeIdentityOverride('joiner', 7, 'kc-joiner');

  // ── The hive identity (its pubkey IS the swarm-topic seed). ──
  const { publicKey: hivePub } = generateKeyPairSync('ed25519');
  const hivePubkeyB64 = rawPubkeyBase64(hivePub);

  // hives row for HIVE_HOME so getHiveBySlug(HIVE_HOME) resolves (potHomeSlugForHarness
  // + resolveHiveSwarmBinding need it). public_key is the hive pubkey.
  await orgDb.adminSql`
    INSERT INTO harness_shared.pots
      (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
    VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, decode(${hivePubkeyB64}, 'base64'),
            'kc-owner-home', 'Owner Home', null, 1, 1)
  `;

  // pot_directory_cache: the VERIFIED owner binding (hivePubkey → ownerDevicePubkey)
  // — the SOLE source loadHiveOwnerDevicePubkey reads for the bootstrap admit. NO
  // pot_members rows are seeded → the joiner roster is EMPTY (the fresh-join state).
  await orgDb.adminSql`
    INSERT INTO harness_shared.pot_directory_cache (workspace_id, payload, updated_at)
    VALUES (${WORKSPACE_ID}, ${JSON.stringify({
      hives: [{ hivePubkey: hivePubkeyB64, ownerDevicePubkey: idOwner.devicePubkey }],
    })}::text::jsonb, 1)
  `;

  // Registry: HIVE_HOME is a remote_hive VIEW; JOINER_SLUG is its member harness.
  // EI/WI-4027: under `unresolvedHome`, the registry's own hive_slug must stay UNSET
  // until the simulated rekey too. boot.ts's resolveSameHiveMember/admitsAsKnownHiveMember
  // fall back to the REAL, registry-backed potHomeSlugForHarness — NOT the
  // joinerPotHomeSlugOverride below — whenever the boot-time hiveHomeProjectionSlug
  // snapshot is null, so an eagerly-seeded registry entry resolves the home EARLY
  // regardless of the override, silently defeating the home=<none>-until-rekey
  // precondition this scenario exists to exercise (previously: the joiner admitted the
  // owner immediately, never exercising the scope_unresolved buffer / retryPendingOnce
  // replay path this test is meant to prove).
  await mutateHarnessRegistry(
    (r) => ({
      ...r,
      projects: [
        ...r.projects,
        { slug: HIVE_HOME, path: '/tmp/owner-hive', harness_kind: 'hive', remote_hive: true },
        {
          slug: JOINER_SLUG,
          path: '/tmp/joiner',
          ...(unresolvedHome ? {} : { hive_slug: HIVE_HOME }),
        },
      ],
    }),
    WORKSPACE_ID,
  );

  // Sanity: the joiner's boot reads resolve as the repro relies on — EXCEPT under
  // unresolvedHome, where the registry deliberately has no hive_slug yet (see above),
  // so these must read <none> until the simulated rekey backfills it below.
  const { potHomeSlugForHarness, joinerPotHomeSlug } = await import('../../../hive-federation');
  const { loadHiveOwnerDevicePubkey } = await import('../../../hive-membership-store');
  if (unresolvedHome) {
    expect(await potHomeSlugForHarness(WORKSPACE_ID, JOINER_SLUG)).toBeNull();
    expect(await joinerPotHomeSlug(WORKSPACE_ID, JOINER_SLUG)).toBeNull();
  } else {
    expect(await potHomeSlugForHarness(WORKSPACE_ID, JOINER_SLUG)).toBe(HIVE_HOME);
    expect(await joinerPotHomeSlug(WORKSPACE_ID, JOINER_SLUG)).toBe(HIVE_HOME);
  }
  expect(await loadHiveOwnerDevicePubkey(WORKSPACE_ID, hivePubkeyB64)).toBe(idOwner.devicePubkey);

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
  const rootOwner = makeWorkspaceRoot('boot-owner-');
  const rootJoiner = makeWorkspaceRoot('boot-joiner-');

  const hiveBinding: SwarmBinding = { kind: 'hive', hive_pubkey: hivePubkeyB64 };
  // The owner always boots on its hive binding (it is the home). The JOINER boots
  // on the binding KIND under test. A topic binding carries the SAME derived topic
  // (so the two peers still meet) but DROPS the hive_pubkey the bootstrap-admit reads.
  const joinerBinding: SwarmBinding =
    joinerBindingKind === 'hive'
      ? hiveBinding
      : { kind: 'topic', topic_hex: deriveSwarmTopic(hiveBinding).toString('hex') };

  // OWNER: roster carried via loadHiveMembersOverride (task req (a) — "owner seeded
  // with the joiner in its roster"); its own apply is irrelevant to this assertion.
  const owner = await bootViaSidecarHost({
    root: rootOwner,
    swarm: swarmOwner,
    harnessSlug: HIVE_HOME,
    binding: hiveBinding,
    bootExtra: {
      announceIdentityOverride: idOwner.override,
      verifyBindingOverride: async (_pk, _login, userId) =>
        userId === idJoiner.userId ? 'verified' : 'fail',
      applyOverride: async () => true,
      loadHiveMembersOverride: async () => [idOwner.devicePubkey, idJoiner.devicePubkey],
    },
  });

  // JOINER: EMPTY pot_members (no seed → real loadHiveMembers returns []), REAL
  // owner-bootstrap (no ownerDeviceForHiveOverride → real loadHiveOwnerDevicePubkey).
  const joiner = await bootViaSidecarHost({
    root: rootJoiner,
    swarm: swarmJoiner,
    harnessSlug: JOINER_SLUG,
    binding: joinerBinding,
    bootExtra: {
      announceIdentityOverride: idJoiner.override,
      applyOverride: async () => true,
      // home=<none> until rekey (the real first-join 2c flow) — exercises the
      // recv-but-no-admit-during-rekey path the already-bound scenarios skip.
      ...(unresolvedHome
        ? {
            joinerPotHomeSlugOverride: async (): Promise<string | null> =>
              homeResolved ? HIVE_HOME : null,
          }
        : {}),
    },
  });

  expect(owner.handle.swarm, 'owner did not join a swarm').not.toBeNull();
  expect(joiner.handle.swarm, 'joiner did not join a swarm').not.toBeNull();
  expect(owner.handle.swarm!.topicHex).toBe(joiner.handle.swarm!.topicHex);

  // Owner authors a dummy op so its log is non-empty + replicates.
  await owner.append({
    type: 'put',
    table: 'features_consolidated',
    hbKey: 'F-owner-seed',
    value: { status: 'todo', author: 'owner' },
    ts: 1001,
    schema_version: 1,
    writerPubkey: idOwner.devicePubkey,
  });

  if (unresolvedHome) {
    // Let the joiner RECEIVE the owner's announce while home=<none>: with the fix it BUFFERS
    // (scope_unresolved) instead of conclusively rejecting, and must NOT yet admit.
    for (let i = 0; i < 10; i++) await Promise.all([owner.mergeNow(), joiner.mergeNow()]);
    expect(
      joiner.handle.admitted.has(owner.handle.ownLog.keyHex),
      'precondition: a home=<none> joiner must NOT admit the owner before the rekey',
    ).toBe(false);
    // The 2c rekey: the hive-home now resolves → rebind → retryPendingOnce re-runs admit on the
    // buffered owner announce. PRE-FIX the announce was DROPPED at home=<none> (owner-bootstrap was
    // gated on myHiveHome != null), so there was nothing to replay → the joiner never admitted.
    // Mirror the REAL join-hive.ts ordering here too (EI/WI-4027): step 2b stamps the registry's
    // hive_slug BEFORE the 2c rekey RPC runs — do that now, then rekey. This is load-bearing, not
    // cosmetic: `rekey`'s re-resolve of `hiveHomeProjectionSlug` still falls through to the
    // registry-backed `potHomeSlugForHarness` fallback in places (confirmed empirically — without
    // this the post-rekey merge stays stuck at `guardHome=<none>` and the joiner never admits).
    homeResolved = true;
    await mutateHarnessRegistry(
      (r) => ({
        ...r,
        projects: r.projects.map((p) => (p.slug === JOINER_SLUG ? { ...p, hive_slug: HIVE_HOME } : p)),
      }),
      WORKSPACE_ID,
    );
    await joiner.handle.rekey(joinerBinding);
  }

  const joinerAdmittedOwner =
    (await pollUntil(
      async () => {
        await Promise.all([owner.mergeNow(), joiner.mergeNow()]);
        return joiner.handle.admitted.has(owner.handle.ownLog.keyHex) ? true : undefined;
      },
      { timeoutMs: 20_000, intervalMs: 250 },
    )) ?? false;

  const joinerEvents = listBootHistory({
    workspaceId: WORKSPACE_ID,
    harnessSlug: JOINER_SLUG,
    limit: 50,
  });

  return { joinerAdmittedOwner, joinerEvents };
}

describe('SIDECAR fixture pool lifecycle', () => {
  it('warns on an unreset database rotation and starts clean after fixture reset', async () => {
    const first = await createOrgTestDb();
    cleanups.push(() => first.cleanup());
    const second = await createOrgTestDb();
    cleanups.push(() => second.cleanup());
    const previous = {
      adminUrl: process.env.HARNESS_ADMIN_DATABASE_URL,
      skipDiscovery: process.env.PAPERCUSP_SKIP_PG_DISCOVERY,
      pgbouncer: process.env.PAPERCUSP_PGBOUNCER,
    };
    cleanups.push(() => {
      if (previous.adminUrl === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
      else process.env.HARNESS_ADMIN_DATABASE_URL = previous.adminUrl;
      if (previous.skipDiscovery === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
      else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = previous.skipDiscovery;
      if (previous.pgbouncer === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
      else process.env.PAPERCUSP_PGBOUNCER = previous.pgbouncer;
      _resetUrlCacheForTests();
      _resetHarnessAdminUrlCacheForTests();
    });
    const routeTo = (database: OrgTestDb) => {
      process.env.HARNESS_ADMIN_DATABASE_URL = database.adminDsn;
      process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
      process.env.PAPERCUSP_PGBOUNCER = '0';
      _resetUrlCacheForTests();
      _resetHarnessAdminUrlCacheForTests();
      _resetStoreIdentityForTests();
    };
    const label = 'pg-merge-cursor-store';
    resetFixturePoolState();
    routeTo(first);
    const firstPool = getLongLivedAdminPool(label);
    cleanups.push(() => firstPool.end({ timeout: 1 }));
    expect((await firstPool`SELECT current_database() AS name`)[0].name).toBe(first.dbName);
    // The identity query is fire-and-forget and independent of the content query.
    // Settle its pin before resetting global state for the next intentional DB.
    await vi.waitFor(() => expect(pinnedStoreIdentity()?.database).toBe(first.dbName));
    expect(boundAdminPoolUrl(label)).toBe(first.adminDsn);

    routeTo(second);
    // Resolver cache resets alone leave the registry bound to the old fixture.
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
});

describe('SIDECAR fresh-joiner owner-bootstrap-admit (EMPTY pot_members, real loadHiveOwnerDevicePubkey) — D-052/D-053', () => {
  it(
    'JOINER booted on a HIVE binding admits the owner log via the directory-cache owner-bootstrap',
    async () => {
      const { joinerAdmittedOwner, joinerEvents } = await runScenario('hive');
       
      console.log(
        '[repro hive-binding] joiner events:',
        joinerEvents.map((e) => `${e.kind}:${e.message ?? ''}`).join(' | '),
      );
      expect(
        joinerAdmittedOwner,
        "the FRESH JOINER (empty pot_members, HIVE binding) did NOT admit the owner's log via owner-bootstrap",
      ).toBe(true);
    },
    180_000,
  );

  it(
    'JOINER booted on a TOPIC binding (the real invite/link join) admits the owner log via the directory-cache owner-bootstrap',
    async () => {
      const { joinerAdmittedOwner, joinerEvents } = await runScenario('topic');
       
      console.log(
        '[repro topic-binding] joiner events:',
        joinerEvents.map((e) => `${e.kind}:${e.message ?? ''}`).join(' | '),
      );
      expect(
        joinerAdmittedOwner,
        "the FRESH JOINER (empty pot_members, TOPIC binding) did NOT admit the owner's log — owner-bootstrap is gated on swarmBinding.kind==='hive', so a topic-bound joiner never bootstrap-admits (D-053)",
      ).toBe(true);
    },
    180_000,
  );

  it(
    'JOINER whose hive-home resolves only at REKEY (home=<none> at boot — the real first-join 2c flow) STILL bootstrap-admits the owner [recv-but-no-admit-during-rekey regression]',
    async () => {
      const { joinerAdmittedOwner, joinerEvents } = await runScenario('topic', {
        unresolvedHomeUntilRekey: true,
      });
       
      console.log(
        '[repro home<none>→rekey] joiner events:',
        joinerEvents.map((e) => `${e.kind}:${e.message ?? ''}`).join(' | '),
      );
      expect(
        joinerAdmittedOwner,
        'a joiner that RECEIVED the owner announce at home=<none> then rekeyed did NOT admit the owner — the owner-bootstrap was gated behind the myHiveHome resolution, so the announce was dropped (not buffered) and the rekey replay had nothing to re-drive (the live A→B recv-but-no-admit-during-rekey blocker)',
      ).toBe(true);
    },
    180_000,
  );
});

describe('SIDECAR fresh-joiner FULL CHAIN — TOPIC-bound joiner: admit → roster federates → owner content applies (D-052/D-053)', () => {
  it(
    'a TOPIC-bound fresh joiner bootstrap-admits the owner, federates the roster from the owner log, and applies an owner-authored feature',
    async () => {
      const HIVE_HOME = 'owner-hive';
      const JOINER_SLUG = 'joined-owner-hive';

      // env-route getOrgPg at the JOINER's PG view.
      const orgDb: OrgTestDb = await createOrgTestDb();
      const prev = {
        adminUrl: process.env.HARNESS_ADMIN_DATABASE_URL,
        appUrl: process.env.HARNESS_DATABASE_URL,
        ws: process.env.PAPERCUSP_WORKSPACE_ID,
        skip: process.env.PAPERCUSP_SKIP_PG_DISCOVERY,
        pgb: process.env.PAPERCUSP_PGBOUNCER,
      };
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
        if (prev.adminUrl === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL; else process.env.HARNESS_ADMIN_DATABASE_URL = prev.adminUrl;
        if (prev.appUrl === undefined) delete process.env.HARNESS_DATABASE_URL; else process.env.HARNESS_DATABASE_URL = prev.appUrl;
        if (prev.ws === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID; else process.env.PAPERCUSP_WORKSPACE_ID = prev.ws;
        if (prev.skip === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY; else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = prev.skip;
        if (prev.pgb === undefined) delete process.env.PAPERCUSP_PGBOUNCER; else process.env.PAPERCUSP_PGBOUNCER = prev.pgb;
        _resetUrlCacheForTests();
        _resetHarnessAdminUrlCacheForTests();
        _clearHiveMemberDeviceSetCacheForTest();
        await resetDbOrgPools();
        await orgDb?.cleanup();
      });

      const idOwner = makeIdentityOverride('owner', 99, 'kc-owner');
      const idJoiner = makeIdentityOverride('joiner', 7, 'kc-joiner');
      const { publicKey: hivePub } = generateKeyPairSync('ed25519');
      const hivePubkeyB64 = rawPubkeyBase64(hivePub);

      // JOINER's PG: a hives row for HIVE_HOME (home resolution) + the VERIFIED
      // directory-cache owner binding. NO pot_members rows → EMPTY roster (fresh join).
      await orgDb.adminSql`
        INSERT INTO harness_shared.pots
          (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, decode(${hivePubkeyB64}, 'base64'),
                'kc-owner-home', 'Owner Home', null, 1, 1)
      `;
      await orgDb.adminSql`
        INSERT INTO harness_shared.pot_directory_cache (workspace_id, payload, updated_at)
        VALUES (${WORKSPACE_ID}, ${JSON.stringify({
          hives: [{ hivePubkey: hivePubkeyB64, ownerDevicePubkey: idOwner.devicePubkey }],
        })}::text::jsonb, 1)
      `;
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

      // OWNER's content-origin DB (its slug IS the hive home) + the hive schema.
      const dbOwner: FreshPgDb = await createFreshPgDb('bootstrapOwner');
      cleanups.push(() => dbOwner.cleanup());
      await setupOwnerSchema(dbOwner.sql, HIVE_HOME, hivePubkeyB64);

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
      const rootOwner = makeWorkspaceRoot('chain-owner-');
      const rootJoiner = makeWorkspaceRoot('chain-joiner-');

      const hiveBinding: SwarmBinding = { kind: 'hive', hive_pubkey: hivePubkeyB64 };
      const joinerBinding: SwarmBinding = {
        kind: 'topic',
        topic_hex: deriveSwarmTopic(hiveBinding).toString('hex'),
      };

      let ownerApply: ((op: OpEnvelope) => Promise<boolean>) | undefined;
      let owner: PeerControl;
      owner = await bootViaSidecarHost({
        root: rootOwner,
        swarm: swarmOwner,
        harnessSlug: HIVE_HOME,
        binding: hiveBinding,
        bootExtra: {
          announceIdentityOverride: idOwner.override,
          verifyBindingOverride: async (_pk, _login, userId) =>
            userId === idJoiner.userId ? 'verified' : 'fail',
          applyOverride: (op, ctx) => {
            ownerApply ??= buildOwnerApply(dbOwner.sql, HIVE_HOME, ctx.ownLogKeyHex);
            return ownerApply(op);
          },
        },
      });

      // JOINER: TOPIC binding, EMPTY pot_members, REAL apply (no applyOverride → getOrgPg/orgDb).
      const joiner = await bootViaSidecarHost({
        root: rootJoiner,
        swarm: swarmJoiner,
        harnessSlug: JOINER_SLUG,
        binding: joinerBinding,
        bootExtra: { announceIdentityOverride: idJoiner.override },
      });

      expect(owner.handle.swarm).not.toBeNull();
      expect(joiner.handle.swarm).not.toBeNull();
      expect(owner.handle.swarm!.topicHex).toBe(joiner.handle.swarm!.topicHex);

      // OWNER authors its ROSTER (owner + joiner) + a content feature → outbox → drain → owner log.
      const memberAtt = (login: string, pk: string) =>
        JSON.stringify([
          { device_pubkey: pk, gist_id: `gist-${login}`, gist_url: `https://gist.github.com/${login}`, device_label: `${login}-dev`, created_at: 1, signature_by_device: 'sig' },
        ]);
      await dbOwner.sql`
        INSERT INTO harness_shared.pot_members
          (workspace_id, pot_home_slug, github_user_id, github_username, device_attestations, revoked_pubkeys, binding_status)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${idOwner.userId}, 'owner', ${memberAtt('owner', idOwner.devicePubkey)}::text::jsonb, '{}'::text[], 'verified')
      `;
      await dbOwner.sql`
        INSERT INTO harness_shared.pot_members
          (workspace_id, pot_home_slug, github_user_id, github_username, device_attestations, revoked_pubkeys, binding_status)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${idJoiner.userId}, 'joiner', ${memberAtt('joiner', idJoiner.devicePubkey)}::text::jsonb, '{}'::text[], 'verified')
      `;
      await dbOwner.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${HIVE_HOME}, 'F-owner1', 'Owner→joiner feature', 'from owner', 'todo', 0, 'local', 6001, 6001, 6001)
      `;
      const drained = await drainOutboxOnce(owner.handle, dbOwner.sql);
      expect(drained, 'owner outbox (roster + feature) did not drain to its log').toBeGreaterThanOrEqual(3);

      // THE FULL-CHAIN PROOF: merge until the joiner ADMITS the owner, FEDERATES the
      // roster (orgDb pot_members), and APPLIES the owner feature (orgDb features).
      const result = await pollUntil(
        async () => {
          await Promise.all([owner.mergeNow(), joiner.mergeNow()]);
          const admitted = joiner.handle.admitted.has(owner.handle.ownLog.keyHex);
          const members = await orgDb.adminSql<Array<{ n: number }>>`
            SELECT COUNT(*)::int AS n FROM harness_shared.pot_members
             WHERE workspace_id = ${WORKSPACE_ID} AND pot_home_slug = ${HIVE_HOME}
          `;
          const feat = await orgDb.adminSql<Array<{ feature_id: string; origin: string; title: string }>>`
            SELECT feature_id, origin, title FROM harness_shared.harness_features_consolidated
             WHERE harness_slug = ${HIVE_HOME} AND feature_id = 'F-owner1'
          `;
          const memberCount = Number(members[0]?.n ?? 0);
          return admitted && memberCount >= 2 && feat[0]
            ? { admitted, memberCount, feature: feat[0] }
            : undefined;
        },
        { timeoutMs: 30_000, intervalMs: 300 },
      );

      expect(
        result?.admitted,
        "the TOPIC-bound joiner never admitted the owner's log (D-053 bootstrap-admit)",
      ).toBe(true);
      expect(
        result?.memberCount,
        'the joiner never federated the owner roster (pot_members) from the owner log',
      ).toBeGreaterThanOrEqual(2);
      expect(
        result?.feature,
        "the owner-authored feature never applied on the joiner (admit→roster→content chain broke)",
      ).toMatchObject({ feature_id: 'F-owner1', origin: 'remote', title: 'Owner→joiner feature' });
    },
    180_000,
  );
});
