/**
 * federation-all-content-types-sidecar.repro.test.ts
 *
 * "ALL remaining shared-hive HIVE-STATE content types federate" — the coverage-completing
 * sibling of federation-content-matrix / federation-comms-matrix / federation-issues-
 * assignments-matrix. Those three prove the member-content + coord + work-queue families.
 * THIS file closes the last gap in the registered, CDC-captured projection set: the three
 * HIVE-HOME-grained Hive-STATE projections that NO prior 2-boot repro exercises —
 *
 *   • pot_policy        (projections/hive-policy.ts, tableTag 'hive-policy')          — GAP
 *   • pot_reports       (projections/hive-reports.ts, tableTag 'hive-reports')        — GAP
 *   • pot_pending_joins (projections/hive-pending-joins.ts, tableTag 'hive-pending-joins') — GAP
 *
 * Authoritative federating-set audit (the basis for "these three are the gap"):
 *   table-registry.ts PEER_LOG_TABLES + the capture_substrate_outbox / capture_work_items_outbox
 *   triggers + register-all.ts REGISTERED_PROJECTION_TAGS enumerate every cross-member type.
 *   ALREADY covered by a 2-boot repro/integration test:
 *     features/plans/plan-parts (federation-content-matrix), coord_event_log/threads/posts/
 *     conversations (federation-comms-matrix), engineer_issues + plan_item_assignments
 *     (federation-issues-assignments-matrix), harness_issues_consolidated (feature-content-
 *     federation), hive_members + pot_settings (_hive-substrate-rig: cross-hive-grant /
 *     teardown / late-join), hive_epoch_keys (hive-epoch-drain / hive-late-join). Those three
 *     hive-state tables (policy/reports/pending_joins) had a registered projection + a real
 *     capture trigger but NO federation test — proven here.
 *
 * Unlike the member-content projections, these three are HIVE-HOME-grained: register-all.ts
 * binds them to `hiveScoped` (the Hive home slug), they ride the Hive-pubkey topic, and their
 * apply guard is the bare hive-home demux (`row.harness_slug !== opts.harnessSlug`) — NOT the
 * WI-259 `decideMemberContentOp` member guard. So the right topology to prove them is the SAME
 * faithful 2-boot harness the matrices use, with the REAL boot scoped apply on the receiver
 * (NO applyOverride) so boot's real joiner `potHomeSlug` rebind (register-all `hiveScoped`,
 * boot.ts:803/855) is on the path — this is the FIRST test to drive these projections through
 * the real boot rebind (the _hive-substrate-rig drives hive_members/settings via applyOverride
 * on BOTH peers, never the boot rebind).
 *
 * pot_policy is the security-critical one: its projection VERIFIES the owner signature
 * (realVerifyHivePolicy → getHiveBySlug trust anchor → verifyEd25519) before applying. This
 * test authors a GENUINELY owner-signed policy (signed with the seeded Hive identity private
 * key, owner_pubkey = the Hive identity pubkey) so the REAL verify on the receiver passes and
 * the policy materializes — proving the end-to-end signed-federation path, not a stub.
 *
 * MATRIX (each cell through the REAL receiver boot apply, origin='remote'):
 *   • TEST 1 OWNER→JOINER — owner authors under the hive home; the JOINER boots a member
 *     harness whose hive home is a remote_hive VIEW → boot rebinds the hive-home-grained
 *     projections. Covers pot_policy (signed), pot_settings (re-proven via the REAL boot
 *     path), and pot_pending_joins (the owner's APPROVED decision — the decision-back
 *     direction).
 *   • TEST 2 MEMBER→OWNER — a member authors under the hive home key; the OWNER's RECEIVING
 *     harness IS the hive home. Covers pot_reports (a member's report → owner's queue) and
 *     pot_pending_joins (a prospective joiner's PENDING request) — both member→owner. Together
 *     with TEST 1's approved-decision row, pot_pending_joins is proven BOTH directions.
 *
 * SEND path for every case = the REAL mig-317 (pot_policy) / mig-318 (reports/pending_joins) /
 * mig-186 (pot_settings) capture triggers → substrate_outbox → drainOutboxOnce → the peer's
 * mergeNow → the hive-state projection apply. No hand-built outbox.
 *
 * PAPERCUSP_A003_TRACE=1 is set so the boot rebind + member-guard decisions print (grep
 * `[A-003]`); console.error is redirected so the repo's vitest-fail-on-console gate doesn't
 * trip (same trick as the matrices).
 *
 * RUN (real testcontainer PG):
 *   cd packages/operator-core && VITEST_UNIT_TIMEOUT_MS=180000 \
 *     npx vitest run lib/sync/hyperbee/__tests__/federation-all-content-types-sidecar.repro.test.ts
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
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
import { buildHivePolicyProjection } from '../projections/hive-policy';
import { buildHiveReportsProjection } from '../projections/hive-reports';
import { buildHivePendingJoinsProjection } from '../projections/hive-pending-joins';
import { buildHiveSettingsProjection } from '../projections/hive-settings';
import { canonicalizeHivePolicy, hivePolicySignedBytes, type HivePolicy } from '../../../hive-policy-schema';
import { _resetForTests as resetDbOrgPools } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache the pool resolver memoizes
import { _resetUrlCacheForTests } from '../../../../../../libs/papercusp/libs/db/src/connection';
import { _resetHarnessAdminUrlCacheForTests } from '../../../embedded-pg-discovery';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { mutateHarnessRegistry } from '../../../harness-registry';
import { _clearHiveMemberDeviceSetCacheForTest } from '../hive-member-identity-set';

const WORKSPACE_ID = 'ws-hive-state-stage6';

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

// ── Shared env / A-003-trace scaffolding installed per-test (mirrors the matrices). Routes
//    getOrgPg → the RECEIVER's org DB. Returns the [A-003] lines. ──
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
    if (prevA003 === undefined) delete process.env.PAPERCUSP_A003_TRACE;
    else process.env.PAPERCUSP_A003_TRACE = prevA003;
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

interface SeededHive {
  hivePubkeyB64: string;
  /** The Hive identity PRIVATE key — the owner holds it; used to SIGN pot_policy faithfully. */
  hivePrivateKey: KeyObject;
}

