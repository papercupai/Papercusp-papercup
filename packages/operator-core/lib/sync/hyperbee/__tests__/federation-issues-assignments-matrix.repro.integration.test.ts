/**
 * federation-issues-assignments-matrix.repro.test.ts
 *
 * The D-046 follow-up regression test (plan shared-hive-member-content-federation-2026-06-20):
 * "engineer_issues + plan_item_assignments federate CROSS-MEMBER, BOTH directions" over the
 * SAME faithful 2-boot hermetic federation harness the comms/content matrices use (real
 * testnet-DHT swarm via createTestnet + real testcontainer org Postgres; the REAL boot apply
 * seam `bootHarnessSubstrate` — NO applyOverride / NO resolveAuthorDevice stub on the RECEIVER,
 * so boot's real joiner rebind / owner-home fallback + the
 * `admittedIdentities → resolveAuthorDevice → resolveHiveMemberDeviceSet` membership chain are
 * on the path end-to-end).
 *
 * WHY THIS FILE EXISTS (the lesson behind D-046): the two work-queue surfaces —
 *   • engineer_issues   (work_items[kind ∈ bug|change|task]; federates per mig 197/375), and
 *   • plan_item_assignments (federates per mig 145)
 * — gate their projection apply with `decideMemberContentOp` (the WI-259 membership-aware guard),
 * EXACTLY like the 6 content projections. Before D-046 both used the BARE
 * `if (row.harness_slug !== opts.harnessSlug) return;` early-return, which DROPS every op a
 * DIFFERENT member authored (peer members carry distinct slugs in a real hive) — so a member
 * never saw a peer's issues/assignments. D-046 swapped the bare guard for `decideMemberContentOp`
 * in projections/engineer-issues.ts + projections/plan-item-assignments.ts. That fix shipped
 * tsc-clean but WITHOUT its own cross-member test — and same-slug tests HID the bug (author slug
 * == receiver slug never trips the guard). This file is that missing test: it crosses SLUGS in
 * both directions (author slug ≠ receiver slug), so reverting either projection's guard back to
 * the bare slug check turns it RED.
 *
 * MATRIX (each cell run through the REAL receiver boot apply):
 *   • engineer_issue authored on A applies on B as origin='remote', under A's authored slug — and
 *     B→A (a member-authored issue lands on the owner-home).
 *   • plan_item_assignment authored on A applies on B as origin='remote', under A's authored slug —
 *     and B→A.
 *
 * Direction A (TEST 1) = OWNER→JOINER (owner authors under the hive home; the JOINER boots a
 * member harness whose hive home is a remote_hive VIEW → boot's real joinerPotHomeSlug rebind +
 * membership chain are on the path). Direction B (TEST 2) = JOINER→OWNER (a member authors under
 * its member slug; the OWNER's RECEIVING harness IS the hive home → the owner-home content-guard
 * fallback, WI-559/FED-1, engages). Each direction's rows cross SLUGS (author slug ≠ receiver
 * slug, the real shared-hive member↔member topology the live deb-hetzner run uses), so the apply
 * lands them under the AUTHOR's slug via the WI-259/D-046 membership-aware guard.
 *
 * The engineer_issue is AUTHORED through the canonical engineer_issues compat view (mig 374/382
 * INSTEAD OF DML → work_items base table), so the REAL mig-375 kind-branching capture
 * (capture_work_items_outbox → table_name='engineer_issues', scope→slug derivation) is the
 * federation seam — no hand-built outbox. The plan_item_assignment is AUTHORED directly into its
 * base table so the REAL mig-145 generic capture (capture_substrate_outbox('fed_key')) fires.
 *
 * PAPERCUSP_A003_TRACE=1 is set so the member-guard decisions print (grep `[A-003]`); console.error
 * is redirected so the repo's vitest-fail-on-console gate doesn't trip (same trick as the matrices).
 *
 * RUN (real testcontainer PG):
 *   cd packages/operator-core && VITEST_UNIT_TIMEOUT_MS=180000 \
 *     npx vitest run lib/sync/hyperbee/__tests__/federation-issues-assignments-matrix.repro.test.ts
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
import { buildEngineerIssuesProjection } from '../projections/engineer-issues';
import { buildPlanItemAssignmentsProjection } from '../projections/plan-item-assignments';
import { _resetForTests as resetDbOrgPools } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache the pool resolver memoizes
import { _resetUrlCacheForTests } from '../../../../../../libs/papercusp/libs/db/src/connection';
import { _resetHarnessAdminUrlCacheForTests } from '../../../embedded-pg-discovery';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { mutateHarnessRegistry } from '../../../harness-registry';
import { _clearHiveMemberDeviceSetCacheForTest } from '../hive-member-identity-set';

const WORKSPACE_ID = 'ws-ei-asg-stage6';

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

async function seedHive(
  orgDb: OrgTestDb,
  hiveHome: string,
  members: Array<{ userId: number; login: string; devicePubkey: string }>,
): Promise<string> {
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
  const [row] = await orgDb.adminSql<Array<{ pk: string }>>`
    SELECT encode(public_key, 'base64') AS pk FROM harness_shared.pots
     WHERE workspace_id = ${WORKSPACE_ID} AND pot_home_slug = ${hiveHome}
  `;
  return row!.pk;
}

/** The throwaway per-peer apply for the AUTHOR (its own content-origin org DB). Both
 *  projections are CDC-captured → skipOwnOps, so the author's own appended ops are no-ops
 *  here; the set just makes the op-dispatch lookup complete for these two table tags. */
