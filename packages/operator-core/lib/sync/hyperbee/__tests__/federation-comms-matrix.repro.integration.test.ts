/**
 * federation-comms-matrix.repro.test.ts
 *
 * "ALL harness-scoped COMMUNICATION (coord) surfaces federate, BOTH directions" — a
 * coord-surface × direction MATRIX over the SAME faithful 2-boot hermetic federation
 * harness as federation-content-matrix.repro.test.ts (real testnet-DHT swarm via
 * createTestnet + real testcontainer org Postgres; the REAL boot apply seam
 * `bootHarnessSubstrate` — NO applyOverride / NO resolveAuthorDevice stub on the
 * RECEIVER, so boot's real joiner rebind / owner-home fallback + the
 * `admittedIdentities → resolveAuthorDevice → resolveHiveMemberDeviceSet` chain are on
 * the path end-to-end). This is the COORD analog of the content matrix: it swaps the
 * content rows (features/plans) for the four federating coord tables and exercises the
 * REAL capture→drain→merge→projection path for each.
 *
 * The shared-hive "communication system" is the harness-scoped coordination layer
 * (plan distributed-coordination-shared-harness-2026-06-04, Track A). It federates over
 * each harness's peer-log via the SAME substrate path as content:
 *   coord write → capture_substrate_outbox() trigger (migs 144/149/150) →
 *   substrate_outbox → drainOutboxOnce → own Hypercore log → peer read-merge →
 *   coord projection apply → peer PG.
 *
 * MATRIX (each cell run through the REAL receiver boot apply, BOTH directions):
 *   • M1 — coord_threads + coord_thread_posts: a thread + its post(s) federate; the
 *     post is keyed by the GLOBAL post_msg_id (not the machine-local bigserial id),
 *     lands origin='remote', and the thread header post_count RIDES the federated
 *     coord_threads UPDATE (the post projection never bumps the count).
 *   • M2 — coord_conversations (scope='harness'): the conversation federates;
 *     accepted_post_id (a local bigserial pointer) stays NULL on the remote apply.
 *   • M3 — coord_event_log glyph stream: an intent (surface 'messages'), a handoff
 *     (surface 'handoffs'), and an escalation (surface 'escalations') all federate,
 *     keyed by the global msg_id.
 *   • M4 — SCOPE CORRECTNESS (a real cross-machine property, D-002): an OPERATOR-scope
 *     coord row (harness_slug NULL) is NOT captured and NEVER federates, while a
 *     harness-scoped sibling does.
 *   • M5 — DELIVERY-STAYS-LOCAL (D-002): the per-machine delivery tables
 *     (coord_entity_subscriptions) carry NO capture trigger and produce NO outbox row,
 *     so they never cross machines (each peer regenerates them from its OWN
 *     subscriptions). A focused capture-layer assertion (no 2-boot needed).
 *
 * Direction A (TEST 1) = OWNER→JOINER (owner authors under the hive home; the JOINER
 * boots a member harness whose hive home is a remote_hive VIEW → boot's real
 * joinerPotHomeSlug rebind + membership chain are on the path). Direction B (TEST 2) =
 * JOINER→OWNER (a member authors under its member slug; the OWNER's RECEIVING harness IS
 * the hive home → the owner-home content-guard fallback, WI-559/FED-1, engages). Each
 * direction's coord rows cross SLUGS (author slug ≠ receiver slug, the real shared-hive
 * member↔member topology the live deb-hetzner run uses), so the apply lands them under
 * the AUTHOR's slug via the WI-259 membership-aware guard.
 *
 * PAPERCUSP_A003_TRACE=1 is set so the member-guard decisions print (grep `[A-003]`);
 * console.error is redirected so the repo's vitest-fail-on-console gate doesn't trip
 * (same trick as the content matrix).
 *
 * RUN (real testcontainer PG):
 *   cd packages/operator-core && VITEST_UNIT_TIMEOUT_MS=180000 \
 *     npx vitest run lib/sync/hyperbee/__tests__/federation-comms-matrix.repro.test.ts
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
import { buildCoordThreadProjection } from '../projections/coord-thread';
import { buildCoordThreadPostProjection } from '../projections/coord-thread-post';
import { buildCoordConversationProjection } from '../projections/coord-conversation';
import { buildCoordMessageProjection } from '../projections/coord-message';
import { PgThreadStore } from '@papercusp/coordination/capabilities';
import { _resetForTests as resetDbOrgPools } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache the pool resolver memoizes
import { _resetUrlCacheForTests } from '../../../../../../libs/papercusp/libs/db/src/connection';
import { _resetHarnessAdminUrlCacheForTests } from '../../../embedded-pg-discovery';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { mutateHarnessRegistry } from '../../../harness-registry';
import { _clearHiveMemberDeviceSetCacheForTest } from '../hive-member-identity-set';

const WORKSPACE_ID = 'ws-comms-stage6';

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

// ── Shared env / A-003-trace scaffolding installed per-test (mirrors the content
//    matrix). Routes getOrgPg → the RECEIVER's org DB. Returns the [A-003] lines. ──
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
  // Comms-trust lattice (P-013, cross-machine-coord-parity-and-trust-2026-07-01,
  // landed 2026-07-01): the receiver-side coord-message projection quarantines
  // 'handoffs'-surface rows from authors below the 'steer' tier
  // ('handoff-below-steer'). This hermetic org DB has neither a local override
  // nor a hive-policy comms.defaultTier, so authors resolved the FALLBACK tier
  // 'message' — which quarantined M3's handoff glyphs and broke this matrix
  // from 2026-07-02 on. The matrix asserts the POSITIVE path (every coord
  // surface federates for a TRUSTED author, both directions), so grant the
  // matrix identities 'steer'; the below-tier quarantine path has its own
  // dedicated coverage in the coord-message federation tier-gate tests.
  for (const m of members) {
    await orgDb.adminSql`
      INSERT INTO harness_shared.comms_trust_list
        (workspace_id, trusted_github_user_id, tier, note, created_ts, updated_ts)
      VALUES (${WORKSPACE_ID}, ${m.userId}, 'steer', 'matrix test author — trusted', 1, 1)
      ON CONFLICT (workspace_id, trusted_github_user_id)
        DO UPDATE SET tier = 'steer', updated_ts = 1
    `;
  }
  const [row] = await orgDb.adminSql<Array<{ pk: string }>>`
    SELECT encode(public_key, 'base64') AS pk FROM harness_shared.pots
     WHERE workspace_id = ${WORKSPACE_ID} AND pot_home_slug = ${hiveHome}
  `;
  return row!.pk;
}

/** The throwaway per-peer apply for the AUTHOR (its own coord-origin org DB). All four
 *  coord projections are CDC-captured → skipOwnOps, so the author's own appended ops are
 *  no-ops here; the set just makes the op-dispatch lookup complete. */