async function seedHive(
  orgDb: OrgTestDb,
  hiveHome: string,
  members: Array<{ userId: number; login: string; devicePubkey: string }>,
): Promise<SeededHive> {
  // Generate the Hive identity keypair and RETAIN the private key (the matrices discard it;
  // pot_policy needs it to produce a real owner signature the projection will verify).
  const { publicKey: hivePub, privateKey: hivePrivateKey } = generateKeyPairSync('ed25519');
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
  return { hivePubkeyB64, hivePrivateKey };
}

/** The throwaway per-peer apply for the AUTHOR (its own state-origin org DB). All three
 *  hive-state projections are CDC-captured → skipOwnOps, so the author's own appended ops are
 *  no-ops here; the set just makes the op-dispatch lookup complete for these table tags. */
function buildHiveStatePeerApply(
  sql: postgres.Sql,
  authorSlug: string,
  ownLogKeyHex: string,
): (op: OpEnvelope) => Promise<boolean> {
  const opts = { workspaceId: WORKSPACE_ID, harnessSlug: authorSlug, sql };
  const scoped = new Map<string, TableProjection<unknown>>();
  for (const p of [
    buildHivePolicyProjection(opts),
    buildHiveReportsProjection(opts),
    buildHivePendingJoinsProjection(opts),
    buildHiveSettingsProjection(opts),
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

// ── Author helpers (the REAL write paths whose capture triggers are the federation seam). ──

/** Author an owner-SIGNED pot_policy row (mig 317). owner_pubkey = the Hive identity pubkey;
 *  signature = Ed25519 over hivePolicySignedBytes with the Hive identity private key — so the
 *  receiver's realVerifyHivePolicy PASSES (proving signed federation, not a stub). */
async function authorPolicy(
  sql: postgres.Sql,
  opts: { slug: string; hivePubkeyB64: string; hivePrivateKey: KeyObject; policy: HivePolicy; version: number },
): Promise<{ canonicalPolicyJson: string }> {
  const canonicalPolicyJson = canonicalizeHivePolicy(opts.policy);
  const bytes = hivePolicySignedBytes({
    workspaceId: WORKSPACE_ID,
    potHomeSlug: opts.slug,
    policyVersion: opts.version,
    canonicalPolicyJson,
  });
  const signature = nodeSign(null, bytes, opts.hivePrivateKey).toString('base64');
  const now = Date.now();
  await sql`
    INSERT INTO harness_shared.pot_policy
      (workspace_id, harness_slug, policy_json, owner_pubkey, signature, policy_version,
       origin, created_at, updated_at)
    VALUES (${WORKSPACE_ID}, ${opts.slug}, ${canonicalPolicyJson}, ${opts.hivePubkeyB64},
            ${signature}, ${opts.version}, 'local', ${now}, ${now})
  `;
  return { canonicalPolicyJson };
}

/** Author a pot_settings row (mig 186). value is JSON-serialized TEXT (the federated subset). */
async function authorSetting(
  sql: postgres.Sql,
  opts: { slug: string; key: string; value: unknown },
): Promise<void> {
  const now = Date.now();
  await sql`
    INSERT INTO harness_shared.pot_settings
      (workspace_id, harness_slug, setting_key, value, origin, created_at, updated_at)
    VALUES (${WORKSPACE_ID}, ${opts.slug}, ${opts.key}, ${JSON.stringify(opts.value)}, 'local', ${now}, ${now})
  `;
}

/** Author a pot_reports row (mig 318 / P-MOD) — a member's moderation report. */
async function authorReport(
  sql: postgres.Sql,
  opts: {
    slug: string;
    reportId: string;
    reporterUserId: number;
    reporterUsername: string;
    targetKind: string;
    targetRef: string;
    reason: string;
    status: string;
  },
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.pot_reports
      (workspace_id, harness_slug, report_id, reporter_github_user_id, reporter_github_username,
       target_kind, target_ref, report_reason, status, origin)
    VALUES (${WORKSPACE_ID}, ${opts.slug}, ${opts.reportId}, ${opts.reporterUserId}, ${opts.reporterUsername},
            ${opts.targetKind}, ${opts.targetRef}, ${opts.reason}, ${opts.status}, 'local')
  `;
}

/** Author a pot_pending_joins row (mig 318 / P-MEMBER) — a request (status='pending') or the
 *  owner's decision (status='approved'/'denied' + decided_*). */
async function authorPendingJoin(
  sql: postgres.Sql,
  opts: {
    slug: string;
    userId: number;
    username: string;
    displayName: string | null;
    status: string;
    decidedByUserId?: number | null;
  },
): Promise<void> {
  const now = Date.now();
  const decided = opts.decidedByUserId ?? null;
  await sql`
    INSERT INTO harness_shared.pot_pending_joins
      (workspace_id, harness_slug, github_user_id, github_username, display_name, avatar_url,
       device_attestations, status, reason, requested_at, decided_at, decided_by_github_user_id, origin)
    VALUES (${WORKSPACE_ID}, ${opts.slug}, ${opts.userId}, ${opts.username}, ${opts.displayName}, null,
            ${JSON.stringify([])}::text::jsonb, ${opts.status}, null, ${now},
            ${decided === null ? null : now}, ${decided}, 'local')
  `;
}

// ── Readers (read on the RECEIVER; the apply lands the row under the hive-home slug). ──
async function readPolicy(sql: postgres.Sql, slug: string) {
  const rows = await sql<
    Array<{ harness_slug: string; policy_json: string; owner_pubkey: string; signature: string; policy_version: number; origin: string }>
  >`SELECT harness_slug, policy_json, owner_pubkey, signature, policy_version, origin
      FROM harness_shared.pot_policy WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${slug}`;
  return rows[0];
}
async function readSetting(sql: postgres.Sql, slug: string, key: string) {
  const rows = await sql<Array<{ setting_key: string; value: string | null; origin: string }>>`
    SELECT setting_key, value, origin FROM harness_shared.pot_settings
     WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${slug} AND setting_key = ${key}`;
  return rows[0];
}
async function readReport(sql: postgres.Sql, slug: string, reportId: string) {
  // reporter_github_user_id is BIGINT → postgres-js returns it as a STRING; cast to int so
  // the assertion can compare a JS number (the federation already stored the value).
  const rows = await sql<
    Array<{ report_id: string; harness_slug: string; status: string; target_kind: string; target_ref: string; reporter_github_user_id: number; origin: string }>
  >`SELECT report_id, harness_slug, status, target_kind, target_ref, reporter_github_user_id::int AS reporter_github_user_id, origin
      FROM harness_shared.pot_reports WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${slug} AND report_id = ${reportId}`;
  return rows[0];
}
async function readPendingJoin(sql: postgres.Sql, slug: string, userId: number) {
  // github_user_id is BIGINT → cast to int (postgres-js returns bigint as a string by default).
  const rows = await sql<
    Array<{ github_user_id: number; harness_slug: string; status: string; github_username: string; origin: string }>
  >`SELECT github_user_id::int AS github_user_id, harness_slug, status, github_username, origin
      FROM harness_shared.pot_pending_joins
     WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${slug} AND github_user_id = ${userId}`;
  return rows[0];
}

interface HiveStatePair {
  handleAuthor: BootedHarnessHandle;
  handleReceiver: BootedHarnessHandle;
  authorDb: OrgTestDb; // the AUTHOR's state-origin DB (writes + capture + drain here)
  orgDb: OrgTestDb; // the RECEIVER's DB (env-routed getOrgPg; assert here)
  authorSlug: string;
  receiverSlug: string;
  hivePubkeyB64: string;
  hivePrivateKey: KeyObject;
  /** drain the author's outbox + run several merge passes both ways. */
  federate: (passes?: number) => Promise<void>;
}

/**
 * Boot a faithful 2-peer hive pair (mirrors federation-issues-assignments-matrix's bootFedPair).
 * One peer AUTHORS (applyOverride → its own org DB) and the other RECEIVES via the REAL boot
 * scoped apply (no override → getOrgPg → the env-routed receiver org DB).
 *
 * The hive-state tables (pot_policy/settings/reports/pending_joins) are HIVE-HOME-grained: the
 * stores write `harness_slug = the hive home` (hive-reports-store.ts / hive-pending-joins-store.ts),
 * and the outbox drain selects rows by `harness_slug = the BOOTING harness slug` (outbox-drain.ts).
 * So a hive-state row only drains under a substrate booted AS the hive home — which is exactly what
 * runs on every machine in a real hive: the owner's local home harness, and a member's remote_hive
 * VIEW of the home (boot-all boots every live registry slug, remote_hive views included). Two
 * topologies, both faithful:
 *   • 'owner-to-joiner' — author = the owner's hive-home substrate; receiver = a JOINER member
 *     harness whose hive home is a remote_hive VIEW → boot REBINDS the hive-home-grained
 *     projections to the home slug (register-all `hiveScoped`, boot.ts). Proves the joiner rebind.
 *   • 'home-to-home' — author + receiver are BOTH the hive-home substrate on different machines
 *     (the _hive-substrate-rig topology). Models a member's remote_hive-view HIVE_HOME substrate
 *     (the one whose drain covers the hive-home-scoped rows it authored) federating to the owner's
 *     home. Proves peer→owner-home federation of member-authored hive state.
 */
async function bootHiveStatePair(cfg: {
  hiveHome: string;
  authorSlug: string;
  receiverSlug: string;
  topology: 'owner-to-joiner' | 'home-to-home';
}): Promise<HiveStatePair> {
  const { hiveHome, authorSlug, receiverSlug, topology } = cfg;

  const orgDb = await createOrgTestDb(); // RECEIVER (env-routed) + the shared hive/registry source
  cleanups.push(async () => {
    await orgDb?.cleanup();
  });
  const authorDb = await createOrgTestDb(); // AUTHOR's state-origin DB (full real schema + capture)
  cleanups.push(async () => {
    await authorDb?.cleanup();
  });
  installTraceAndEnv(orgDb);

  const idAuthor = makeIdentityOverride('author', 99, 'kc-author');
  const idReceiver = makeIdentityOverride('receiver', 7, 'kc-receiver');

  const { hivePubkeyB64, hivePrivateKey } = await seedHive(orgDb, hiveHome, [
    { userId: idAuthor.userId, login: idAuthor.login, devicePubkey: idAuthor.devicePubkey },
    { userId: idReceiver.userId, login: idReceiver.login, devicePubkey: idReceiver.devicePubkey },
  ]);

  await mutateHarnessRegistry(
    (r) => ({
      ...r,
      projects:
        topology === 'owner-to-joiner'
          ? [
              ...r.projects,
              // The hive home is a remote_hive VIEW so the JOINER rebinds the hive-home-grained
              // projections; the JOINER's member harness points at it.
              { slug: hiveHome, path: '/tmp/hs-home', harness_kind: 'hive', remote_hive: true },
              { slug: receiverSlug, path: `/tmp/${receiverSlug}`, hive_slug: hiveHome },
            ]
          : // home-to-home: both peers boot the hive home (authorSlug === receiverSlug === hiveHome).
            [...r.projects, { slug: hiveHome, path: '/tmp/hs-home', harness_kind: 'hive' }],
    }),
    WORKSPACE_ID,
  );
  _clearHiveMemberDeviceSetCacheForTest();

  const testnet = await createTestnet(3);
  cleanups.push(async () => {
    try {
      await testnet.destroy();
    } catch {
      /* ignore */
    }
  });

  const swarmAuthor = makeSwarm(testnet.bootstrap);
  const swarmReceiver = makeSwarm(testnet.bootstrap);
  const rootAuthor = makeWorkspaceRoot('hs-author-');
  const rootReceiver = makeWorkspaceRoot('hs-receiver-');

  let handleAuthor: BootedHarnessHandle | undefined;
  let handleReceiver: BootedHarnessHandle | undefined;
  let applyAuthor: ((op: OpEnvelope) => Promise<boolean>) | undefined;

  // AUTHOR = throwaway per-peer apply on its own state-origin DB.
  handleAuthor = await bootHarnessSubstrate({
    workspaceRoot: rootAuthor,
    workspaceId: WORKSPACE_ID,
    harnessSlug: authorSlug,
    swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
    swarmOverride: swarmAuthor,
    verifyBindingOverride: async (_pk, _login, userId) =>
      userId === idReceiver.userId ? 'verified' : 'fail',
    applyOverride: (op, ctx) => {
      applyAuthor ??= buildHiveStatePeerApply(authorDb.adminSql, authorSlug, ctx.ownLogKeyHex);
      return applyAuthor(op);
    },
    mergePollMs: 0,
    pendingRetryMs: 0,
    loadRevokedOverride: async () => new Set(),
    announceIdentityOverride: idAuthor.override,
  });
  cleanups.push(async () => {
    await handleAuthor?.close();
    await closeHarnessStore({ workspaceRoot: rootAuthor, harnessSlug: authorSlug });
  });

  // RECEIVER = REAL boot scoped apply (NO applyOverride → getOrgPg → receiver org DB).
  handleReceiver = await bootHarnessSubstrate({
    workspaceRoot: rootReceiver,
    workspaceId: WORKSPACE_ID,
    harnessSlug: receiverSlug,
    swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
    swarmOverride: swarmReceiver,
    verifyBindingOverride: async (_pk, _login, userId) =>
      userId === idAuthor.userId ? 'verified' : 'fail',
    mergePollMs: 0,
    pendingRetryMs: 0,
    loadRevokedOverride: async () => new Set(),
    announceIdentityOverride: idReceiver.override,
  });
  cleanups.push(async () => {
    await handleReceiver?.close();
    await closeHarnessStore({ workspaceRoot: rootReceiver, harnessSlug: receiverSlug });
  });

  expect(handleAuthor.swarm).not.toBeNull();
  expect(handleReceiver.swarm).not.toBeNull();
  expect(handleAuthor.swarm!.topicHex).toBe(handleReceiver.swarm!.topicHex);

  // Precondition: the RECEIVER admits the AUTHOR's log (STEP-1 admission).
  const admitted =
    (await pollUntil(
      async () => {
        await Promise.all([handleAuthor!.mergeNow(), handleReceiver!.mergeNow()]);
        return handleReceiver!.admitted.has(handleAuthor!.ownLog.keyHex) ? true : undefined;
      },
      { timeoutMs: 20_000, intervalMs: 250 },
    )) ?? false;
  expect(admitted, "the RECEIVER did NOT admit the AUTHOR's log (STEP-1 admission)").toBe(true);

  const federate = async (passes = 8) => {
    await drainOutboxOnce(handleAuthor!, authorDb.adminSql);
    for (let i = 0; i < passes; i++) await Promise.all([handleAuthor!.mergeNow(), handleReceiver!.mergeNow()]);
  };

  return {
    handleAuthor,
    handleReceiver,
    authorDb,
    orgDb,
    authorSlug,
    receiverSlug,
    hivePubkeyB64,
    hivePrivateKey,
    federate,
  };
}

describe('federation HIVE-STATE matrix — pot_policy + pot_reports + pot_pending_joins (+ pot_settings via real boot) federate over the Hive topic (faithful 2-boot, real swarm + PG, NO stubs)', () => {
  // ────────────────────────────────────────────────────────────────────────────
  // TEST 1: OWNER → JOINER. Owner authors the Hive state under the hive home; the JOINER boots
  // a member harness whose hive home is a remote_hive VIEW → boot rebinds the hive-home-grained
  // projections (register-all hiveScoped, boot.ts:803/855). Covers pot_policy (owner-SIGNED),
  // pot_settings (re-proven through the REAL boot path), pot_pending_joins (the APPROVED
  // decision — the decision-back direction).
  // ────────────────────────────────────────────────────────────────────────────
  it(
    'OWNER→JOINER: a signed pot_policy, a pot_settings row, and an approved pot_pending_joins decision federate to the JOINER (origin=remote)',
    async () => {
      const HIVE_HOME = 'hs-owner-hive';
      const JOINER_SLUG = 'hs-joined-owner-hive';
      const pair = await bootHiveStatePair({
        hiveHome: HIVE_HOME,
        authorSlug: HIVE_HOME, // owner authors under the hive home
        receiverSlug: JOINER_SLUG, // joiner receives (real boot, rebinds the hive-home projections)
        topology: 'owner-to-joiner',
      });
      const { authorDb, orgDb, federate, hivePubkeyB64, hivePrivateKey } = pair;

      // ── Author owner-signed policy + a setting + an approved pending-join under HIVE_HOME. ──
      const policy: HivePolicy = {
        rate: { opsPerMin: 5 },
        membership: 'approval',
        moderation: { reportable: true, bannedGithubIds: [], takedownList: [] },
      };
      const { canonicalPolicyJson } = await authorPolicy(authorDb.adminSql, {
        slug: HIVE_HOME,
        hivePubkeyB64,
        hivePrivateKey,
        policy,
        version: 1,
      });
      await authorSetting(authorDb.adminSql, { slug: HIVE_HOME, key: 'theme', value: 'midnight' });
      await authorPendingJoin(authorDb.adminSql, {
        slug: HIVE_HOME,
        userId: 5151,
        username: 'approved-user',
        displayName: 'Approved User',
        status: 'approved',
        decidedByUserId: 99, // the owner
      });

      // Capture sanity on the AUTHOR (the REAL mig-317 / mig-186 / mig-318 triggers).
      expect(await countOutbox(authorDb.adminSql, 'pot_policy', HIVE_HOME)).toBe(1);
      expect(await countOutbox(authorDb.adminSql, 'pot_settings', 'theme')).toBe(1);
      expect(await countOutbox(authorDb.adminSql, 'pot_pending_joins', '5151')).toBe(1);

      await federate();

      // ── pot_policy (owner-SIGNED) — the receiver's realVerifyHivePolicy must PASS. ──
      const policyOnB = await pollUntil(
        async () => {
          await Promise.all([pair.handleAuthor.mergeNow(), pair.handleReceiver.mergeNow()]);
          return readPolicy(orgDb.adminSql, HIVE_HOME);
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(
        policyOnB,
        'pot_policy owner→joiner: the signed policy never reached the JOINER (signature verify or hive-home rebind gap)',
      ).toBeTruthy();
      expect(policyOnB).toMatchObject({
        harness_slug: HIVE_HOME,
        owner_pubkey: hivePubkeyB64,
        policy_version: 1,
        origin: 'remote',
      });
      expect(policyOnB!.policy_json, 'pot_policy: the canonical signed bytes must round-trip').toBe(canonicalPolicyJson);

      // ── pot_settings — re-proven through the REAL boot apply path (not the rig's applyOverride). ──
      const settingOnB = await pollUntil(
        async () => {
          await Promise.all([pair.handleAuthor.mergeNow(), pair.handleReceiver.mergeNow()]);
          return readSetting(orgDb.adminSql, HIVE_HOME, 'theme');
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(settingOnB, 'pot_settings owner→joiner: the setting never reached the JOINER').toBeTruthy();
      expect(settingOnB).toMatchObject({ setting_key: 'theme', origin: 'remote' });
      expect(JSON.parse(settingOnB!.value ?? 'null')).toBe('midnight');

      // ── pot_pending_joins — the owner's APPROVED decision rides owner→joiner. ──
      const pjOnB = await pollUntil(
        async () => {
          await Promise.all([pair.handleAuthor.mergeNow(), pair.handleReceiver.mergeNow()]);
          return readPendingJoin(orgDb.adminSql, HIVE_HOME, 5151);
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(pjOnB, 'pot_pending_joins owner→joiner: the approved decision never reached the JOINER').toBeTruthy();
      expect(pjOnB).toMatchObject({
        github_user_id: 5151,
        harness_slug: HIVE_HOME,
        status: 'approved',
        github_username: 'approved-user',
        origin: 'remote',
      });
    },
    180_000,
  );

  // ────────────────────────────────────────────────────────────────────────────
  // TEST 2: MEMBER → OWNER. A member files Hive state under the hive-home key via its
  // remote_hive-VIEW HIVE_HOME substrate (the home-to-home topology: both peers run the hive-home
  // substrate, like _hive-substrate-rig — that is the substrate whose drain covers the
  // hive-home-scoped rows the stores write). The OWNER's hive-home substrate RECEIVES via the real
  // boot apply. Covers pot_reports (a member's report → the owner's moderation queue) and
  // pot_pending_joins (a prospective joiner's PENDING request). Together with TEST 1's
  // approved-decision row, pot_pending_joins is proven BOTH directions.
  // ────────────────────────────────────────────────────────────────────────────
  it(
    'MEMBER→OWNER: a pot_reports report and a pending pot_pending_joins request federate back to the OWNER (origin=remote)',
    async () => {
      const HIVE_HOME = 'hs-fed-owner-home';
      const pair = await bootHiveStatePair({
        hiveHome: HIVE_HOME,
        authorSlug: HIVE_HOME, // a member's remote_hive-view HIVE_HOME substrate files the state
        receiverSlug: HIVE_HOME, // the owner's hive-home substrate receives (real boot)
        topology: 'home-to-home',
      });
      const { authorDb, orgDb, federate } = pair;

      // ── Author a report + a PENDING join request under the HIVE_HOME key (the member device
      //    is the author identity, user 99 per bootHiveStatePair's idAuthor). ──
      await authorReport(authorDb.adminSql, {
        slug: HIVE_HOME,
        reportId: 'REP-1',
        reporterUserId: 99,
        reporterUsername: 'author',
        targetKind: 'content',
        targetRef: 'F-bad',
        reason: 'spam content',
        status: 'open',
      });
      await authorPendingJoin(authorDb.adminSql, {
        slug: HIVE_HOME,
        userId: 4242,
        username: 'newcomer',
        displayName: 'New Comer',
        status: 'pending',
        decidedByUserId: null,
      });

      expect(await countOutbox(authorDb.adminSql, 'pot_reports', 'REP-1')).toBe(1);
      expect(await countOutbox(authorDb.adminSql, 'pot_pending_joins', '4242')).toBe(1);

      await federate();

      // ── pot_reports — the member's report lands on the OWNER's queue. ──
      const reportOnA = await pollUntil(
        async () => {
          await Promise.all([pair.handleAuthor.mergeNow(), pair.handleReceiver.mergeNow()]);
          return readReport(orgDb.adminSql, HIVE_HOME, 'REP-1');
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(reportOnA, 'pot_reports member→owner: the report never reached the OWNER queue').toBeTruthy();
      expect(reportOnA).toMatchObject({
        report_id: 'REP-1',
        harness_slug: HIVE_HOME,
        status: 'open',
        target_kind: 'content',
        target_ref: 'F-bad',
        reporter_github_user_id: 99,
        origin: 'remote',
      });

      // ── pot_pending_joins — the prospective joiner's PENDING request lands on the OWNER. ──
      const pjOnA = await pollUntil(
        async () => {
          await Promise.all([pair.handleAuthor.mergeNow(), pair.handleReceiver.mergeNow()]);
          return readPendingJoin(orgDb.adminSql, HIVE_HOME, 4242);
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(pjOnA, 'pot_pending_joins member→owner: the pending request never reached the OWNER').toBeTruthy();
      expect(pjOnA).toMatchObject({
        github_user_id: 4242,
        harness_slug: HIVE_HOME,
        status: 'pending',
        github_username: 'newcomer',
        origin: 'remote',
      });
    },
    180_000,
  );
});