function buildIssuesAssignmentsPeerApply(
  sql: postgres.Sql,
  authorSlug: string,
  ownLogKeyHex: string,
): (op: OpEnvelope) => Promise<boolean> {
  const opts = { workspaceId: WORKSPACE_ID, harnessSlug: authorSlug, sql };
  const scoped = new Map<string, TableProjection<unknown>>();
  for (const p of [
    buildEngineerIssuesProjection(opts),
    buildPlanItemAssignmentsProjection(opts),
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

/**
 * WI-10002487 — engineer_issues outbox rows are keyed `<storage harness_slug>/<issue_id>`
 * (mig 829 harness-qualified op identity; mig 965's capture_work_items_outbox builds
 * `v_rec.harness_slug || '/' || v_rec.feature_id`). Counting the BARE issue id matches
 * nothing, which read as "the capture trigger never fired" when it had. The key is
 * rebuilt from the STORED row, exactly as the trigger builds it, so this check cannot
 * drift from the slug the compat view resolves `scope` to.
 */
async function countIssueOutbox(sql: postgres.Sql, issueId: string): Promise<number> {
  const rows = await sql<Array<{ n: string | number }>>`
    SELECT COUNT(*)::int AS n
      FROM harness_shared.substrate_outbox o
      JOIN harness_shared.work_items w
        ON o.key = w.harness_slug || '/' || w.feature_id
     WHERE o.table_name = 'engineer_issues'
       AND w.workspace_id = ${WORKSPACE_ID}
       AND w.feature_id = ${issueId}
  `;
  return Number(rows[0]?.n ?? 0);
}

// ── Author helpers (the REAL write paths whose capture triggers are the federation seam). ──

/** Author an engineer_issue THROUGH the canonical compat view (mig 374/382 INSTEAD OF DML →
 *  work_items base) under `harness:<slug>` so mig-375's capture stamps the federation slug. */
async function authorIssue(
  sql: postgres.Sql,
  opts: { slug: string; issueId: string; kind: string; title: string; body: string; state: string },
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, scope, kind, title, body, severity, source, state, origin)
    VALUES (${WORKSPACE_ID}, ${opts.issueId}, ${`harness:${opts.slug}`}, ${opts.kind},
            ${opts.title}, ${opts.body}, 'minor', 'engineer', ${opts.state}, 'local')
  `;
}

/** Author a plan_item_assignment directly into its base table (the mig-145 generic capture fires). */
async function authorAssignment(
  sql: postgres.Sql,
  opts: { slug: string; planSlug: string; itemId: string; assignee: string; assignedBy: string; strategy: string; note: string },
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.plan_item_assignments
      (workspace_id, harness_slug, plan_slug, item_id, assignee_name, assigned_by_user,
       assigned_ts, released_ts, strategy, note, origin)
    VALUES (${WORKSPACE_ID}, ${opts.slug}, ${opts.planSlug}, ${opts.itemId}, ${opts.assignee},
            ${opts.assignedBy}, ${new Date(1_700_000_000_000).toISOString()}, null,
            ${opts.strategy}, ${opts.note}, 'local')
  `;
}

// ── Readers (read on the RECEIVER; the apply lands the row under the AUTHORED slug). ──
async function readIssue(sql: postgres.Sql, issueId: string) {
  const rows = await sql<
    Array<{ issue_id: string; scope: string; state: string; title: string; kind: string; origin: string }>
  >`SELECT issue_id, scope, state, title, kind, origin
      FROM harness_shared.engineer_issues WHERE workspace_id = ${WORKSPACE_ID} AND issue_id = ${issueId}`;
  return rows[0];
}
async function readAssignment(sql: postgres.Sql, planSlug: string, itemId: string) {
  const rows = await sql<
    Array<{ harness_slug: string; plan_slug: string; item_id: string; assignee_name: string | null; strategy: string | null; note: string | null; origin: string }>
  >`SELECT harness_slug, plan_slug, item_id, assignee_name, strategy, note, origin
      FROM harness_shared.plan_item_assignments
     WHERE workspace_id = ${WORKSPACE_ID} AND plan_slug = ${planSlug} AND item_id = ${itemId}`;
  return rows[0];
}

interface FedPair {
  handleAuthor: BootedHarnessHandle;
  handleReceiver: BootedHarnessHandle;
  authorDb: OrgTestDb; // the AUTHOR's content-origin DB (writes + capture + drain here)
  orgDb: OrgTestDb; // the RECEIVER's DB (env-routed getOrgPg; assert here)
  authorSlug: string;
  receiverSlug: string;
  /** drain the author's outbox + run several merge passes both ways. */
  federate: (passes?: number) => Promise<void>;
}

/**
 * Boot a faithful 2-peer hive pair (mirrors federation-comms-matrix's bootCommsPair). One peer
 * AUTHORS (applyOverride → its own org DB, so its content origin is separate from the receiver's)
 * and the other RECEIVES via the REAL boot scoped apply (no override → getOrgPg → the env-routed
 * receiver org DB). When the receiver is a JOINER, the hive home is a remote_hive VIEW (boot
 * rebinds) and the owner authors under the home; when the owner is the receiver, it boots the home
 * harness and a member authors under a member slug. Author slug ≠ receiver slug in BOTH cases.
 */
async function bootFedPair(cfg: {
  hiveHome: string;
  authorSlug: string;
  receiverSlug: string;
  receiverIsJoiner: boolean;
}): Promise<FedPair> {
  const { hiveHome, authorSlug, receiverSlug, receiverIsJoiner } = cfg;
  const memberSlug = authorSlug === hiveHome ? receiverSlug : authorSlug;

  const orgDb = await createOrgTestDb(); // RECEIVER (env-routed) + the shared hive/registry source
  cleanups.push(async () => {
    await orgDb?.cleanup();
  });
  const authorDb = await createOrgTestDb(); // AUTHOR's content-origin DB (full real schema + capture)
  cleanups.push(async () => {
    await authorDb?.cleanup();
  });
  installTraceAndEnv(orgDb);

  const idAuthor = makeIdentityOverride('author', 99, 'kc-author');
  const idReceiver = makeIdentityOverride('receiver', 7, 'kc-receiver');

  const hivePubkeyB64 = await seedHive(orgDb, hiveHome, [
    { userId: idAuthor.userId, login: idAuthor.login, devicePubkey: idAuthor.devicePubkey },
    { userId: idReceiver.userId, login: idReceiver.login, devicePubkey: idReceiver.devicePubkey },
  ]);

  await mutateHarnessRegistry(
    (r) => ({
      ...r,
      projects: [
        ...r.projects,
        receiverIsJoiner
          ? { slug: hiveHome, path: '/tmp/eia-home', harness_kind: 'hive', remote_hive: true }
          : { slug: hiveHome, path: '/tmp/eia-home', harness_kind: 'hive' },
        { slug: memberSlug, path: `/tmp/${memberSlug}`, hive_slug: hiveHome },
      ],
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
  const rootAuthor = makeWorkspaceRoot('eia-author-');
  const rootReceiver = makeWorkspaceRoot('eia-receiver-');

  let handleAuthor: BootedHarnessHandle | undefined;
  let handleReceiver: BootedHarnessHandle | undefined;
  let applyAuthor: ((op: OpEnvelope) => Promise<boolean>) | undefined;

  // AUTHOR = throwaway per-peer apply on its own content-origin DB.
  handleAuthor = await bootHarnessSubstrate({
    workspaceRoot: rootAuthor,
    workspaceId: WORKSPACE_ID,
    harnessSlug: authorSlug,
    swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
    swarmOverride: swarmAuthor,
    verifyBindingOverride: async (_pk, _login, userId) =>
      userId === idReceiver.userId ? 'verified' : 'fail',
    applyOverride: (op, ctx) => {
      applyAuthor ??= buildIssuesAssignmentsPeerApply(authorDb.adminSql, authorSlug, ctx.ownLogKeyHex);
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

  // Precondition: the RECEIVER admits the AUTHOR's log (STEP-1 admission) so the
  // membership-aware apply can resolve the author's verified source-log device.
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

  return { handleAuthor, handleReceiver, authorDb, orgDb, authorSlug, receiverSlug, federate };
}

describe('federation ISSUES+ASSIGNMENTS matrix — engineer_issues + plan_item_assignments federate CROSS-MEMBER BOTH directions (faithful 2-boot, real swarm + PG, NO stubs; D-046 regression)', () => {
  // ────────────────────────────────────────────────────────────────────────────
  // DIRECTION A: OWNER → JOINER. Owner authors under the hive home; the JOINER boots a
  // member harness whose hive home is a remote_hive VIEW. row.harness_slug (HIVE_HOME) ≠
  // the joiner's bound slug → the membership-aware guard (D-046) must apply it.
  // ────────────────────────────────────────────────────────────────────────────
  it(
    'OWNER→JOINER: an engineer_issue + a plan_item_assignment authored on the OWNER federate to the JOINER (origin=remote)',
    async () => {
      const HIVE_HOME = 'eia-owner-hive';
      const JOINER_SLUG = 'eia-joined-owner-hive';
      const pair = await bootFedPair({
        hiveHome: HIVE_HOME,
        authorSlug: HIVE_HOME, // owner authors under the hive home
        receiverSlug: JOINER_SLUG, // joiner receives (real boot)
        receiverIsJoiner: true,
      });
      const { authorDb, orgDb, federate } = pair;

      // ── Author an engineer_issue + an assignment under the HIVE_HOME slug. ──
      await authorIssue(authorDb.adminSql, {
        slug: HIVE_HOME,
        issueId: 'EI-a1',
        kind: 'bug',
        title: 'owner bug',
        body: 'authored on the owner home',
        state: 'open',
      });
      await authorAssignment(authorDb.adminSql, {
        slug: HIVE_HOME,
        planSlug: 'owner-plan',
        itemId: 'P-001',
        assignee: 'owner-bee-1',
        assignedBy: 'su-A',
        strategy: 'default',
        note: 'owner assigns P-001',
      });
      // Capture sanity on the AUTHOR (the real mig-375 + mig-145 triggers).
      expect(await countIssueOutbox(authorDb.adminSql, 'EI-a1')).toBe(1);
      expect(await countOutbox(authorDb.adminSql, 'plan_item_assignments', 'owner-plan:P-001')).toBe(1);

      await federate();

      // ── ISSUE assertion on the RECEIVER (joiner). Lands under the AUTHORED slug. ──
      const issueOnB = await pollUntil(
        async () => {
          await Promise.all([pair.handleAuthor.mergeNow(), pair.handleReceiver.mergeNow()]);
          return readIssue(orgDb.adminSql, 'EI-a1');
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(issueOnB, 'engineer_issue owner→joiner: the issue never reached the joiner PG (D-046 guard)').toBeTruthy();
      expect(issueOnB).toMatchObject({ issue_id: 'EI-a1', scope: `harness:${HIVE_HOME}`, state: 'open', title: 'owner bug', kind: 'bug', origin: 'remote' });

      // ── ASSIGNMENT assertion on the RECEIVER. Lands under the AUTHORED slug. ──
      const asgOnB = await pollUntil(
        async () => {
          await Promise.all([pair.handleAuthor.mergeNow(), pair.handleReceiver.mergeNow()]);
          return readAssignment(orgDb.adminSql, 'owner-plan', 'P-001');
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(asgOnB, 'plan_item_assignment owner→joiner: the assignment never reached the joiner PG (D-046 guard)').toBeTruthy();
      expect(asgOnB).toMatchObject({ harness_slug: HIVE_HOME, plan_slug: 'owner-plan', item_id: 'P-001', assignee_name: 'owner-bee-1', strategy: 'default', origin: 'remote' });
    },
    180_000,
  );

  // ────────────────────────────────────────────────────────────────────────────
  // DIRECTION B: JOINER → OWNER. A member authors under its member slug; the OWNER's
  // RECEIVING harness IS the hive home (owner-home content-guard fallback, WI-559/FED-1).
  // row.harness_slug (MEMBER_SLUG) ≠ the owner-home's bound slug → the membership-aware
  // guard (D-046) must apply it.
  // ────────────────────────────────────────────────────────────────────────────
  it(
    'JOINER→OWNER: an engineer_issue + a plan_item_assignment authored on a MEMBER federate back to the OWNER (origin=remote)',
    async () => {
      const HIVE_HOME = 'eia-fed-owner-home';
      const MEMBER_SLUG = 'eia-fed-member';
      const pair = await bootFedPair({
        hiveHome: HIVE_HOME,
        authorSlug: MEMBER_SLUG, // member authors under its member slug
        receiverSlug: HIVE_HOME, // owner-home receives (real boot)
        receiverIsJoiner: false,
      });
      const { authorDb, orgDb, federate } = pair;

      // ── Author an engineer_issue + an assignment under the MEMBER slug. ──
      await authorIssue(authorDb.adminSql, {
        slug: MEMBER_SLUG,
        issueId: 'EI-b1',
        kind: 'task',
        title: 'member task',
        body: 'authored on the member',
        state: 'open',
      });
      await authorAssignment(authorDb.adminSql, {
        slug: MEMBER_SLUG,
        planSlug: 'member-plan',
        itemId: 'P-007',
        assignee: 'member-bee-2',
        assignedBy: 'su-B',
        strategy: 'blueprint',
        note: 'member assigns P-007',
      });
      expect(await countIssueOutbox(authorDb.adminSql, 'EI-b1')).toBe(1);
      expect(await countOutbox(authorDb.adminSql, 'plan_item_assignments', 'member-plan:P-007')).toBe(1);

      await federate();

      // ── ISSUE assertion on the OWNER. Lands under the MEMBER slug. ──
      const issueOnA = await pollUntil(
        async () => {
          await Promise.all([pair.handleAuthor.mergeNow(), pair.handleReceiver.mergeNow()]);
          return readIssue(orgDb.adminSql, 'EI-b1');
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(issueOnA, 'engineer_issue member→owner: the issue never reached the owner PG (D-046 guard)').toBeTruthy();
      expect(issueOnA).toMatchObject({ issue_id: 'EI-b1', scope: `harness:${MEMBER_SLUG}`, state: 'open', title: 'member task', kind: 'task', origin: 'remote' });

      // ── ASSIGNMENT assertion on the OWNER. Lands under the MEMBER slug. ──
      const asgOnA = await pollUntil(
        async () => {
          await Promise.all([pair.handleAuthor.mergeNow(), pair.handleReceiver.mergeNow()]);
          return readAssignment(orgDb.adminSql, 'member-plan', 'P-007');
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(asgOnA, 'plan_item_assignment member→owner: the assignment never reached the owner PG (D-046 guard)').toBeTruthy();
      expect(asgOnA).toMatchObject({ harness_slug: MEMBER_SLUG, plan_slug: 'member-plan', item_id: 'P-007', assignee_name: 'member-bee-2', strategy: 'blueprint', origin: 'remote' });
    },
    180_000,
  );

  // ────────────────────────────────────────────────────────────────────────────
  // WI-971 remnant (2026-07-16 live-fed-gate + gate-matrix): item-assignments BACKFILL
  // (a row that existed on the OWNER before the JOINER ever boots/discovers/joins) fails
  // in the real deb/smoke topology while INCREMENTAL (post-join) passes both directions.
  // The two `it`s above both author AFTER both peers are already booted + have admitted
  // each other's log (STEP-1 admission) — i.e. they never exercise a JOINER's very FIRST
  // merge pass folding the owner's PRE-EXISTING history from index 0 through the REAL
  // remote_hive-view rebind + membership-guard machinery. This one does: boot ONLY the
  // OWNER, author + drain the assignment, THEN boot the JOINER fresh (real
  // receiverIsJoiner:true rebind) so its first-ever merge pass is the backfill fold.
  // ────────────────────────────────────────────────────────────────────────────
  it(
    'BACKFILL: a plan_item_assignment authored+drained on the OWNER BEFORE the JOINER ever boots still lands as origin=remote',
    async () => {
      const HIVE_HOME = 'eia-backfill-owner-hive';
      const JOINER_SLUG = 'eia-backfill-joined-owner-hive';
      const authorSlug = HIVE_HOME;
      const receiverSlug = JOINER_SLUG;
      const memberSlug = JOINER_SLUG;

      const orgDb = await createOrgTestDb();
      cleanups.push(async () => {
        await orgDb?.cleanup();
      });
      const authorDb = await createOrgTestDb();
      cleanups.push(async () => {
        await authorDb?.cleanup();
      });
      installTraceAndEnv(orgDb);

      const idAuthor = makeIdentityOverride('bf-author', 199, 'kc-bf-author');
      const idReceiver = makeIdentityOverride('bf-receiver', 107, 'kc-bf-receiver');

      const hivePubkeyB64 = await seedHive(orgDb, HIVE_HOME, [
        { userId: idAuthor.userId, login: idAuthor.login, devicePubkey: idAuthor.devicePubkey },
        { userId: idReceiver.userId, login: idReceiver.login, devicePubkey: idReceiver.devicePubkey },
      ]);

      await mutateHarnessRegistry(
        (r) => ({
          ...r,
          projects: [
            ...r.projects,
            { slug: HIVE_HOME, path: '/tmp/eia-bf-home', harness_kind: 'hive', remote_hive: true },
            { slug: memberSlug, path: `/tmp/${memberSlug}`, hive_slug: HIVE_HOME },
          ],
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
      const rootAuthor = makeWorkspaceRoot('eia-bf-author-');
      const rootReceiver = makeWorkspaceRoot('eia-bf-receiver-');

      let handleAuthor: BootedHarnessHandle | undefined;
      let handleReceiver: BootedHarnessHandle | undefined;
      let applyAuthor: ((op: OpEnvelope) => Promise<boolean>) | undefined;

      // ── Boot ONLY the OWNER, author + drain — the JOINER does not exist yet. ──
      handleAuthor = await bootHarnessSubstrate({
        workspaceRoot: rootAuthor,
        workspaceId: WORKSPACE_ID,
        harnessSlug: authorSlug,
        swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
        swarmOverride: swarmAuthor,
        verifyBindingOverride: async (_pk, _login, userId) => (userId === idReceiver.userId ? 'verified' : 'fail'),
        applyOverride: (op, ctx) => {
          applyAuthor ??= buildIssuesAssignmentsPeerApply(authorDb.adminSql, authorSlug, ctx.ownLogKeyHex);
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

      await authorAssignment(authorDb.adminSql, {
        slug: HIVE_HOME,
        planSlug: 'backfill-plan',
        itemId: 'P-BF1',
        assignee: 'owner-bee-bf',
        assignedBy: 'su-bf-A',
        strategy: 'default',
        note: 'pre-existing, before the joiner ever boots',
      });
      expect(await countOutbox(authorDb.adminSql, 'plan_item_assignments', 'backfill-plan:P-BF1')).toBe(1);
      const lenA0 = handleAuthor.ownLog.length;
      expect(await drainOutboxOnce(handleAuthor, authorDb.adminSql)).toBeGreaterThanOrEqual(1);
      expect(handleAuthor.ownLog.length).toBeGreaterThan(lenA0);

      // ── NOW boot the JOINER — its very FIRST merge pass folds the owner's log from 0,
      // and MUST go through the real remote_hive-view rebind (receiverIsJoiner shape). ──
      const preBootOpsB: Array<{ op: OpEnvelope; resolve: (v: boolean) => void; reject: (e: unknown) => void }> = [];
      handleReceiver = await bootHarnessSubstrate({
        workspaceRoot: rootReceiver,
        workspaceId: WORKSPACE_ID,
        harnessSlug: receiverSlug,
        swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
        swarmOverride: swarmReceiver,
        verifyBindingOverride: async (_pk, _login, userId) => (userId === idAuthor.userId ? 'verified' : 'fail'),
        // NO applyOverride — the REAL boot scoped apply → getOrgPg() → orgDb (env-routed).
        // But boot may synchronously trigger a merge pass (on peer-connect) BEFORE this
        // await resolves — there is nothing to buffer here (real apply doesn't need
        // `handleReceiver` in scope), so this mirrors the two `it`s above verbatim.
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idReceiver.override,
      });
      cleanups.push(async () => {
        await handleReceiver?.close();
        await closeHarnessStore({ workspaceRoot: rootReceiver, harnessSlug: receiverSlug });
      });
      void preBootOpsB; // unused in this variant (real apply needs no handle capture)

      expect(handleAuthor.swarm).not.toBeNull();
      expect(handleReceiver.swarm).not.toBeNull();
      expect(handleAuthor.swarm!.topicHex).toBe(handleReceiver.swarm!.topicHex);

      const admitted =
        (await pollUntil(
          async () => {
            await Promise.all([handleAuthor!.mergeNow(), handleReceiver!.mergeNow()]);
            return handleReceiver!.admitted.has(handleAuthor!.ownLog.keyHex) ? true : undefined;
          },
          { timeoutMs: 20_000, intervalMs: 250 },
        )) ?? false;
      expect(admitted, "the JOINER did NOT admit the OWNER's log (STEP-1 admission)").toBe(true);

      const asgOnB = await pollUntil(
        async () => {
          await Promise.all([handleAuthor!.mergeNow(), handleReceiver!.mergeNow()]);
          return readAssignment(orgDb.adminSql, 'backfill-plan', 'P-BF1');
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(asgOnB, "the PRE-EXISTING assignment never reached the JOINER's PG (backfill failed)").toBeTruthy();
      expect(asgOnB).toMatchObject({
        harness_slug: HIVE_HOME,
        plan_slug: 'backfill-plan',
        item_id: 'P-BF1',
        assignee_name: 'owner-bee-bf',
        strategy: 'default',
        origin: 'remote', // WI-971: expected to currently FAIL as 'local' if this reproduces it
      });
    },
    180_000,
  );
});
