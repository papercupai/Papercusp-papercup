/**
 * claim-next-co-location.integration.test.ts — cross-Swarm CO-LOCATION end-to-end
 * (hive-coordination-model-2026-06-08 P-002/P-003, "verify across >=2 Swarms").
 *
 * TWO Swarms of one Hive draw from ONE shared work-item backlog. With the per-Hive
 * claim lease active, co-location holds: each Swarm claims the work AFFINED to it (+
 * shared unaffined work), and NEVER steals work affined to the other Swarm. This is
 * the scenario-level proof on top of the unit-level affinity tests
 * (work-items-swarm-affinity.integration.test.ts) and the authority-serialization
 * proof (work-item-claims-two-instance.integration.test.ts) — both cited, not
 * duplicated. Federation TRANSPORT across real machines is proven separately
 * (shared-hive-federation P-011, Hetzner cross-machine).
 *
 * Two layers are exercised:
 *   1. claimNextWorkItem({swarmId}) — the SELECT-side affinity filter (each Swarm sees
 *      only its own + unaffined work), against a shared PG.
 *   2. the work_items:claim_next HANDLER — that, under the WORKITEM_CLAIM_LEASE flag,
 *      it derives THIS Swarm's id from localSwarmId and threads it in (so affinity
 *      engages in the real tool path), and is affinity-blind when the flag is off.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, applyClaimPathReadDeps, ENGINEER_ISSUES_MIN_DDL } from '../test/_work-items-schema';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { emitFlagChange } from '@papercusp/flags/server';

const H = 'h1';
const SWARM_A = 'pubkey-aaaa';
const SWARM_B = 'pubkey-bbbb';

const HFC_DDL = HARNESS_FEATURES_CONSOLIDATED_DDL;

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
// localSwarmId is mutable per simulated Swarm — the handler reads it under the flag.
const whoami = vi.hoisted(() => ({ swarm: 'local' as string, owner: 'agent' as string }));
vi.mock('./fleet/swarm-identity', () => ({
  LOCAL_SWARM: 'local',
  localSwarmId: () => whoami.swarm,
}));
// Isolate the affinity behavior from the authority RPC: the lease GRANTS locally (the
// authority-serialization path is proven by work-item-claims-two-instance). We toggle
// the WORKITEM_CLAIM_LEASE flag itself in each test (P-012 migrated it off the env var).
vi.mock('./work-item-claim-lease-wiring', async () => {
  const actual = await vi.importActual<typeof import('./work-item-claim-lease-wiring')>('./work-item-claim-lease-wiring');
  return { ...actual, leaseClaimedWorkItem: async () => true };
});
vi.mock('./agent-tools/coordination/identity', async () => {
  const actual = await vi.importActual<typeof import('./agent-tools/coordination/identity')>('./agent-tools/coordination/identity');
  return { ...actual, resolveAgentIdentity: () => ({ ownerId: whoami.owner, ownerLabel: whoami.owner, source: 'omp-hook-session', workspaceId: 'default', userId: null }) };
});

const wi = await import('./work-items');
const claimNextTool = (await import('./agent-tools/work_items/claim_next')).default;
let db: FreshPgDb;

/**
 * Drive the WORKITEM_CLAIM_LEASE FLAG (P-012/D-008 migrated the gate off the
 * PAPERCUSP_WORKITEM_CLAIM_LEASE env var). The claim-lease wiring caches the flag in a
 * SYNC boolean refreshed on flag change — force the override, fire the change, await the tick.
 */
async function setLeaseFlag(on: boolean): Promise<void> {
  setFlagOverridesForTest({ [FLAGS.WORKITEM_CLAIM_LEASE]: on });
  emitFlagChange(FLAGS.WORKITEM_CLAIM_LEASE);
  await new Promise((r) => setTimeout(r, 0));
}

async function seed(id: string, opts: { affinity?: string | null; createdTs?: number } = {}) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, swarm_affinity, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'feature', 'open', ${opts.affinity ?? null}, 'default', ${opts.createdTs ?? 0}, 0)`;
}

/** Drive the real claim_next HANDLER as a given Swarm and caller. */
async function handlerResult(swarm: string, owner: string, assignee = owner) {
  whoami.swarm = swarm;
  whoami.owner = owner;
  const res = await (
    claimNextTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: { text: string }[] }>;
    }
  ).handler({ harness: H, assignee }, { log() {}, workspaceId: 'default', role: 'worker' });
  return JSON.parse(res.content[0].text);
}

async function handlerClaim(swarm: string, owner: string): Promise<string> {
  const parsed = await handlerResult(swarm, owner);
  expect(parsed, `claim_next refused the fixture actor: ${JSON.stringify(parsed)}`).toMatchObject({ ok: true });
  return parsed.workItem.id;
}

beforeAll(async () => {
  db = await createFreshPgDb('claim-next-coloc');
  h.sql = db.sql;
  await db.sql.unsafe(HFC_DDL);
  // G2 trust leg (P-010): autoPickableWhereSql(sql, ws) consults this table.
  await db.sql.unsafe(
    `CREATE TABLE IF NOT EXISTS harness_shared.user_trust_list (workspace_id text NOT NULL, trusted_github_user_id bigint NOT NULL, note text, created_ts bigint NOT NULL, PRIMARY KEY (workspace_id, trusted_github_user_id))`,
  );
  // claim path's P-005 readiness clause reads work_item_deps + engineer_issues (this test creates neither otherwise).
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(ENGINEER_ISSUES_MIN_DDL);
  // WI-2971 (SCHEDULER_SPEC_CLAIM, default-ON): the claim_next HANDLER now routes through
  // getNextForBee (claim-spec-store.ts), which SELECTs/UPSERTs harness_shared.cup_claim_specs
  // unconditionally even when no spec was ever set — this hand-built rig otherwise 42703s
  // ("relation cup_claim_specs does not exist") on every handlerClaim() call. Minimal
  // (mig 372 + 389 id_only + 438 harness_slug) shape, no federation triggers (this test
  // never sets harness_slug, so the CDC capture path is never exercised).
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.cup_claim_specs (
      workspace_id text        NOT NULL DEFAULT 'default',
      bee_id       text        NOT NULL,
      spec         jsonb       NOT NULL,
      revision     integer     NOT NULL DEFAULT 0,
      id_only      boolean     NOT NULL DEFAULT false,
      updated_by   text,
      harness_slug text,
      updated_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, bee_id)
    )`);
});
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await db.sql`DELETE FROM harness_shared.harness_features_consolidated`; });
afterEach(async () => { await setLeaseFlag(false); whoami.swarm = 'local'; whoami.owner = 'agent'; });
afterAll(() => setFlagOverridesForTest(null));

