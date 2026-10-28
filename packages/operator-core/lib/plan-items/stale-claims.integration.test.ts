/**
 * stale-claims.integration.test.ts — EI-179 plan-item lease GC.
 *
 * Exercises `reclaimExpiredPlanItemClaims` against a real Postgres: a lapsed
 * claim whose holder is gone is deleted; a non-expired claim, a within-grace
 * lapse, and a lapsed claim whose holder is still alive (fresh coord_presence
 * OR a running nursery alias) are all left untouched.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { EVENT_AWAITS_LIVENESS_MIN_DDL } from '../../test/_work-items-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { reclaimExpiredPlanItemClaims } = await import('./stale-claims');
const claims = await import('./claims');

const WS = 'ws-stale-plan-claims';
const HARNESS = 'papercup';
const PLAN = 'demo-plan';
const GRACE = 10 * 60 * 1000; // 10 min

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('stale-plan-claims');
  h.sql = db.sql;
  await db.sql`CREATE SCHEMA IF NOT EXISTS harness_shared`;
  await db.sql.unsafe(readMigration('141-plan-item-claims.sql')).simple();
  // 143 (agent_activity) rides along because the EI-8997 steal-guard/renewal SQL in
  // claims.ts's acquireClaimLocal (called by this file's claim()/lapse() helpers)
  // joins it for the holder-activity grace check inside the INSERT's ON CONFLICT
  // clause — a missing table there fails the WHOLE statement at plan time, even on
  // a plain non-conflicting insert. Without it every claim() call here throws
  // "relation harness_shared.agent_activity does not exist" (EI-9502: same class of
  // fixture gap already fixed in claim-discipline.integration.test.ts for EI-9509;
  // this sibling fixture was never updated when the EI-8997 dependency landed).
  await db.sql.unsafe(readMigration('143-agent-activity.sql')).simple();
  // Minimal stubs for the liveness join — the real tables live in 000-baseline;
  // only the columns the live_holder CTE reads are needed here.
  await db.sql`CREATE TABLE IF NOT EXISTS harness_shared.coord_presence (
    owner_id text NOT NULL,
    heartbeat_at timestamptz DEFAULT now() NOT NULL )`;
  await db.sql`CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text, session_owner text, run_id text, status text, heartbeat_at timestamptz )`;
  // WI-6554700010029302: the warm-dead subtraction (warmDeadHolderFragment) also reads
  // tool_invocations and routines; stub only the columns it reads.
  await db.sql`CREATE TABLE IF NOT EXISTS harness_shared.tool_invocations (
    coord_owner_id text, invoked_at timestamptz NOT NULL DEFAULT now() )`;
  await db.sql`CREATE TABLE IF NOT EXISTS harness_shared.routines (
    active boolean NOT NULL DEFAULT true, reschedule_interval_sec integer, target_owner_id text )`;
  // EI-27232210222510304: the warm-dead subtraction also reads event_awaits.
  await db.sql.unsafe(EVENT_AWAITS_LIVENESS_MIN_DDL);
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.plan_item_claims`;
  await db.sql`TRUNCATE harness_shared.coord_presence`;
  await db.sql`TRUNCATE harness_shared.spawned_agents`;
  await db.sql`TRUNCATE harness_shared.agent_activity`;
  await db.sql`TRUNCATE harness_shared.tool_invocations`;
  await db.sql`TRUNCATE harness_shared.routines`;
});

async function claim(itemId: string, owner: string): Promise<void> {
  const r = await claims.acquireClaimLocal({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId, owner });
  expect(r.ok).toBe(true);
}
/** Force a claim's lease to have lapsed `secsAgo` seconds ago. */
async function lapse(itemId: string, secsAgo: number): Promise<void> {
  await db.sql`UPDATE harness_shared.plan_item_claims
                  SET expires_ts = clock_timestamp() - make_interval(secs => ${secsAgo})
                WHERE item_id = ${itemId}`;
}
async function present(itemId: string): Promise<boolean> {
  const r = await db.sql`SELECT 1 FROM harness_shared.plan_item_claims WHERE item_id = ${itemId}`;
  return r.length > 0;
}