function buildCoordPeerApply(
  sql: postgres.Sql,
  authorSlug: string,
  ownLogKeyHex: string,
): (op: OpEnvelope) => Promise<boolean> {
  const opts = { workspaceId: WORKSPACE_ID, harnessSlug: authorSlug, sql };
  const scoped = new Map<string, TableProjection<unknown>>();
  for (const p of [
    buildCoordThreadProjection(opts),
    buildCoordThreadPostProjection(opts),
    buildCoordConversationProjection(opts),
    buildCoordMessageProjection(opts),
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

// ── Coord row readers (read either the author slug or hive home — the apply lands the
//    row under the AUTHORED slug via the membership guard). ──
async function readThread(sql: postgres.Sql, threadId: string) {
  const rows = await sql<
    Array<{ thread_id: string; title: string | null; post_count: number; harness_slug: string | null; origin: string }>
  >`SELECT thread_id, title, post_count, harness_slug, origin
      FROM harness_shared.coord_threads WHERE workspace_id = ${WORKSPACE_ID} AND thread_id = ${threadId}`;
  return rows[0];
}
async function readPosts(sql: postgres.Sql, threadId: string) {
  return sql<Array<{ body: string; post_msg_id: string | null; origin: string; harness_slug: string | null }>>`
    SELECT body, post_msg_id, origin, harness_slug
      FROM harness_shared.coord_thread_posts
     WHERE workspace_id = ${WORKSPACE_ID} AND thread_id = ${threadId} ORDER BY created_at`;
}
async function readConversation(sql: postgres.Sql, id: string) {
  const rows = await sql<
    Array<{ id: string; title: string | null; state: string; accepted_post_id: number | null; origin: string; harness_slug: string | null }>
  >`SELECT id, title, state, accepted_post_id, origin, harness_slug
      FROM harness_shared.coord_conversations WHERE workspace_id = ${WORKSPACE_ID} AND id = ${id}`;
  return rows[0];
}
async function readEvent(sql: postgres.Sql, msgId: string) {
  const rows = await sql<
    Array<{ msg_id: string; surface: string; origin: string; harness_slug: string | null; summary: string | null }>
  >`SELECT msg_id, surface, origin, harness_slug, body->>'summary' AS summary
      FROM harness_shared.coord_event_log WHERE workspace_id = ${WORKSPACE_ID} AND msg_id = ${msgId}`;
  return rows[0];
}

/** Author a harness-scoped coord_event_log row directly (the same shape PgCoordLog
 *  appendLine/putEvent writes — the capture trigger is the federation seam). */
async function authorEvent(
  sql: postgres.Sql,
  opts: { msgId: string; surface: string; harnessSlug: string | null; from: string; to: string[]; kind: string; summary: string },
) {
  const body = {
    ts: new Date(1_700_000_000_000).toISOString(),
    msg_id: opts.msgId,
    from: opts.from,
    to: opts.to,
    kind: opts.kind,
    summary: opts.summary,
  };
  await sql`
    INSERT INTO harness_shared.coord_event_log
      (workspace_id, surface, writer_key, msg_id, body, harness_slug, origin)
    VALUES (${WORKSPACE_ID}, ${opts.surface}, ${opts.from}, ${opts.msgId},
            ${JSON.stringify(body)}::text::jsonb, ${opts.harnessSlug}, 'local')
  `;
}

interface CommsPair {
  handleAuthor: BootedHarnessHandle;
  handleReceiver: BootedHarnessHandle;
  authorDb: OrgTestDb; // the AUTHOR's coord-origin DB (writes + drain here)
  orgDb: OrgTestDb; // the RECEIVER's DB (env-routed getOrgPg; assert here)
  authorSlug: string;
  receiverSlug: string;
  /** drain the author's outbox + run several merge passes both ways. */
  federate: (passes?: number) => Promise<void>;
}

/**
 * Boot a faithful 2-peer hive pair. One peer AUTHORS (applyOverride → its own org DB,
 * so its content origin is separate from the receiver's) and the other RECEIVES via the
 * REAL boot scoped apply (no override → getOrgPg → the env-routed receiver org DB). The
 * registry topology is the content-matrix's: when the receiver is a JOINER, the hive
 * home is a remote_hive VIEW (boot rebinds) and the owner authors under the home; when
 * the owner is the receiver, it boots the home harness and a member authors under a
 * member slug.
 */
async function bootCommsPair(cfg: {
  hiveHome: string;
  authorSlug: string;
  receiverSlug: string;
  receiverIsJoiner: boolean;
}): Promise<CommsPair> {
  const { hiveHome, authorSlug, receiverSlug, receiverIsJoiner } = cfg;
  const memberSlug = authorSlug === hiveHome ? receiverSlug : authorSlug;

  const orgDb = await createOrgTestDb(); // RECEIVER (env-routed) + the shared hive/registry source
  cleanups.push(async () => {
    await orgDb?.cleanup();
  });
  const authorDb = await createOrgTestDb(); // AUTHOR's coord-origin DB (full real schema + capture)
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
          ? { slug: hiveHome, path: '/tmp/comms-home', harness_kind: 'hive', remote_hive: true }
          : { slug: hiveHome, path: '/tmp/comms-home', harness_kind: 'hive' },
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
  const rootAuthor = makeWorkspaceRoot('comms-author-');
  const rootReceiver = makeWorkspaceRoot('comms-receiver-');

  let handleAuthor: BootedHarnessHandle | undefined;
  let handleReceiver: BootedHarnessHandle | undefined;
  let applyAuthor: ((op: OpEnvelope) => Promise<boolean>) | undefined;

  // AUTHOR = throwaway per-peer apply on its own coord-origin DB.
  handleAuthor = await bootHarnessSubstrate({
    workspaceRoot: rootAuthor,
    workspaceId: WORKSPACE_ID,
    harnessSlug: authorSlug,
    swarmBinding: { kind: 'hive' as const, hive_pubkey: hivePubkeyB64 },
    swarmOverride: swarmAuthor,
    verifyBindingOverride: async (_pk, _login, userId) =>
      userId === idReceiver.userId ? 'verified' : 'fail',
    applyOverride: (op, ctx) => {
      applyAuthor ??= buildCoordPeerApply(authorDb.adminSql, authorSlug, ctx.ownLogKeyHex);
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

describe('federation COMMS matrix — harness-scoped coordination surfaces federate BOTH directions (faithful 2-boot, real swarm + PG, NO stubs)', () => {
  // ────────────────────────────────────────────────────────────────────────────
  // DIRECTION A: OWNER → JOINER. Owner authors coord under the hive home; the JOINER
  // boots a member harness whose hive home is a remote_hive VIEW. Covers M1/M2/M3
  // owner→member + M4 scope correctness.
  // ────────────────────────────────────────────────────────────────────────────
  it(
    'OWNER→JOINER: thread+posts (M1), conversation (M2), event glyphs (M3) federate; operator-scope stays local (M4)',
    async () => {
      const HIVE_HOME = 'comms-owner-hive';
      const JOINER_SLUG = 'comms-joined-owner-hive';
      const pair = await bootCommsPair({
        hiveHome: HIVE_HOME,
        authorSlug: HIVE_HOME, // owner authors under the hive home
        receiverSlug: JOINER_SLUG, // joiner receives (real boot)
        receiverIsJoiner: true,
      });
      const { authorDb, orgDb, federate } = pair;

      // ── M1: coord_threads + coord_thread_posts via the REAL PgThreadStore (mints
      //    post_msg_id, inherits harness_slug, bumps post_count). ──
      const threads = new PgThreadStore({
        getSql: () => authorDb.adminSql,
        ensureSchema: async () => {},
        workspaceId: WORKSPACE_ID,
      });
      await threads.getOrCreateThread(
        { kind: 'conversation', ref: 'conv-a1' },
        { thread_id: 'thr-a1', title: 'Owner thread', created_by: 'su-A', created_ts: new Date(1_700_000_000_000).toISOString(), harness_slug: HIVE_HOME },
      );
      const post = await threads.addPost({ thread_id: 'thr-a1', author_id: 'su-A', body: 'owner first post', created_ts: new Date(1_700_000_050_000).toISOString() });
      expect(post.thread_id).toBe('thr-a1');
      // Capture sanity on the AUTHOR (the real migs-149 triggers).
      expect(await countOutbox(authorDb.adminSql, 'coord_threads', 'thr-a1')).toBe(2); // INSERT + post_count UPDATE
      const [postOutbox] = await authorDb.adminSql<Array<{ key: string; row: Record<string, unknown> | null }>>`
        SELECT key, row FROM harness_shared.substrate_outbox WHERE table_name='coord_thread_posts' ORDER BY id`;
      // The post's federation key is the minted GLOBAL post_msg_id, NOT the machine-local bigserial id.
      expect(postOutbox.key.length).toBeGreaterThan(0);
      expect(postOutbox.key).toBe(String(postOutbox.row?.post_msg_id));

      // ── M2: a harness-scoped conversation. ──
      await authorDb.adminSql`
        INSERT INTO harness_shared.coord_conversations
          (workspace_id, id, kind, scope, harness_slug, asker_id, title, body, state)
        VALUES (${WORKSPACE_ID}, 'conv-a1', 'question', 'harness', ${HIVE_HOME}, 'su-A', 'Owner Q', 'asked on owner', 'open')`;
      // accepted_post_id is set LOCALLY on the author — it must NOT federate (NULL on remote).
      await authorDb.adminSql`UPDATE harness_shared.coord_conversations SET accepted_post_id = 42 WHERE workspace_id=${WORKSPACE_ID} AND id='conv-a1'`;
      expect(await countOutbox(authorDb.adminSql, 'coord_conversations', 'conv-a1')).toBeGreaterThanOrEqual(1);

      // ── M3: the coord_event_log glyph stream — intent / handoff / escalation. ──
      await authorEvent(authorDb.adminSql, { msgId: 'evt-intent-a', surface: 'messages', harnessSlug: HIVE_HOME, from: 'su-A', to: ['su-B'], kind: 'intent', summary: 'owner declares intent' });
      await authorEvent(authorDb.adminSql, { msgId: 'evt-handoff-a', surface: 'handoffs', harnessSlug: HIVE_HOME, from: 'su-A', to: ['su-B'], kind: 'handoff', summary: 'owner hands off' });
      await authorEvent(authorDb.adminSql, { msgId: 'evt-escal-a', surface: 'escalations', harnessSlug: HIVE_HOME, from: 'su-A', to: ['*'], kind: 'escalation', summary: 'owner escalates' });
      for (const m of ['evt-intent-a', 'evt-handoff-a', 'evt-escal-a']) {
        expect(await countOutbox(authorDb.adminSql, 'coord_event_log', m)).toBe(1);
      }

      // ── M4: an OPERATOR-scope event (harness_slug NULL) must NOT be captured. ──
      await authorEvent(authorDb.adminSql, { msgId: 'evt-operator-a', surface: 'messages', harnessSlug: null, from: 'su-A', to: ['su-B'], kind: 'message', summary: 'operator-scope, must stay local' });
      expect(await countOutbox(authorDb.adminSql, 'coord_event_log', 'evt-operator-a')).toBe(0);

      await federate();

      // ── M1 assertions on the RECEIVER (joiner). Lands under the AUTHORED slug. ──
      const threadOnB = await readThread(orgDb.adminSql, 'thr-a1');
      expect(threadOnB, 'M1 owner→joiner: thread never reached the joiner PG').toBeTruthy();
      expect(threadOnB).toMatchObject({ title: 'Owner thread', origin: 'remote', harness_slug: HIVE_HOME });
      expect(threadOnB!.post_count, 'M1: post_count must RIDE the federated coord_threads UPDATE').toBe(1);
      const postsOnB = await readPosts(orgDb.adminSql, 'thr-a1');
      expect(postsOnB.map((p) => p.body)).toEqual(['owner first post']);
      expect(postsOnB[0].origin).toBe('remote');
      expect(postsOnB[0].post_msg_id, 'M1: the post must be keyed by the GLOBAL post_msg_id').toBeTruthy();

      // ── M2 assertions. ──
      const convOnB = await readConversation(orgDb.adminSql, 'conv-a1');
      expect(convOnB, 'M2 owner→joiner: conversation never reached the joiner PG').toBeTruthy();
      expect(convOnB).toMatchObject({ title: 'Owner Q', state: 'open', origin: 'remote', harness_slug: HIVE_HOME });
      expect(convOnB!.accepted_post_id, 'M2: accepted_post_id (a local bigserial) must NOT federate').toBeNull();

      // ── M3 assertions — all three glyph surfaces. ──
      for (const [msg, surface] of [['evt-intent-a', 'messages'], ['evt-handoff-a', 'handoffs'], ['evt-escal-a', 'escalations']] as const) {
        const ev = await readEvent(orgDb.adminSql, msg);
        expect(ev, `M3 owner→joiner: ${surface} glyph ${msg} never reached the joiner`).toBeTruthy();
        expect(ev).toMatchObject({ surface, origin: 'remote', harness_slug: HIVE_HOME });
      }

      // ── M4 assertion — the operator-scope row never federated; the harness-scoped sibling did. ──
      expect(await readEvent(orgDb.adminSql, 'evt-operator-a'), 'M4: operator-scope coord must NOT federate').toBeFalsy();
      expect(await readEvent(orgDb.adminSql, 'evt-intent-a'), 'M4 control: harness-scoped sibling MUST federate').toBeTruthy();
    },
    180_000,
  );

  // ────────────────────────────────────────────────────────────────────────────
  // DIRECTION B: JOINER → OWNER. A member authors coord under its member slug; the
  // OWNER's RECEIVING harness IS the hive home (owner-home content-guard fallback).
  // Covers M1/M2/M3 member→owner — incl. the "reply authored on B federates back to A"
  // case (a 2-post thread → post_count=2 rides the header).
  // ────────────────────────────────────────────────────────────────────────────
  it(
    'JOINER→OWNER: thread+reply (M1), conversation (M2), event glyphs (M3) federate back to the owner',
    async () => {
      const HIVE_HOME = 'comms-fed-owner-home';
      const MEMBER_SLUG = 'comms-fed-member';
      const pair = await bootCommsPair({
        hiveHome: HIVE_HOME,
        authorSlug: MEMBER_SLUG, // member authors under its member slug
        receiverSlug: HIVE_HOME, // owner-home receives (real boot)
        receiverIsJoiner: false,
      });
      const { authorDb, orgDb, federate } = pair;

      // ── M1: a thread + TWO posts (the reply) authored on the MEMBER. ──
      const threads = new PgThreadStore({
        getSql: () => authorDb.adminSql,
        ensureSchema: async () => {},
        workspaceId: WORKSPACE_ID,
      });
      await threads.getOrCreateThread(
        { kind: 'conversation', ref: 'conv-b1' },
        { thread_id: 'thr-b1', title: 'Member thread', created_by: 'su-B', created_ts: new Date(1_700_000_000_000).toISOString(), harness_slug: MEMBER_SLUG },
      );
      await threads.addPost({ thread_id: 'thr-b1', author_id: 'su-B', body: 'member post one', created_ts: new Date(1_700_000_010_000).toISOString() });
      await threads.addPost({ thread_id: 'thr-b1', author_id: 'su-B', body: 'member reply two', created_ts: new Date(1_700_000_020_000).toISOString() });

      // ── M2: a harness-scoped conversation. ──
      await authorDb.adminSql`
        INSERT INTO harness_shared.coord_conversations
          (workspace_id, id, kind, scope, harness_slug, asker_id, title, body, state)
        VALUES (${WORKSPACE_ID}, 'conv-b1', 'discussion', 'harness', ${MEMBER_SLUG}, 'su-B', 'Member topic', 'started on member', 'open')`;

      // ── M3: intent / handoff / escalation. ──
      await authorEvent(authorDb.adminSql, { msgId: 'evt-intent-b', surface: 'messages', harnessSlug: MEMBER_SLUG, from: 'su-B', to: ['su-A'], kind: 'intent', summary: 'member declares intent' });
      await authorEvent(authorDb.adminSql, { msgId: 'evt-handoff-b', surface: 'handoffs', harnessSlug: MEMBER_SLUG, from: 'su-B', to: ['su-A'], kind: 'handoff', summary: 'member hands off' });
      await authorEvent(authorDb.adminSql, { msgId: 'evt-escal-b', surface: 'escalations', harnessSlug: MEMBER_SLUG, from: 'su-B', to: ['*'], kind: 'escalation', summary: 'member escalates' });

      await federate();

      // ── M1 assertions on the OWNER. Lands under the MEMBER slug. ──
      const threadOnA = await readThread(orgDb.adminSql, 'thr-b1');
      expect(threadOnA, 'M1 member→owner: thread never reached the owner PG').toBeTruthy();
      expect(threadOnA).toMatchObject({ title: 'Member thread', origin: 'remote', harness_slug: MEMBER_SLUG });
      expect(threadOnA!.post_count, 'M1: post_count=2 must RIDE the federated header (reply included)').toBe(2);
      const postsOnA = await readPosts(orgDb.adminSql, 'thr-b1');
      expect(postsOnA.map((p) => p.body)).toEqual(['member post one', 'member reply two']);
      expect(postsOnA.every((p) => p.origin === 'remote')).toBe(true);
      expect(postsOnA.every((p) => !!p.post_msg_id)).toBe(true);

      // ── M2 assertions. ──
      const convOnA = await readConversation(orgDb.adminSql, 'conv-b1');
      expect(convOnA, 'M2 member→owner: conversation never reached the owner PG').toBeTruthy();
      expect(convOnA).toMatchObject({ title: 'Member topic', state: 'open', origin: 'remote', harness_slug: MEMBER_SLUG });

      // ── M3 assertions. ──
      for (const [msg, surface] of [['evt-intent-b', 'messages'], ['evt-handoff-b', 'handoffs'], ['evt-escal-b', 'escalations']] as const) {
        const ev = await readEvent(orgDb.adminSql, msg);
        expect(ev, `M3 member→owner: ${surface} glyph ${msg} never reached the owner`).toBeTruthy();
        expect(ev).toMatchObject({ surface, origin: 'remote', harness_slug: MEMBER_SLUG });
      }
    },
    180_000,
  );

  // ────────────────────────────────────────────────────────────────────────────
  // M5: DELIVERY-STAYS-LOCAL (D-002). The per-machine delivery table
  // coord_entity_subscriptions carries NO federation capture trigger and produces NO
  // outbox row — so subscriptions/wakes never cross machines (each peer regenerates
  // them from its OWN subscriptions). A focused capture-layer assertion (no 2-boot).
  // ────────────────────────────────────────────────────────────────────────────
  it('M5: coord_entity_subscriptions (delivery) is NOT in the captured/federated set', async () => {
    const db = await createOrgTestDb();
    cleanups.push(async () => {
      await db?.cleanup();
    });

    // No capture_substrate_outbox trigger is attached to the delivery table.
    const capTriggers = await db.adminSql<Array<{ tgname: string }>>`
      SELECT t.tgname
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE n.nspname = 'harness_shared'
         AND c.relname = 'coord_entity_subscriptions'
         AND p.proname = 'capture_substrate_outbox'
         AND NOT t.tgisinternal`;
    expect(capTriggers, 'M5: a federation capture trigger must NOT exist on the delivery table').toHaveLength(0);

    // And writing a subscription enqueues NOTHING into the outbox (delivery stays local).
    await db.adminSql`DELETE FROM harness_shared.substrate_outbox`;
    await db.adminSql`
      INSERT INTO harness_shared.coord_entity_subscriptions
        (workspace_id, subscriber_id, target_kind, target_ref, delivery_mode)
      VALUES (${WORKSPACE_ID}, 'su-A', 'topic', 'fed-comms', 'full')`;
    const [{ n }] = await db.adminSql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM harness_shared.substrate_outbox`;
    expect(Number(n), 'M5: a subscription write must NOT enqueue an outbox row').toBe(0);
  });
});