describe('two Swarms partition one backlog by co-location affinity (claimNextWorkItem)', () => {
  it('each Swarm drains its OWN affined work + shared unaffined, never the other Swarm\'s', async () => {
    await seed('F-A1', { affinity: SWARM_A, createdTs: 10 });
    await seed('F-B1', { affinity: SWARM_B, createdTs: 20 });
    await seed('F-U', { affinity: null, createdTs: 30 }); // shared, either may take
    await seed('F-A2', { affinity: SWARM_A, createdTs: 40 });

    // Swarm A drains until it has nothing left it's allowed to claim.
    const aClaims: string[] = [];
    for (;;) {
      const got = await wi.claimNextWorkItem({ harness: H, assignee: 'a', swarmId: SWARM_A });
      if (!got) break;
      aClaims.push(got.id);
    }
    // Swarm B drains what remains.
    const bClaims: string[] = [];
    for (;;) {
      const got = await wi.claimNextWorkItem({ harness: H, assignee: 'b', swarmId: SWARM_B });
      if (!got) break;
      bClaims.push(got.id);
    }

    // A took its affined items (+ the shared unaffined, which it reached first); it
    // NEVER took F-B1. B took its affined item; it NEVER took an A-affined item.
    expect(aClaims).toEqual(expect.arrayContaining(['F-A1', 'F-A2']));
    expect(aClaims).not.toContain('F-B1');
    expect(bClaims).toContain('F-B1');
    expect(bClaims).not.toContain('F-A1');
    expect(bClaims).not.toContain('F-A2');
    // Every item got claimed exactly once across the two Swarms.
    expect([...aClaims, ...bClaims].sort()).toEqual(['F-A1', 'F-A2', 'F-B1', 'F-U']);
  });

  it('a Swarm with ONLY the other Swarm\'s affined work available claims nothing', async () => {
    await seed('F-B1', { affinity: SWARM_B });
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'a', swarmId: SWARM_A })).toBeNull();
  });
});

describe('work_items:claim_next handler — flag gates the co-location affinity', () => {
  it('persists claim recall telemetry through the real writer', async () => {
    const { recordRecallStats } = await import('./memory/recall-stats');
    await recordRecallStats(db.sql, { surface: 'claim', entries: [] });
    const [row] = await db.sql`
      SELECT surface, hit_count FROM harness_shared.memory_recall_stats
      ORDER BY id DESC LIMIT 1`;
    expect(row).toMatchObject({ surface: 'claim', hit_count: 0 });
  });

  it('with the lease ON, the handler threads localSwarmId so affinity engages', async () => {
    await setLeaseFlag(true);
    await seed('F-B1', { affinity: SWARM_B, createdTs: 10 }); // older, but B's
    await seed('F-A1', { affinity: SWARM_A, createdTs: 20 }); // newer, A's
    // Swarm A's handler must skip the older B-affined item and take its own.
    expect(await handlerClaim(SWARM_A, 'a')).toBe('F-A1');
  });

  it('with the lease OFF (default), the handler is affinity-blind (oldest-first)', async () => {
    await seed('F-B1', { affinity: SWARM_B, createdTs: 10 }); // older, B's
    await seed('F-A1', { affinity: SWARM_A, createdTs: 20 });
    // No flag ⇒ swarmId not threaded ⇒ affinity ignored ⇒ oldest wins even though it's B's.
    expect(await handlerClaim(SWARM_A, 'a')).toBe('F-B1');
  });

  it('rejects an unknown explicit assignee without claiming the affined item', async () => {
    await setLeaseFlag(true);
    await seed('F-A1', { affinity: SWARM_A, createdTs: 10 });

    const rejected = await handlerResult(SWARM_A, 'a', 'colocation-fixture-owner-that-does-not-exist');
    expect(rejected).toMatchObject({ ok: false, error: 'assignee_unknown' });
    const [row] = await db.sql`
      SELECT status, taken_by FROM harness_shared.harness_features_consolidated
      WHERE harness_slug = ${H} AND feature_id = 'F-A1'`;
    expect(row).toMatchObject({ status: 'open', taken_by: null });
    expect(await handlerClaim(SWARM_A, 'a')).toBe('F-A1');
  });
});