describe('reclaimExpiredPlanItemClaims (EI-179 plan-item lease GC)', () => {
  it('reaps a long-lapsed claim whose holder has no live presence', async () => {
    await claim('P-001', 'dead-sess');
    await lapse('P-001', 4000); // ~67 min lapsed > grace
    const r = await reclaimExpiredPlanItemClaims(db.sql, { graceMs: GRACE });
    expect(r.released.map((x) => x.item_id)).toEqual(['P-001']);
    expect(r.released[0]!.former_owner).toBe('dead-sess');
    expect(r.released[0]!.lapsed_secs).toBeGreaterThan(GRACE / 1000);
    expect(await present('P-001')).toBe(false);
  });

  it('does NOT reap a non-expired (live-lease) claim', async () => {
    await claim('P-002', 'live-sess');
    const r = await reclaimExpiredPlanItemClaims(db.sql, { graceMs: GRACE });
    expect(r.released).toEqual([]);
    expect(await present('P-002')).toBe(true);
  });

  it('does NOT reap a claim lapsed within the grace window', async () => {
    await claim('P-003', 'recent-sess');
    await lapse('P-003', 60); // 1 min lapsed < 10 min grace
    const r = await reclaimExpiredPlanItemClaims(db.sql, { graceMs: GRACE });
    expect(r.released).toEqual([]);
    expect(await present('P-003')).toBe(true);
  });

  it('does NOT reap a long-lapsed claim whose holder has FRESH coord_presence (alive mid-long-turn)', async () => {
    await claim('P-004', 'busy-sess');
    await lapse('P-004', 4000);
    await db.sql`INSERT INTO harness_shared.coord_presence (owner_id, heartbeat_at) VALUES ('busy-sess', now())`;
    const r = await reclaimExpiredPlanItemClaims(db.sql, { graceMs: GRACE });
    expect(r.released).toEqual([]);
    expect(await present('P-004')).toBe(true);
  });

  it('does NOT reap a claim whose holder matches a RUNNING nursery alias', async () => {
    await claim('P-005', 'spawn-xyz');
    await lapse('P-005', 4000);
    await db.sql`INSERT INTO harness_shared.spawned_agents (spawn_id, session_owner, run_id, status, heartbeat_at)
                 VALUES ('spawn-xyz', 'sess-owner', 'run-1', 'running', now())`;
    const r = await reclaimExpiredPlanItemClaims(db.sql, { graceMs: GRACE });
    expect(r.released).toEqual([]);
    expect(await present('P-005')).toBe(true);
  });

  it('does NOT count a STALE nursery row as alive (dead spawn, old heartbeat)', async () => {
    await claim('P-006', 'spawn-old');
    await lapse('P-006', 4000);
    await db.sql`INSERT INTO harness_shared.spawned_agents (spawn_id, session_owner, run_id, status, heartbeat_at)
                 VALUES ('spawn-old', 'o', 'r', 'running', now() - interval '2 hours')`;
    const r = await reclaimExpiredPlanItemClaims(db.sql, { graceMs: GRACE });
    expect(r.released.map((x) => x.item_id)).toEqual(['P-006']);
    expect(await present('P-006')).toBe(false);
  });

  it('reaps several dead-holder claims in one sweep, leaving the live one', async () => {
    for (const id of ['P-010', 'P-011', 'P-012']) {
      await claim(id, `dead-${id}`);
      await lapse(id, 4000);
    }
    await claim('P-013', 'alive');
    await lapse('P-013', 4000);
    await db.sql`INSERT INTO harness_shared.coord_presence (owner_id, heartbeat_at) VALUES ('alive', now())`;
    const r = await reclaimExpiredPlanItemClaims(db.sql, { graceMs: GRACE });
    expect(r.released.map((x) => x.item_id).sort()).toEqual(['P-010', 'P-011', 'P-012']);
    expect(await present('P-013')).toBe(true);
  });

  it('can target exactly one stale claim without sweeping its siblings', async () => {
    for (const id of ['P-020', 'P-021']) {
      await claim(id, `dead-${id}`);
      await lapse(id, 4000);
    }
    const r = await reclaimExpiredPlanItemClaims(db.sql, {
      graceMs: GRACE,
      key: { workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-020' },
    });
    expect(r.released.map((x) => x.item_id)).toEqual(['P-020']);
    expect(await present('P-020')).toBe(false);
    expect(await present('P-021')).toBe(true);
  });
});

// WI-6554700010029302 recurrence guard: a holder whose PROCESS still heartbeats but
// whose agent took no turn past ACTIVITY_DEAD_MS (6h) and has no armed loop is the
// oracle's warm-dead. The plan-item claim reaper must treat it as gone, exactly like
// the work-item reaper (WI-6554700010029295). Before the fix the fresh beat alone
// kept such a claim held indefinitely after its lease lapsed.
describe('WI-6554700010029302: warm-dead plan-claim holders', () => {
  async function beatNow(owner: string): Promise<void> {
    await db.sql`INSERT INTO harness_shared.coord_presence (owner_id, heartbeat_at)
                 VALUES (${owner}, now() - interval '30 seconds')`;
  }
  async function activityAgo(owner: string, agoMin: number): Promise<void> {
    await db.sql`INSERT INTO harness_shared.agent_activity (owner_id, kind, created_at)
                 VALUES (${owner}, 'tool', now() - make_interval(mins => ${agoMin}))`;
  }
  async function toolCallAgo(owner: string, agoMin: number): Promise<void> {
    await db.sql`INSERT INTO harness_shared.tool_invocations (coord_owner_id, invoked_at)
                 VALUES (${owner}, now() - make_interval(mins => ${agoMin}))`;
  }

  it('reaps a lapsed claim whose holder heartbeats but took no turn for 7h', async () => {
    await claim('P-WD1', 'su-warm-dead');
    await lapse('P-WD1', 4000);
    await beatNow('su-warm-dead');
    await activityAgo('su-warm-dead', 7 * 60);
    const r = await reclaimExpiredPlanItemClaims(db.sql, { graceMs: GRACE });
    expect(r.released.map((x) => x.item_id)).toEqual(['P-WD1']);
    expect(r.released[0]!.former_owner).toBe('su-warm-dead');
    expect(await present('P-WD1')).toBe(false);
  });

  it('keeps a lapsed claim whose heartbeat-fresh holder took a turn within 6h', async () => {
    await claim('P-WD2', 'su-working');
    await lapse('P-WD2', 4000);
    await beatNow('su-working');
    await activityAgo('su-working', 30);
    const r = await reclaimExpiredPlanItemClaims(db.sql, { graceMs: GRACE });
    expect(r.released).toEqual([]);
    expect(await present('P-WD2')).toBe(true);
  });

  it('keeps it when the only recent evidence is a tool call (holder with no fresh activity row)', async () => {
    await claim('P-WD3', 'codex-tool-calls');
    await lapse('P-WD3', 4000);
    await beatNow('codex-tool-calls');
    await activityAgo('codex-tool-calls', 7 * 60);
    await toolCallAgo('codex-tool-calls', 10);
    const r = await reclaimExpiredPlanItemClaims(db.sql, { graceMs: GRACE });
    expect(r.released).toEqual([]);
    expect(await present('P-WD3')).toBe(true);
  });

  it('keeps it for an armed-loop owner between warm wakes', async () => {
    await claim('P-WD4', 'su-looped');
    await lapse('P-WD4', 4000);
    await beatNow('su-looped');
    await activityAgo('su-looped', 7 * 60);
    await db.sql`INSERT INTO harness_shared.routines (active, reschedule_interval_sec, target_owner_id)
                 VALUES (true, 3600, 'su-looped')`;
    const r = await reclaimExpiredPlanItemClaims(db.sql, { graceMs: GRACE });
    expect(r.released).toEqual([]);
    expect(await present('P-WD4')).toBe(true);
  });

  it('is conservative on missing data: a heartbeat-fresh holder with NO activity in the lookback keeps its claim', async () => {
    await claim('P-WD5', 'su-no-evidence');
    await lapse('P-WD5', 4000);
    await beatNow('su-no-evidence');
    const r = await reclaimExpiredPlanItemClaims(db.sql, { graceMs: GRACE });
    expect(r.released).toEqual([]);
    expect(await present('P-WD5')).toBe(true);
  });
});
