/**
 * work-items-stale-claims.integration.test.ts — the dead-holder claim sweep
 * (owner-reported gap 2026-06-11) against real Postgres. Liveness must match
 * the mig-225 alias-aware rule exactly: coord_presence heartbeat OR a
 * RUNNING/RESTARTING spawned_agents row matched on ANY alias.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// These fresh-PG fixtures own claim state; original-row cases assert diagnostics.
// Never let their incidental cleanup observations flush to the operator database.
// Partial mock: only observeFallback is stubbed (so nothing is ever buffered). The
// fresh-PG fixture cleanup (test/_pg-helpers.ts) imports the REAL flush + counters
// and drains into the fixture's own sql, so those exports must stay real.
vi.mock('./degradation/fallback-observations', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  observeFallback: vi.fn(() => true),
}));
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { EVENT_AWAITS_LIVENESS_MIN_DDL, HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';
import { reclaimStaleWorkItemClaims, reclaimStaleIssueClaims, reconcileStrandedWipWorkItems } from './work-items-stale-claims';
import { SESSION_END_MARKER } from './agent-tools/activity/lifecycle-markers';

const PRESENCE_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.coord_presence (
    owner_id text PRIMARY KEY,
    heartbeat_at timestamptz
  )`;
const SPAWNED_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY,
    session_owner text,
    run_id text,
    status text NOT NULL,
    heartbeat_at timestamptz,
    finished_at timestamptz,
    cancelled_at timestamptz
  )`;
const ENGINEER_ISSUES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.engineer_issues (
    workspace_id text NOT NULL DEFAULT 'default',
    issue_id text NOT NULL,
    kind text, scope text, title text, body text, severity text, source text, state text,
    assignee text, assigned_by text, assigned_at timestamptz, payload jsonb,
    found_during text, linked_feature_id text, created_by text, signal_origin text,
    created_at timestamptz, updated_at timestamptz, origin text DEFAULT 'local',
    PRIMARY KEY (workspace_id, issue_id))`;
// EI-18674157526367861: the cross-CLI worker activity bridge sink (migration 143) —
// `activeTurnHolderFragment` reads owner_id/kind/summary/created_at only, so the test
// DDL is a deliberately minimal projection of the real table (id/workspace_id/agent/
// session_id/harness_slug/tool_name/phase/tool_use_id/status/detail/cwd are irrelevant
// to the liveness fragment under test).
const AGENT_ACTIVITY_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.agent_activity (
    id BIGSERIAL PRIMARY KEY,
    owner_id text NOT NULL,
    kind text NOT NULL,
    summary text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
// A deliberately minimal projection of the real tool_invocations table (see
// projected-tool-deps.ts's TELEMETRY_INSERT_SQL for the full column list). The
// stalled regression records an unrelated owner-state goal_ref to show that
// call activity cannot stand in for progress on the held item.
const TOOL_INVOCATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.tool_invocations (
    id BIGSERIAL PRIMARY KEY,
    coord_owner_id text,
    goal_ref text,
    invoked_at timestamptz NOT NULL DEFAULT now()
  )`;
// EI-21431501901242395: the durable continuation leg read by
// liveHolderFragment. Only these four columns participate in that liveness
// decision; this intentionally stays a minimal projection of the real table.
const ROUTINES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.routines (
    id text PRIMARY KEY,
    target_owner_id text,
    reschedule_interval_sec integer,
    active boolean NOT NULL DEFAULT true
  )`;

let db: FreshPgDb;
let sql: postgres.Sql;
const WS = 'default';
const H = 'papercup';

beforeAll(async () => {
  db = await createFreshPgDb();
  sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await sql.unsafe(WORK_ITEM_DEPS_DDL).simple(); // claim path's P-005 readiness clause reads work_item_deps
  await sql.unsafe(PRESENCE_DDL);
  await sql.unsafe(SPAWNED_DDL);
  await sql.unsafe(ENGINEER_ISSUES_DDL);
  await sql.unsafe(AGENT_ACTIVITY_DDL);
  await sql.unsafe(TOOL_INVOCATIONS_DDL);
  await sql.unsafe(ROUTINES_DDL);
  await sql.unsafe(EVENT_AWAITS_LIVENESS_MIN_DDL);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.work_items, harness_shared.coord_presence, harness_shared.spawned_agents, harness_shared.agent_activity, harness_shared.tool_invocations, harness_shared.routines, harness_shared.event_awaits`;
});

async function seedIssue(
  issueId: string,
  kind: string,
  assignee: string | null,
  assignedAgoMin: number,
  state = 'open',
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, kind, scope, title, state, assignee, assigned_by, assigned_at, created_at, updated_at)
    VALUES
      (${WS}, ${issueId}, ${kind}, 'operator', ${issueId}, ${state}, ${assignee},
       ${kind === 'task' ? 'operator' : null},
       ${assignee ? sql`now() - make_interval(mins => ${assignedAgoMin})` : null}, now(), now())`;
}

async function assigneeOf(issueId: string): Promise<string | null> {
  const [row] = await sql<{ assignee: string | null }[]>`
    SELECT assignee FROM harness_shared.engineer_issues WHERE issue_id = ${issueId}`;
  return row?.assignee ?? null;
}

async function seedItem(
  featureId: string,
  takenBy: string | null,
  takenAgoMin: number,
  status = 'todo',
  requeueCount = 0,
  lastProgressAgoMin: number | null = null,
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, item_kind, title, status, requeue_count, taken_by, taken_at, last_progress_at, created_ts, updated_ts)
    VALUES
      (${WS}, ${H}, ${featureId}, 'feature', ${featureId}, ${status}, ${requeueCount}, ${takenBy},
       ${takenBy ? sql`now() - make_interval(mins => ${takenAgoMin})` : null},
       ${lastProgressAgoMin == null ? null : sql`now() - make_interval(mins => ${lastProgressAgoMin})`},
      ${Date.now()}, ${Date.now()})`;
}

async function seedTaskItem(
  featureId: string,
  takenBy: string | null,
  takenAgoMin: number,
  status = 'todo',
  requeueCount = 0,
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, status, requeue_count, taken_by, taken_at, created_ts, updated_ts)
    VALUES
      (${WS}, ${H}, ${featureId}, 'task', ${featureId}, ${status}, ${requeueCount}, ${takenBy},
       ${takenBy ? sql`now() - make_interval(mins => ${takenAgoMin})` : null},
       ${Date.now()}, ${Date.now()})`;
}

/** Seed a spawned_agents row. status defaults to a terminal 'failed'; finishedAgoMin
 *  controls finished_at (recency bound for the spawn-exit leg). */
async function seedSpawn(
  spawnId: string,
  aliases: { sessionOwner?: string; runId?: string } = {},
  status = 'failed',
  finishedAgoMin = 1,
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.spawned_agents (spawn_id, session_owner, run_id, status, heartbeat_at, finished_at)
    VALUES (${spawnId}, ${aliases.sessionOwner ?? spawnId}, ${aliases.runId ?? null}, ${status},
            now() - interval '20 minutes', now() - make_interval(mins => ${finishedAgoMin}))`;
}

/**
 * WI-1999: mark a holder as locally KNOWN but not live — a STALE presence row
 * (heartbeat 1h ago, far past the 10-min grace). The DEAD leg only reaps holders
 * this node has EVER seen (work_items federate, presence does not — a never-seen
 * holder is possibly a live agent on another hive node). Tests that mean
 * "a local bee that died" seed this; tests that mean "never seen here" don't.
 */
async function markKnown(alias: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.coord_presence VALUES (${alias}, now() - interval '1 hour')
    ON CONFLICT (owner_id) DO NOTHING`;
}

/**
 * EI-18674157526367861: seed a `harness_shared.agent_activity` row — the
 * native-CLI-tool-call liveness signal `activeTurnHolderFragment` reads (the SAME
 * source `presence-wakeability.ts`'s `fetchWakeability` uses for its `liveTurn`
 * signal). Defaults to a plain `tool`-kind row (an Edit/Read/Bash call); pass
 * `kind:'lifecycle', summary: SESSION_END_MARKER` for the trailing end-marker case.
 */
async function seedActivity(
  ownerId: string,
  agoMin: number,
  kind = 'tool',
  summary: string | null = 'Edit',
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.agent_activity (owner_id, kind, summary, created_at)
    VALUES (${ownerId}, ${kind}, ${summary}, now() - make_interval(mins => ${agoMin}))`;
}

async function seedLoop(ownerId: string, active = true): Promise<void> {
  await sql`
    INSERT INTO harness_shared.routines (id, target_owner_id, reschedule_interval_sec, active)
    VALUES (${`loop-${ownerId}`}, ${ownerId}, 60, ${active})`;
}

async function statusOf(featureId: string): Promise<{ status: string; requeue_count: number; taken_by: string | null }> {
  const [row] = await sql<{ status: string; requeue_count: number; taken_by: string | null }[]>`
    SELECT status, requeue_count, taken_by
      FROM harness_shared.harness_features_consolidated WHERE feature_id = ${featureId}`;
  return row;
}

async function workItemStatusOf(featureId: string): Promise<{ status: string; requeue_count: number; taken_by: string | null }> {
  const [row] = await sql<{ status: string; requeue_count: number; taken_by: string | null }[]>`
    SELECT status, requeue_count, taken_by
      FROM harness_shared.work_items WHERE feature_id = ${featureId}`;
  return row;
}

describe('reclaimStaleWorkItemClaims', () => {
  it('releases a claim whose holder has a stale presence row and no nursery row (the dead-bee case)', async () => {
    await seedItem('F-001', 'opspawn-dead-123', 30);
    await markKnown('opspawn-dead-123'); // WI-1999: locally KNOWN (stale) — a never-seen holder is skipped
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(1);
    expect(r.released[0]).toMatchObject({
      feature_id: 'F-001',
      former_taken_by: 'opspawn-dead-123',
      former_status: 'todo',
      new_status: 'todo',
      action: 'freed-todo',
    });
    const [row] = await sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.harness_features_consolidated WHERE feature_id = 'F-001'`;
    expect(row.taken_by).toBeNull();
  });

  it('WI-6554700010019271: a plan run assignment to its executor NAME is kept; a dead session on the same run is still freed', async () => {
    // The name is KNOWN and stale, so without the exemption the DEAD leg frees it exactly like F-001.
    await seedItem('F-RUN-NAME', 'bug-triage', 30);
    await seedItem('F-RUN-SESSION', 'opspawn-dead-run', 30);
    await markKnown('bug-triage');
    await markKnown('opspawn-dead-run');
    const payload = { plan_run: { runId: '1356', execution: { agentName: 'bug-triage' } } };
    await sql`
      UPDATE harness_shared.harness_features_consolidated SET payload = ${sql.json(payload)}
       WHERE feature_id IN ('F-RUN-NAME', 'F-RUN-SESSION')`;

    const r = await reclaimStaleWorkItemClaims(sql);

    expect(r.released.map((x) => x.feature_id)).toEqual(['F-RUN-SESSION']);
    expect((await statusOf('F-RUN-NAME')).taken_by).toBe('bug-triage');
  });

  it('EI-18838076935151132: a reaper-released claim is attributed to the REAPER, not the former holder', async () => {
    // Attribution defect #2: before the fix, the reaper never touched
    // last_released_by/at at all, so an involuntary release was indistinguishable
    // from "never released" — no detector could tell it apart from a holder that
    // simply never had its claim released. Assert the reaper now stamps a
    // reaper-prefixed, reason-tagged marker that can never collide with a real
    // ownerId (so the release-cooldown floor in get-next.ts can't misfire against
    // it) and is greppable via `last_released_by LIKE 'reaper:%'`.
    await seedItem('F-901', 'opspawn-dead-901', 30);
    await markKnown('opspawn-dead-901');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(1);
    expect(r.released[0].reason).toBe('dead');
    const [row] = await sql<{ last_released_by: string | null; last_released_at: Date | null }[]>`
      SELECT last_released_by, last_released_at
        FROM harness_shared.work_items WHERE feature_id = 'F-901'`;
    expect(row.last_released_by).toBe('reaper:dead');
    expect(row.last_released_by).not.toBe('opspawn-dead-901');
    expect(row.last_released_at).not.toBeNull();
  });

  it('a holder with a FRESH presence heartbeat is alive — claim kept', async () => {
    await seedItem('F-002', 'su-alive-1', 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-alive-1', now())`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
  });

  it('a holder matching a RUNNING nursery row on ANY alias is alive (mig-225 rule)', async () => {
    // taken_by = the RUN ID alias (the EI-311 degraded-bee case), not the spawn_id.
    await seedItem('F-003', 'opspawn-1786-abc', 30);
    await sql`
      INSERT INTO harness_shared.spawned_agents VALUES
        ('s-xyz', 's-xyz', 'opspawn-1786-abc', 'running', now())`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
  });

  it('a nursery row that is NOT running does not confer liveness — claim released', async () => {
    await seedItem('F-004', 's-finished', 30);
    await sql`
      INSERT INTO harness_shared.spawned_agents VALUES
        ('s-finished', 's-finished', 'opspawn-x', 'failed', now())`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released.map((c) => c.feature_id)).toEqual(['F-004']);
  });

  it('a stale-heartbeat presence row does not confer liveness — claim released', async () => {
    await seedItem('F-005', 'su-stale', 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-stale', now() - interval '1 hour')`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released.map((c) => c.feature_id)).toEqual(['F-005']);
  });

  it('claims inside the grace window are NEVER touched, even with a dead holder', async () => {
    await seedItem('F-006', 'opspawn-justdied', 2); // 2 min < 10 min grace
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
  });

  // EI-2534 (the stranded-orphan class): a dead-holder claim with NO taken_at
  // anchor. The fleet_assignment view flags it `orphaned` off taken_by alone (it
  // requires no taken_at), but the OLD DEAD leg required taken_at IS NOT NULL, so
  // such a row read orphaned forever yet never reaped — 7 P1 items stranded ~3h.
  // A NULL taken_at must count as past grace: the dead-holder signal alone frees it.
  it('a dead-holder claim with NULL taken_at is freed (EI-2534 strand class)', async () => {
    await seedItem('F-014', 'su-dead-noanchor', 30);
    await markKnown('su-dead-noanchor');
    // Strip the claim-time anchor — taken_by stays set (the orphaned-but-no-anchor row).
    await sql`UPDATE harness_shared.harness_features_consolidated
                 SET taken_at = NULL WHERE feature_id = 'F-014'`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(1);
    expect(r.released[0]).toMatchObject({
      feature_id: 'F-014',
      former_taken_by: 'su-dead-noanchor',
      reason: 'dead',
      action: 'freed-todo',
    });
    expect((await statusOf('F-014')).taken_by).toBeNull();
  });

  // EI-6992 (2026-06) had the reaper NEVER touch an issue-family row's status, on the
  // premise that issue-family claimability was orthogonal to status (open/resolved/
  // closed only). WI-6039 (2026-07-26) supersedes this: work-item-status-full-unify
  // made `wip` a real, agent-settable issue-family state, and claimability now
  // requires status='open' specifically — so "never touch status" left a dead
  // holder's `wip` issue-family claim stuck FOREVER (unclaimable + undetectable;
  // confirmed live, 31 rows, one hiding a 6-day canary outage). These tests now
  // assert the CORRECTED behavior: an already-`open` or terminal row is still left
  // alone (nothing to fix there), but a genuinely mid-flight (`wip`) row IS requeued
  // back to `open`, exactly like a feature-family row would be.
  it('releases an orphaned issue-family (task) row that was already `open` — nothing to requeue, status unchanged', async () => {
    await seedTaskItem('WI-TASK-1', 'su-dead-task-holder', 30, 'open');
    await markKnown('su-dead-task-holder');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(1);
    expect(r.released[0]).toMatchObject({
      feature_id: 'WI-TASK-1',
      item_kind: 'task',
      former_status: 'open',
      new_status: 'open',
      former_taken_by: 'su-dead-task-holder',
      reason: 'dead',
      action: 'freed-todo',
    });
    expect(await workItemStatusOf('WI-TASK-1')).toMatchObject({ status: 'open', requeue_count: 0, taken_by: null });
  });

  // WI-6039 (fixes the class EI-6992 accidentally reintroduced): the live incident —
  // a bee claims a bug/change/task (status -> 'wip'), then dies. Before this fix the
  // reaper cleared taken_by but left status='wip' forever: unclaimable (claimability
  // requires status='open') AND undetectable (no holder left for any orphan/stall
  // check to act on). This is the exact shape of EI-18170538694255356, the canary-
  // outage report that itself fell into this hole.
  it('a dead-held issue-family (task) row stuck at `wip` IS requeued back to `open` (the WI-6039 fix)', async () => {
    await seedTaskItem('WI-TASK-WIP-1', 'su-dead-task-holder-wip', 30, 'wip');
    await markKnown('su-dead-task-holder-wip');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(1);
    expect(r.released[0]).toMatchObject({
      feature_id: 'WI-TASK-WIP-1',
      item_kind: 'task',
      former_status: 'wip',
      new_status: 'open',
      reason: 'dead',
      action: 'requeued',
    });
    expect(await workItemStatusOf('WI-TASK-WIP-1')).toMatchObject({ status: 'open', requeue_count: 1, taken_by: null });
  });

  it('a repeatedly-dying issue-family (task) claim dead-letters to `blocked` once the requeue cap is hit — same as feature-family', async () => {
    await seedTaskItem('WI-TASK-WIP-2', 'su-dead-task-holder-wip-2', 30, 'wip', 2);
    await markKnown('su-dead-task-holder-wip-2');
    const r = await reclaimStaleWorkItemClaims(sql, { requeueCap: 3 });
    expect(r.released[0]).toMatchObject({
      feature_id: 'WI-TASK-WIP-2',
      item_kind: 'task',
      former_status: 'wip',
      new_status: 'blocked',
      action: 'dead-lettered',
      requeue_count: 3,
    });
    expect(await workItemStatusOf('WI-TASK-WIP-2')).toMatchObject({ status: 'blocked', requeue_count: 3, taken_by: null });
  });

  it('a dead-held issue-family (task) row that was already `open` keeps requeue_count untouched (nothing to bump)', async () => {
    await seedTaskItem('WI-TASK-2', 'su-dead-task-holder-2', 30, 'open', 2);
    await markKnown('su-dead-task-holder-2');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({
      feature_id: 'WI-TASK-2',
      item_kind: 'task',
      former_status: 'open',
      new_status: 'open',
      action: 'freed-todo',
      requeue_count: 2,
    });
    expect(await workItemStatusOf('WI-TASK-2')).toMatchObject({ status: 'open', requeue_count: 2, taken_by: null });
  });

  it('a terminal (resolved) issue-family (task) row is freed but its status is untouched (never coerced to a feature terminal literal)', async () => {
    await seedTaskItem('WI-TASK-3', 'su-dead-task-holder-3', 30, 'resolved');
    await markKnown('su-dead-task-holder-3');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({
      feature_id: 'WI-TASK-3',
      item_kind: 'task',
      former_status: 'resolved',
      new_status: 'resolved',
      action: 'freed-terminal',
    });
    expect(await workItemStatusOf('WI-TASK-3')).toMatchObject({ status: 'resolved', taken_by: null });
  });

  it('a `blocked` issue-family (change) row is freed but its status is untouched (its own delegator-notify path handles it)', async () => {
    await seedTaskItem('WI-TASK-4', 'su-dead-task-holder-4', 30, 'blocked');
    await markKnown('su-dead-task-holder-4');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({
      feature_id: 'WI-TASK-4',
      item_kind: 'task',
      former_status: 'blocked',
      new_status: 'blocked',
      action: 'freed-blocked',
    });
    expect(await workItemStatusOf('WI-TASK-4')).toMatchObject({ status: 'blocked', taken_by: null });
  });

  it('a mid-flight NULL-taken_at dead-holder claim is requeued → todo (EI-2534)', async () => {
    await seedItem('F-015', 'su-dead-noanchor2', 30, 'in_progress');
    await markKnown('su-dead-noanchor2');
    await sql`UPDATE harness_shared.harness_features_consolidated
                 SET taken_at = NULL WHERE feature_id = 'F-015'`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ feature_id: 'F-015', reason: 'dead', new_status: 'open', action: 'requeued' });
    expect(await statusOf('F-015')).toMatchObject({ status: 'open', taken_by: null });
  });

  it('a NULL-taken_at claim held by a LIVE holder is NOT freed (no anchor must not over-reclaim)', async () => {
    await seedItem('F-016', 'su-alive-noanchor', 30);
    await sql`UPDATE harness_shared.harness_features_consolidated
                 SET taken_at = NULL WHERE feature_id = 'F-016'`;
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-alive-noanchor', now())`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
    expect((await statusOf('F-016')).taken_by).toBe('su-alive-noanchor');
  });

  it('a mid-flight (in_progress) row is REQUEUED → todo and re-enters the pool (GAP 1, P-001)', async () => {
    await seedItem('F-007', 'opspawn-dead-mid', 30, 'in_progress');
    await markKnown('opspawn-dead-mid');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({
      feature_id: 'F-007',
      former_status: 'in_progress',
      new_status: 'open',
      action: 'requeued',
      requeue_count: 1,
    });
    expect(await statusOf('F-007')).toMatchObject({ status: 'open', requeue_count: 1, taken_by: null });
  });

  it('a `validating` row is also requeued (any non-terminal, non-blocked state)', async () => {
    await seedItem('F-007b', 'opspawn-dead-val', 30, 'validating');
    await markKnown('opspawn-dead-val');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ former_status: 'validating', new_status: 'open', action: 'requeued' });
  });

  it('the requeue counter increments each sweep until the cap, then DEAD-LETTERS to blocked (P-002, D-007)', async () => {
    // Seed already at cap-1 (default cap 3 → requeue_count 2): the next reclaim is
    // the 3rd, which exhausts the cap and parks the poison item in `blocked`.
    await seedItem('F-010', 'opspawn-dead-poison', 30, 'in_progress', 2);
    await markKnown('opspawn-dead-poison');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({
      feature_id: 'F-010',
      former_status: 'in_progress',
      new_status: 'blocked',
      action: 'dead-lettered',
      requeue_count: 3,
    });
    expect(await statusOf('F-010')).toMatchObject({ status: 'blocked', requeue_count: 3 });
  });

  it('honors a custom requeueCap option', async () => {
    await seedItem('F-011', 'opspawn-dead-cap1', 30, 'in_progress', 0);
    await markKnown('opspawn-dead-cap1');
    const r = await reclaimStaleWorkItemClaims(sql, { requeueCap: 1 });
    // cap 1 → first reclaim already exhausts it.
    expect(r.released[0]).toMatchObject({ new_status: 'blocked', action: 'dead-lettered', requeue_count: 1 });
  });

  it('a TERMINAL (passed) row is freed but NOT requeued or re-broadcast (the F-FIX-038 fix)', async () => {
    await seedItem('F-012', 'opspawn-dead-done', 30, 'passed', 0);
    await markKnown('opspawn-dead-done');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ former_status: 'passed', new_status: 'passed', action: 'freed-terminal' });
    expect(await statusOf('F-012')).toMatchObject({ status: 'passed', taken_by: null });
  });

  it('a `deprecated` row is freed but kept terminal', async () => {
    await seedItem('F-012b', 'opspawn-dead-dep', 30, 'deprecated', 0);
    await markKnown('opspawn-dead-dep');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ former_status: 'deprecated', new_status: 'deprecated', action: 'freed-terminal' });
  });

  it('a `blocked` row is freed but kept blocked (its own delegator-notify signal path)', async () => {
    await seedItem('F-013', 'opspawn-dead-blk', 30, 'blocked', 1);
    await markKnown('opspawn-dead-blk');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ former_status: 'blocked', new_status: 'blocked', action: 'freed-blocked' });
    // requeue_count untouched for a blocked freed row.
    expect(await statusOf('F-013')).toMatchObject({ status: 'blocked', requeue_count: 1, taken_by: null });
  });

  it('untaken rows are ignored', async () => {
    await seedItem('F-008', null, 0);
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
  });

  it('the freed item is immediately claimable again by a live agent', async () => {
    await seedItem('F-009', 'opspawn-dead-9', 30);
    await markKnown('opspawn-dead-9');
    await reclaimStaleWorkItemClaims(sql);
    const updated = await sql<{ feature_id: string }[]>`
      UPDATE harness_shared.harness_features_consolidated
         SET taken_by = 'opspawn-new-bee', taken_at = now()
       WHERE feature_id = 'F-009' AND (taken_by IS NULL OR taken_by = '')
       RETURNING feature_id`;
    expect(updated).toHaveLength(1);
  });

  // ── agent-activity-liveness-truth P-003/P-007: spawn-death → IMMEDIATE release ──
  // The incident: a gate-fix bee DIED but its claim sat owned ~1h. A confirmed-
  // terminal spawn's claim must free NOW, not after the 10-min grace.
  it('spawn-exit: a confirmed-terminal spawn frees its claim IMMEDIATELY, inside the grace window', async () => {
    // Claimed only 2 min ago (well inside the 10-min grace) — the DEAD leg would NOT
    // touch it — but its spawn is `failed`, so the spawn-exit leg frees it now.
    await seedItem('F-SE1', 'opspawn-dead-bee', 2);
    await seedSpawn('opspawn-dead-bee', {}, 'failed', 1);
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(1);
    // F-SE1 was seeded at the default claimable status ('todo') — the spawn-exit leg FREES the
    // claim in place (clears taken_by), it does NOT requeue, so the status is left unchanged.
    expect(r.released[0]).toMatchObject({ feature_id: 'F-SE1', reason: 'spawn-exit', new_status: 'todo' });
    expect((await statusOf('F-SE1')).taken_by).toBeNull();
  });

  it('spawn-exit: matches on ANY alias (taken_by = the run_id of the terminal spawn)', async () => {
    await seedItem('F-SE2', 'opspawn-1900-run', 1, 'in_progress');
    await seedSpawn('s-bee-x', { sessionOwner: 's-bee-x', runId: 'opspawn-1900-run' }, 'cancelled', 1);
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ feature_id: 'F-SE2', reason: 'spawn-exit', new_status: 'open' });
  });

  it('spawn-exit: bounded to recent — a spawn terminal >1h ago does NOT force-free a within-grace claim', async () => {
    await seedItem('F-SE3', 'opspawn-old-dead', 2); // within grace → DEAD leg won't fire
    await seedSpawn('opspawn-old-dead', {}, 'failed', 90); // finished 90 min ago → outside the 1h bound
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0); // neither leg fires
  });

  // ── agent-activity-liveness-truth P-003/P-007: the STALLED leg (flag-gated) ──
  it('stalled: flag OFF (default) — a LIVE holder with stale progress is NOT freed', async () => {
    await seedItem('F-ST1', 'su-alive-stalled', 30, 'in_progress', 0, 30); // last progress 30 min ago
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-alive-stalled', now())`; // alive
    const r = await reclaimStaleWorkItemClaims(sql); // includeStalled defaults false
    expect(r.released).toHaveLength(0);
    expect((await statusOf('F-ST1')).taken_by).toBe('su-alive-stalled');
  });

  it('stalled: flag ON — a LIVE holder with stale progress IS freed + requeued (reason stalled)', async () => {
    await seedItem('F-ST2', 'su-alive-stalled2', 30, 'in_progress', 0, 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-alive-stalled2', now())`;
    const r = await reclaimStaleWorkItemClaims(sql, { includeStalled: true });
    expect(r.released[0]).toMatchObject({ feature_id: 'F-ST2', reason: 'stalled', new_status: 'open', action: 'requeued' });
    expect((await statusOf('F-ST2')).taken_by).toBeNull();
  });

  it('stalled: flag ON — a LIVE holder making RECENT progress is KEPT (not falsely stalled)', async () => {
    await seedItem('F-ST3', 'su-progressing', 30, 'in_progress', 0, 1); // progressed 1 min ago
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-progressing', now())`;
    const r = await reclaimStaleWorkItemClaims(sql, { includeStalled: true });
    expect(r.released).toHaveLength(0);
  });

  it('stalled: flag ON — a fresh claim with no progress yet gets the grace window (taken_at fallback)', async () => {
    await seedItem('F-ST4', 'su-fresh', 2, 'in_progress', 0, null); // claimed 2 min ago, no progress yet
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-fresh', now())`;
    const r = await reclaimStaleWorkItemClaims(sql, { includeStalled: true });
    expect(r.released).toHaveLength(0); // taken_at is recent → not stalled
  });

  it('EI-18838892159155751: stalled flag keeps a fresh reclaim with retained older progress', async () => {
    await seedItem('F-ST4-RECLAIM', 'su-fresh-reclaim', 2, 'in_progress', 0, 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-fresh-reclaim', now())`;
    const r = await reclaimStaleWorkItemClaims(sql, { includeStalled: true });
    expect(r.released).toHaveLength(0);
    expect((await statusOf('F-ST4-RECLAIM')).taken_by).toBe('su-fresh-reclaim');
  });

  it('stalled: flag ON — improvement-runner (parked routine lane) is EXEMPT', async () => {
    await seedItem('F-ST5', 'improvement-runner', 30, 'in_progress', 0, 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('improvement-runner', now())`;
    const r = await reclaimStaleWorkItemClaims(sql, { includeStalled: true });
    expect(r.released).toHaveLength(0);
  });

  it('stalled honors a custom stalledMs window', async () => {
    await seedItem('F-ST6', 'su-alive-window', 30, 'in_progress', 0, 8); // progress 8 min ago
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-alive-window', now())`;
    // 8-min-old progress is INSIDE the default 10-min window (kept) but OUTSIDE a 5-min window (freed).
    expect((await reclaimStaleWorkItemClaims(sql, { includeStalled: true })).released).toHaveLength(0);
    const r = await reclaimStaleWorkItemClaims(sql, { includeStalled: true, stalledMs: 5 * 60_000 });
    expect(r.released[0]).toMatchObject({ feature_id: 'F-ST6', reason: 'stalled' });
  });

  // Owner activity is not item progress. tool_invocations.goal_ref is a
  // snapshot of the owner's declared goal at call time, not call-local item
  // attribution, and cannot override this item's stale progress timestamp.
  it('stalled: flag ON — a recent tool invocation for another goal does not mask stale item progress', async () => {
    await seedItem('F-ST7', 'su-tool-active', 30, 'in_progress', 0, 30); // claimed + "progressed" 30 min ago
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-tool-active', now())`; // alive
    await sql`INSERT INTO harness_shared.tool_invocations (coord_owner_id, goal_ref, invoked_at)
              VALUES ('su-tool-active', 'WI-OTHER', now() - interval '2 minutes')`;
    const r = await reclaimStaleWorkItemClaims(sql, { includeStalled: true });
    expect(r.released[0]).toMatchObject({ feature_id: 'F-ST7', reason: 'stalled', new_status: 'open' });
    expect((await statusOf('F-ST7')).taken_by).toBeNull();
  });

  it('stalled: flag ON — recent owner agent_activity does not mask stale item progress', async () => {
    await seedItem('F-ST8', 'su-turn-active', 30, 'in_progress', 0, 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-turn-active', now())`;
    await sql`INSERT INTO harness_shared.agent_activity (owner_id, kind, summary, created_at)
              VALUES ('su-turn-active', 'lifecycle', 'turn', now() - make_interval(mins => 2))`;
    const r = await reclaimStaleWorkItemClaims(sql, { includeStalled: true });
    expect(r.released[0]).toMatchObject({ feature_id: 'F-ST8', reason: 'stalled', new_status: 'open' });
    expect((await statusOf('F-ST8')).taken_by).toBeNull();
  });

  it('stalled: flag ON — a holder with NO recent activity of any kind IS still freed (guard does not mask genuine stalls)', async () => {
    await seedItem('F-ST9', 'su-truly-stalled', 30, 'in_progress', 0, 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-truly-stalled', now())`; // alive (heartbeat only)
    // No agent_activity, no tool_invocations rows at all for this holder.
    const r = await reclaimStaleWorkItemClaims(sql, { includeStalled: true });
    expect(r.released[0]).toMatchObject({ feature_id: 'F-ST9', reason: 'stalled' });
  });
});

// WI-2689 (reclaim-churn fix): a holder whose keepalive lapsed but whose coord_presence
// row still beat RECENTLY (within the parked grace, past the short live window) is a
// loop-dropped member about to be re-armed, NOT a dead one. Reaping its claim at the bare
// live grace produced the claim→release→reclaim ping-pong that dominated the dedup/churn
// ratio (WI-2118 reclaimed 3x+). The parked grace holds such a holder back until its beat
// ages past the window — protecting the resumable, still promptly reaping the truly dead.
describe('E3 authenticated human claims', () => {
  const human = 'human:00000000-0000-4000-8000-000000000002';

  it.each(['unknown', 'dead', 'spawn-exit', 'stalled'] as const)(
    'keeps a human claim through the %s agent-reaper leg', async (leg) => {
      await seedItem('F-HUMAN', human, 43_200, 'wip', 0, 43_200);
      if (leg === 'dead') await markKnown(human);
      if (leg === 'spawn-exit') await seedSpawn('human-spawn-alias', { sessionOwner: human });
      if (leg === 'stalled') await sql`INSERT INTO harness_shared.coord_presence VALUES (${human}, now())`;
      await seedItem('F-DEAD-CONTROL', 'su-dead-control', 30, 'wip');
      await markKnown('su-dead-control');
      const result = await reclaimStaleWorkItemClaims(sql, { includeStalled: true });
      expect(result.released.map(row => row.feature_id)).toEqual(['F-DEAD-CONTROL']);
      const [row] = await sql`SELECT taken_by, status, requeue_count FROM harness_shared.work_items
        WHERE feature_id = 'F-HUMAN'`;
      expect(row).toMatchObject({ taken_by: human, status: 'wip', requeue_count: 0 });
    },
  );

  it('also preserves human issue-family claims past the unknown-holder horizon', async () => {
    await seedIssue('EI-HUMAN', 'bug', human, 43_200);
    await seedIssue('EI-DEAD-CONTROL', 'bug', 'su-dead-control', 30);
    await markKnown('su-dead-control');
    const result = await reclaimStaleIssueClaims(sql);
    expect(result.released.map(row => row.issue_id)).toEqual(['EI-DEAD-CONTROL']);
    expect(await assigneeOf('EI-HUMAN')).toBe(human);
  });
});

describe('WI-2689 parked-grace (reclaim-churn fix)', () => {
  it('feature reaper: a holder that BEAT within the parked grace is NOT reaped, even past the live window', async () => {
    await seedItem('F-PK1', 'su-parked-1', 30); // claim 30 min old — past the 10-min live grace
    // Heartbeat 15 min ago: past the 10-min live window (not "alive") but within the 30-min parked window.
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-parked-1', now() - interval '15 minutes')`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
    expect((await statusOf('F-PK1')).taken_by).toBe('su-parked-1');
  });

  it('feature reaper: once the beat ages past the parked grace, the holder IS reaped (bounded, not indefinite)', async () => {
    await seedItem('F-PK2', 'su-parked-2', 40);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-parked-2', now() - interval '45 minutes')`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released.map((c) => c.feature_id)).toEqual(['F-PK2']);
    expect(r.released[0]).toMatchObject({ reason: 'dead' });
  });

  it('feature reaper: a parkedGraceMs override == base grace disables the extra protection (configurable backoff)', async () => {
    await seedItem('F-PK3', 'su-parked-3', 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-parked-3', now() - interval '15 minutes')`;
    // parkedGraceMs 10m == base grace → the 15-min-stale beat is now past it → reaped.
    const r = await reclaimStaleWorkItemClaims(sql, { parkedGraceMs: 10 * 60_000 });
    expect(r.released.map((c) => c.feature_id)).toEqual(['F-PK3']);
  });

  it('feature reaper: parkedGraceMs is clamped to be ≥ graceMs (a parked holder never waits LESS)', async () => {
    await seedItem('F-PK4', 'su-parked-4', 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-parked-4', now() - interval '15 minutes')`;
    // Absurdly small parkedGraceMs (1m) is clamped UP to graceMs (20m); the 15-min beat is
    // inside 20m → still protected. Without the clamp it would (wrongly) reap.
    const r = await reclaimStaleWorkItemClaims(sql, { graceMs: 20 * 60_000, parkedGraceMs: 60_000 });
    expect(r.released).toHaveLength(0);
  });

  it('issue reaper: a recently-parked assignee (beat within parked grace) is NOT reaped', async () => {
    await seedIssue('EI-PK1', 'bug', 'su-parked-issue', 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-parked-issue', now() - interval '15 minutes')`;
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released).toHaveLength(0);
    expect(await assigneeOf('EI-PK1')).toBe('su-parked-issue');
  });

  it('issue reaper: the same assignee is reaped once its beat ages past the parked grace', async () => {
    await seedIssue('EI-PK2', 'change', 'su-parked-issue-2', 40);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-parked-issue-2', now() - interval '45 minutes')`;
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released.map((c) => c.issue_id)).toEqual(['EI-PK2']);
  });
});

describe('reclaimStaleIssueClaims (issue-family reaper, GAP 2 / P-005 / D-009)', () => {
  it('a dead-holder OPEN bug → assignee cleared, returned to the open pool', async () => {
    await seedIssue('EI-1', 'bug', 'opspawn-dead-bug', 30);
    await markKnown('opspawn-dead-bug');
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released).toHaveLength(1);
    expect(r.released[0]).toMatchObject({ issue_id: 'EI-1', kind: 'bug', former_assignee: 'opspawn-dead-bug' });
    expect(await assigneeOf('EI-1')).toBeNull();
  });

  it('EI-18838076935151132: a reaper-released issue claim is attributed to the REAPER, not the former holder', async () => {
    // The engineer_issues VIEW's own INSTEAD OF trigger (mig 499/513) self-stamps
    // last_released_by = OLD.assignee the instant assignee clears — correct for a
    // VOLUNTARY release, but backwards for a reaper-initiated one (the holder never
    // acted). Assert the follow-up base-table UPDATE overrides it to the same
    // reaper-prefixed marker convention as the feature-family leg.
    await seedIssue('EI-901', 'bug', 'opspawn-dead-issue-901', 30);
    await markKnown('opspawn-dead-issue-901');
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released).toHaveLength(1);
    const [row] = await sql<{ last_released_by: string | null; last_released_at: Date | null }[]>`
      SELECT last_released_by, last_released_at
        FROM harness_shared.work_items WHERE feature_id = 'EI-901'`;
    expect(row.last_released_by).toBe('reaper:dead');
    expect(row.last_released_by).not.toBe('opspawn-dead-issue-901');
    expect(row.last_released_at).not.toBeNull();
  });

  it('a dead-holder OPEN change → assignee cleared', async () => {
    await seedIssue('EI-2', 'change', 'opspawn-dead-chg', 30);
    await markKnown('opspawn-dead-chg');
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released.map((c) => c.issue_id)).toEqual(['EI-2']);
    expect(await assigneeOf('EI-2')).toBeNull();
  });

  it('a `task` (delegate) issue is NEVER reaped — a durable conversational binding (D-009)', async () => {
    // Stale assigned_at + a dead holder: a bug here WOULD be reaped, but a task must NOT be.
    await seedIssue('EI-3', 'task', 'delegate:sess-abc', 999);
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released).toHaveLength(0);
    expect(await assigneeOf('EI-3')).toBe('delegate:sess-abc');
  });

  it('resolved / closed issues are untouched even with a dead holder', async () => {
    await seedIssue('EI-4', 'bug', 'opspawn-dead-resolved', 30, 'resolved');
    await seedIssue('EI-5', 'bug', 'opspawn-dead-closed', 30, 'closed');
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released).toHaveLength(0);
    expect(await assigneeOf('EI-4')).toBe('opspawn-dead-resolved');
    expect(await assigneeOf('EI-5')).toBe('opspawn-dead-closed');
  });

  it('alias-aware liveness parity with the feature path: a RUNNING nursery alias keeps the claim', async () => {
    await seedIssue('EI-6', 'bug', 'opspawn-1900-xyz', 30);
    await sql`INSERT INTO harness_shared.spawned_agents VALUES ('s-bee', 's-bee', 'opspawn-1900-xyz', 'running', now())`;
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released).toHaveLength(0);
    expect(await assigneeOf('EI-6')).toBe('opspawn-1900-xyz');
  });

  it('a fresh coord_presence heartbeat keeps the claim; claims inside grace are untouched', async () => {
    await seedIssue('EI-7', 'bug', 'su-alive-issue', 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-alive-issue', now())`;
    await seedIssue('EI-8', 'bug', 'opspawn-justclaimed', 2); // inside 10-min grace
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released).toHaveLength(0);
  });

  it('unassigned open issues are ignored', async () => {
    await seedIssue('EI-9', 'bug', null, 0);
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released).toHaveLength(0);
  });
});

// ── WI-1999: the remote-holder guard (federated items, local-only presence) ──
// The 2026-07-03 incident: work_items rows FEDERATE across the hive but
// coord_presence is LOCAL-BY-DESIGN, so another node's sweep saw every tower
// holder as "not alive" and shredded LIVE claims (WI-1964 dead-lettered 5x while
// actively driven; WI-1910 requeued 5x). The DEAD leg must only reap holders
// this node has EVER seen; a never-seen-here holder skips until the long-horizon
// fallback (anchored on COALESCE(taken_at, updated_ts)) lapses.
describe('WI-1999 remote-holder guard', () => {
  it('a NEVER-seen-here holder is SKIPPED past grace (possibly a live remote agent)', async () => {
    await seedItem('F-RH1', 'su-remote-node-holder', 30, 'in_progress'); // past grace, no local rows
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
    expect((await statusOf('F-RH1')).taken_by).toBe('su-remote-node-holder');
  });

  it('the SAME holder with a stale local presence row (a dead local bee) IS reaped', async () => {
    await seedItem('F-RH2', 'su-known-dead-bee', 30, 'in_progress');
    await markKnown('su-known-dead-bee');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ feature_id: 'F-RH2', reason: 'dead', action: 'requeued' });
  });

  it('a never-seen holder DOES free once the long-horizon fallback lapses (anchored on taken_at)', async () => {
    await seedItem('F-RH3', 'su-remote-abandoned', 30, 'in_progress'); // taken 30 min ago
    // Abandoned: the row has not changed since the claim either (WI-10005136 — a
    // recently-changed row is a federated sign of life, see the tests below).
    await sql`UPDATE harness_shared.work_items SET updated_ts = ${Date.now() - 30 * 60_000}, fed_ts = ${Date.now() - 30 * 60_000} WHERE feature_id = 'F-RH3'`;
    // Fallback shrunk to 15 min → the 30-min-old anchor is past it: truly-abandoned rows still free.
    const r = await reclaimStaleWorkItemClaims(sql, { unknownHolderFallbackMs: 15 * 60_000 });
    expect(r.released[0]).toMatchObject({ feature_id: 'F-RH3', reason: 'dead' });
  });

  // WI-10005136 (2026-10-01): the mac-VM rig reaped a LIVE tower holder's >24h-old
  // claims as 'reaper:dead' (WI-10004353, WI-10004436) — claim age alone is not death.
  // Past the fallback, a never-seen holder is only dead when NO work_items row it holds
  // or terminally owns was claimed or changed within the window (those writes federate).
  it('WI-10005136: a never-seen holder past the fallback that CLAIMED another row recently is KEPT', async () => {
    await seedItem('F-RH5', 'su-remote-live-holder', 30, 'in_progress');
    await sql`UPDATE harness_shared.work_items SET updated_ts = ${Date.now() - 30 * 60_000}, fed_ts = ${Date.now() - 30 * 60_000} WHERE feature_id = 'F-RH5'`;
    await seedItem('F-RH5b', 'su-remote-live-holder', 2, 'in_progress'); // fresh claim, inside grace
    const r = await reclaimStaleWorkItemClaims(sql, { unknownHolderFallbackMs: 15 * 60_000 });
    expect(r.released.map((x) => x.feature_id)).not.toContain('F-RH5');
    expect((await statusOf('F-RH5')).taken_by).toBe('su-remote-live-holder');
  });

  it('WI-10005136: a never-seen holder past the fallback that CLOSED a row recently is KEPT', async () => {
    await seedItem('F-RH6', 'su-remote-closer', 30, 'in_progress');
    await sql`UPDATE harness_shared.work_items SET updated_ts = ${Date.now() - 30 * 60_000}, fed_ts = ${Date.now() - 30 * 60_000} WHERE feature_id = 'F-RH6'`;
    await seedItem('F-RH6b', null, 0, 'done');
    await sql`UPDATE harness_shared.work_items
                 SET terminal_owner = 'su-remote-closer', updated_ts = ${Date.now() - 60_000}, fed_ts = ${Date.now() - 60_000}
               WHERE feature_id = 'F-RH6b'`;
    const r = await reclaimStaleWorkItemClaims(sql, { unknownHolderFallbackMs: 15 * 60_000 });
    expect(r.released.map((x) => x.feature_id)).not.toContain('F-RH6');
    // Control: once that close ages past the window too, the long-held claim frees.
    await sql`UPDATE harness_shared.work_items SET updated_ts = ${Date.now() - 30 * 60_000}, fed_ts = ${Date.now() - 30 * 60_000} WHERE feature_id = 'F-RH6b'`;
    const later = await reclaimStaleWorkItemClaims(sql, { unknownHolderFallbackMs: 15 * 60_000 });
    expect(later.released[0]).toMatchObject({ feature_id: 'F-RH6', reason: 'dead' });
  });

  it('WI-10005136: issue reaper parity — a never-seen assignee with a recently-changed held row is KEPT past the fallback', async () => {
    await seedIssue('EI-RH2', 'bug', 'su-remote-issue-live', 30);
    // The held issue row itself is idle, so only the OTHER row can keep it.
    await sql`UPDATE harness_shared.work_items SET updated_ts = ${Date.now() - 30 * 60_000}, fed_ts = ${Date.now() - 30 * 60_000} WHERE feature_id = 'EI-RH2'`;
    await seedItem('F-RH7', 'su-remote-issue-live', 2, 'in_progress'); // live elsewhere: fresh claim
    const r = await reclaimStaleIssueClaims(sql, { unknownHolderFallbackMs: 15 * 60_000 });
    expect(r.released.map((c) => c.issue_id)).not.toContain('EI-RH2');
    expect(await assigneeOf('EI-RH2')).toBe('su-remote-issue-live');
    // Control: without that other row, the same idle claim frees.
    await sql`DELETE FROM harness_shared.work_items WHERE feature_id = 'F-RH7'`;
    const later = await reclaimStaleIssueClaims(sql, { unknownHolderFallbackMs: 15 * 60_000 });
    expect(later.released.map((c) => c.issue_id)).toContain('EI-RH2');
  });

  // WI-10005928 (2026-10-03): the mac-VM rig freed a PARKED tower holder's claims through
  // this fallback at 08:40:37Z. The holder's newer tower writes had not replicated, so the
  // WI-10005136 sign-of-life check found nothing. Only the node that last wrote the row
  // judges a never-seen holder. The local-origin control in the SAME sweep proves the
  // fallback still fires under identical conditions, so the kept row is not vacuous.
  it('WI-10005928: past the fallback, a never-seen holder on a PEER-WRITTEN (origin=remote) row is KEPT; the local control frees', async () => {
    await seedItem('F-RH8', 'su-peer-parked-holder', 30, 'in_progress');
    await seedItem('F-RH8L', 'su-local-forgotten-holder', 30, 'in_progress');
    const idle = Date.now() - 30 * 60_000;
    await sql`UPDATE harness_shared.work_items SET updated_ts = ${idle}, fed_ts = ${idle} WHERE feature_id = 'F-RH8L'`;
    await sql`UPDATE harness_shared.work_items SET origin = 'remote', updated_ts = ${idle}, fed_ts = ${idle} WHERE feature_id = 'F-RH8'`;
    const r = await reclaimStaleWorkItemClaims(sql, { unknownHolderFallbackMs: 15 * 60_000 });
    const released = r.released.map((x) => x.feature_id);
    expect(released).not.toContain('F-RH8');
    expect((await statusOf('F-RH8')).taken_by).toBe('su-peer-parked-holder');
    expect(r.released.find((x) => x.feature_id === 'F-RH8L')).toMatchObject({ reason: 'dead' });
  });

  it('WI-10005928: issue reaper parity — a never-seen assignee on a PEER-WRITTEN issue row is KEPT past the fallback; the local control frees', async () => {
    await seedIssue('EI-RH3', 'bug', 'su-peer-issue-holder', 30);
    await seedIssue('EI-RH3L', 'bug', 'su-local-issue-forgotten', 30);
    const idle = Date.now() - 30 * 60_000;
    await sql`UPDATE harness_shared.work_items SET updated_ts = ${idle}, fed_ts = ${idle} WHERE feature_id = 'EI-RH3L'`;
    await sql`UPDATE harness_shared.work_items SET origin = 'remote', updated_ts = ${idle}, fed_ts = ${idle} WHERE feature_id = 'EI-RH3'`;
    const r = await reclaimStaleIssueClaims(sql, { unknownHolderFallbackMs: 15 * 60_000 });
    const released = r.released.map((c) => c.issue_id);
    expect(released).not.toContain('EI-RH3');
    expect(await assigneeOf('EI-RH3')).toBe('su-peer-issue-holder');
    expect(released).toContain('EI-RH3L');
  });

  // WI-10005935: updated_ts is bookkeeping (stamp_local_federated_write, WI-10002882).
  // Embedding, settlement and admission rewrites advance it with no holder action, which
  // used to read as "this holder is alive" forever. Only a CONTENT write (fed_ts) counts.
  it('WI-10005935: a bookkeeping-only touch (updated_ts without fed_ts) is NOT a sign of life', async () => {
    const idle = Date.now() - 30 * 60_000;
    await seedItem('F-RH9', 'su-remote-bookkept', 30, 'in_progress');
    await sql`UPDATE harness_shared.work_items SET updated_ts = ${idle}, fed_ts = ${idle} WHERE feature_id = 'F-RH9'`;
    // A local bookkeeping rewrite touches the held row: updated_ts moves, fed_ts does not.
    await sql`UPDATE harness_shared.work_items SET updated_ts = ${Date.now()} WHERE feature_id = 'F-RH9'`;
    const [row] = await sql<{ fed_ts: string }[]>`SELECT fed_ts::text AS fed_ts FROM harness_shared.work_items WHERE feature_id = 'F-RH9'`;
    expect(Number(row?.fed_ts)).toBe(idle); // the fixture really is bookkeeping-only
    const r = await reclaimStaleWorkItemClaims(sql, { unknownHolderFallbackMs: 15 * 60_000 });
    expect(r.released.map((x) => x.feature_id)).toContain('F-RH9');
  });

  it('WI-10005935: a NULL fed_ts plus recent updated_ts on a sibling row is NOT a sign of life', async () => {
    const idle = Date.now() - 30 * 60_000;
    const holder = 'su-remote-bookkept-null-fed-ts';
    await seedItem('F-RH10', holder, 30, 'in_progress');
    await sql`UPDATE harness_shared.work_items
                 SET updated_ts = ${idle}, fed_ts = ${idle}
               WHERE feature_id = 'F-RH10'`;

    // A sibling claim is old too; its recent bookkeeping timestamp must not make
    // this never-seen holder look active when the content clock is absent.
    await seedTaskItem('WI-RH10B', holder, 30, 'wip');
    await sql`UPDATE harness_shared.work_items
                 SET updated_ts = ${idle}, fed_ts = ${idle}
               WHERE feature_id = 'WI-RH10B'`;
    await sql`UPDATE harness_shared.work_items
                 SET updated_ts = ${Date.now()}, fed_ts = NULL
               WHERE feature_id = 'WI-RH10B'`;

    const [sibling] = await sql<{ fed_ts: string | null; updated_ts: string | number }[]>`
      SELECT fed_ts::text AS fed_ts, updated_ts
        FROM harness_shared.work_items WHERE feature_id = 'WI-RH10B'`;
    expect(sibling?.fed_ts).toBeNull();
    expect(Number(sibling?.updated_ts)).toBeGreaterThan(idle);

    const r = await reclaimStaleWorkItemClaims(sql, { unknownHolderFallbackMs: 15 * 60_000 });
    expect(r.released.map((x) => x.feature_id)).toContain('F-RH10');
  });

  it('WI-10005935: issue reaper ignores a sibling bookkeeping touch without fed_ts', async () => {
    const idle = Date.now() - 30 * 60_000;
    const holder = 'su-remote-bookkept-null-fed-ts-issue';
    await seedIssue('EI-RH10', 'bug', holder, 30);
    await sql`UPDATE harness_shared.work_items
                 SET updated_ts = ${idle}, fed_ts = ${idle}
               WHERE feature_id = 'EI-RH10'`;

    await seedTaskItem('WI-RH10B-ISSUE', holder, 30, 'wip');
    await sql`UPDATE harness_shared.work_items
                 SET updated_ts = ${idle}, fed_ts = ${idle}
               WHERE feature_id = 'WI-RH10B-ISSUE'`;
    await sql`UPDATE harness_shared.work_items
                 SET updated_ts = ${Date.now()}, fed_ts = NULL
               WHERE feature_id = 'WI-RH10B-ISSUE'`;

    const r = await reclaimStaleIssueClaims(sql, { unknownHolderFallbackMs: 15 * 60_000 });
    expect(r.released.map((x) => x.issue_id)).toContain('EI-RH10');
  });

  it('a never-seen holder with NULL taken_at anchors the fallback on fed_ts (EI-2534 must not re-strand)', async () => {
    await seedItem('F-RH4', 'su-remote-noanchor', 30, 'in_progress');
    await sql`UPDATE harness_shared.harness_features_consolidated
                 SET taken_at = NULL, updated_ts = ${Date.now() - 30 * 60_000} WHERE feature_id = 'F-RH4'`;
    // WI-10005935: the anchor is the content clock; age it with the row.
    await sql`UPDATE harness_shared.work_items SET fed_ts = ${Date.now() - 30 * 60_000} WHERE feature_id = 'F-RH4'`;
    // Fresh-updated row is skipped…
    expect((await reclaimStaleWorkItemClaims(sql)).released).toHaveLength(0);
    // …but frees once updated_ts is older than the fallback.
    const r = await reclaimStaleWorkItemClaims(sql, { unknownHolderFallbackMs: 15 * 60_000 });
    expect(r.released[0]).toMatchObject({ feature_id: 'F-RH4', reason: 'dead' });
  });

  it('issue reaper parity: a never-seen assignee is SKIPPED, then frees past the fallback', async () => {
    // engineer_issues is not truncated per-test, so assert on EI-RH1 specifically
    // (earlier tests' never-seen assignees legitimately free in the fallback sweep too).
    await seedIssue('EI-RH1', 'bug', 'su-remote-issue-holder', 30);
    expect((await reclaimStaleIssueClaims(sql)).released.map((c) => c.issue_id)).not.toContain('EI-RH1');
    expect(await assigneeOf('EI-RH1')).toBe('su-remote-issue-holder');
    // Abandoned: its own row (engineer_issues is a view over work_items) has not changed
    // since the claim either — WI-10005136 counts a recently-changed held row as life.
    await sql`UPDATE harness_shared.work_items SET updated_ts = ${Date.now() - 30 * 60_000}, fed_ts = ${Date.now() - 30 * 60_000} WHERE feature_id = 'EI-RH1'`;
    const r = await reclaimStaleIssueClaims(sql, { unknownHolderFallbackMs: 15 * 60_000 });
    expect(r.released.map((c) => c.issue_id)).toContain('EI-RH1');
    expect(await assigneeOf('EI-RH1')).toBeNull();
  });
});

// ── EI-18674157526367861: activeTurnHolderFragment (native-CLI-tool liveTurn) ──
// The incident: WI-5837's assignee/taken_at/last_progress_at all went NULL out
// from under an alive, actively-progressing holder whose recent tool-call mix was
// dominated by NATIVE CLI tools (Bash/Read monitoring a detached background run)
// rather than papercusp-su MCP dispatch — so coord_presence.heartbeat_at (the ONLY
// signal the DEAD leg checked pre-fix) went stale while the holder was demonstrably
// still driving its turn. `activeTurnHolderFragment` closes that gap by unioning in
// the SAME agent_activity-derived `liveTurn` signal `presence-wakeability.ts`'s
// `fetchWakeability` already uses for leader-brief/fleet:assignments/coord:presence,
// so a holder those surfaces call alive can never be reaped here as dead.
describe('EI-18674157526367861: activeTurnHolderFragment (native-tool liveTurn liveness)', () => {
  it('fresh-activity-keeps-claim: a holder with recent NATIVE agent_activity but NO coord_presence heartbeat is alive — claim kept', async () => {
    await seedItem('F-AT1', 'su-native-active', 30); // past the 10-min live grace
    // No coord_presence row at all, and no nursery row — only the pre-fix DEAD leg's
    // signals would see this holder as dead. A recent tool-call activity row (no
    // trailing session-end marker) must keep the claim alive regardless.
    await seedActivity('su-native-active', 1, 'tool', 'Edit');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
    expect((await statusOf('F-AT1')).taken_by).toBe('su-native-active');
  });

  it('fresh-activity-keeps-claim: mirrors on the issue-family (bug/change) reaper too', async () => {
    await seedIssue('EI-AT1', 'bug', 'su-native-active-issue', 30);
    await seedActivity('su-native-active-issue', 1, 'tool', 'Read');
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released).toHaveLength(0);
    expect(await assigneeOf('EI-AT1')).toBe('su-native-active-issue');
  });

  it('end-marker-only-still-reaps: a holder whose ONLY recent activity is the trailing session-end marker is NOT live — claim still reclaimed', async () => {
    await seedItem('F-AT2', 'su-ended-marker', 30);
    await markKnown('su-ended-marker'); // no liveTurn ⇒ falls to the ordinary DEAD leg, which requires a known holder
    // The lone recent activity row IS the '■ session ended' lifecycle marker — a
    // cleanly-ended session, exactly the case activeTurnHolderFragment must NOT
    // treat as live (mirrors deriveSessionState's liveTurn computation).
    await seedActivity('su-ended-marker', 1, 'lifecycle', SESSION_END_MARKER);
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(1);
    expect(r.released[0]).toMatchObject({
      feature_id: 'F-AT2',
      former_taken_by: 'su-ended-marker',
      reason: 'dead',
    });
    expect((await statusOf('F-AT2')).taken_by).toBeNull();
  });

  it('activity AFTER the end marker (a new turn started) is live again — claim kept', async () => {
    await seedItem('F-AT3', 'su-resumed', 30);
    await seedActivity('su-resumed', 5, 'lifecycle', SESSION_END_MARKER); // ended 5 min ago
    await seedActivity('su-resumed', 1, 'tool', 'Bash'); // then a new turn started 1 min ago
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
    expect((await statusOf('F-AT3')).taken_by).toBe('su-resumed');
  });

  it('agent_activity outside the grace window does not confer liveness — claim released', async () => {
    await seedItem('F-AT4', 'su-stale-activity', 30);
    await markKnown('su-stale-activity');
    await seedActivity('su-stale-activity', 45, 'tool', 'Edit'); // 45 min ago — outside the 10-min window
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released.map((c) => c.feature_id)).toEqual(['F-AT4']);
  });
});

describe('EI-21431501901242395: armed-loop owner liveness between warm wakes', () => {
  it('keeps feature + issue claims while the loop is active, then restores terminal reclaim when it is inactive', async () => {
    const owner = 'su-warm-loop-between-wakes';
    await seedItem('F-WARM-LOOP', owner, 45);
    await seedIssue('EI-WARM-LOOP', 'bug', owner, 45);
    await markKnown(owner);
    // A trailing end marker intentionally defeats activeTurnHolderFragment, so
    // the armed routine is the ONLY live-holder leg protecting these claims.
    await seedActivity(owner, 1, 'lifecycle', SESSION_END_MARKER);
    await seedLoop(owner);

    expect((await reclaimStaleWorkItemClaims(sql)).released.map((r) => r.feature_id)).not.toContain('F-WARM-LOOP');
    expect((await reclaimStaleIssueClaims(sql)).released.map((r) => r.issue_id)).not.toContain('EI-WARM-LOOP');
    expect((await statusOf('F-WARM-LOOP')).taken_by).toBe(owner);
    expect(await assigneeOf('EI-WARM-LOOP')).toBe(owner);

    await sql`UPDATE harness_shared.routines SET active = false WHERE target_owner_id = ${owner}`;

    // Run the issue-specific reaper first: the unified work-item reaper also
    // sees issue-family rows and would otherwise release EI-WARM-LOOP before
    // this assertion could observe the issue reaper's own terminal control.
    expect((await reclaimStaleIssueClaims(sql)).released.map((r) => r.issue_id)).toContain('EI-WARM-LOOP');
    expect((await reclaimStaleWorkItemClaims(sql)).released.map((r) => r.feature_id)).toContain('F-WARM-LOOP');
  });
});

describe('WI-6039 — reconcileStrandedWipWorkItems (the general already-stranded-wip backstop)', () => {
  it('reopens a wip row with taken_by NULL back to open', async () => {
    await seedTaskItem('WI-STRAND-1', null, 0, 'wip');
    const rows = await reconcileStrandedWipWorkItems(sql);
    expect(rows.map((r) => r.feature_id)).toContain('WI-STRAND-1');
    expect(await workItemStatusOf('WI-STRAND-1')).toMatchObject({ status: 'open' });
  });

  it('reopens a wip row with taken_by the empty string too', async () => {
    await seedTaskItem('WI-STRAND-2', null, 0, 'wip');
    await sql`UPDATE harness_shared.work_items SET taken_by = '' WHERE feature_id = 'WI-STRAND-2'`;
    const rows = await reconcileStrandedWipWorkItems(sql);
    expect(rows.map((r) => r.feature_id)).toContain('WI-STRAND-2');
  });

  it('does NOT touch a wip row that DOES have a holder — that is reclaimStaleWorkItemClaims\'s job, not this one', async () => {
    await seedTaskItem('WI-STRAND-3', 'su-live-holder', 1, 'wip');
    await markKnown('su-live-holder');
    const rows = await reconcileStrandedWipWorkItems(sql);
    expect(rows.map((r) => r.feature_id)).not.toContain('WI-STRAND-3');
    expect(await workItemStatusOf('WI-STRAND-3')).toMatchObject({ status: 'wip', taken_by: 'su-live-holder' });
  });

  it('does NOT touch a non-wip row (open/blocked/terminal all left alone)', async () => {
    await seedTaskItem('WI-STRAND-4', null, 0, 'open');
    await seedTaskItem('WI-STRAND-5', null, 0, 'blocked');
    await seedTaskItem('WI-STRAND-6', null, 0, 'done');
    const rows = await reconcileStrandedWipWorkItems(sql);
    const ids = rows.map((r) => r.feature_id);
    expect(ids).not.toContain('WI-STRAND-4');
    expect(ids).not.toContain('WI-STRAND-5');
    expect(ids).not.toContain('WI-STRAND-6');
  });

  it('is idempotent — a second run finds nothing left to fix', async () => {
    await seedTaskItem('WI-STRAND-7', null, 0, 'wip');
    await reconcileStrandedWipWorkItems(sql);
    const second = await reconcileStrandedWipWorkItems(sql);
    expect(second.map((r) => r.feature_id)).not.toContain('WI-STRAND-7');
  });

  it('is a no-op (empty array, no throw) when nothing is stranded', async () => {
    const rows = await reconcileStrandedWipWorkItems(sql);
    expect(rows).toEqual([]);
  });
});

// WI-6554700010029295 recurrence guard: a holder whose PROCESS still heartbeats
// but whose agent stopped taking turns (the oracle's warm-dead: no activity past
// ACTIVITY_DEAD_MS = 6h, no armed loop) must not keep its claims forever. Before
// the fix both reapers treated the fresh coord_presence beat alone as proof of
// life, so loop-dead fleet members held claims for ~40h.
describe('WI-6554700010029295: warm-dead holders (heartbeat fresh, no turn past ACTIVITY_DEAD_MS)', () => {
  async function beatNow(ownerId: string): Promise<void> {
    await sql`
      INSERT INTO harness_shared.coord_presence VALUES (${ownerId}, now() - interval '30 seconds')
      ON CONFLICT (owner_id) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`;
  }
  async function seedToolCall(ownerId: string, agoMin: number): Promise<void> {
    await sql`
      INSERT INTO harness_shared.tool_invocations (coord_owner_id, invoked_at)
      VALUES (${ownerId}, now() - make_interval(mins => ${agoMin}))`;
  }

  it('releases feature + issue claims of a heartbeat-fresh owner whose last turn is 7h old', async () => {
    const owner = 'su-warm-dead-member';
    await seedItem('F-WARM-DEAD', owner, 8 * 60);
    await seedIssue('EI-WARM-DEAD', 'bug', owner, 8 * 60);
    await beatNow(owner);
    await seedActivity(owner, 7 * 60, 'lifecycle', '▶ session started');

    const issues = await reclaimStaleIssueClaims(sql);
    expect(issues.released.map((r) => r.issue_id)).toContain('EI-WARM-DEAD');
    const features = await reclaimStaleWorkItemClaims(sql);
    const rel = features.released.find((r) => r.feature_id === 'F-WARM-DEAD');
    expect(rel?.reason).toBe('dead');
    expect((await statusOf('F-WARM-DEAD')).taken_by).toBeNull();
  });

  it('keeps the claim when the same owner took a turn inside the dead ceiling (2h ago)', async () => {
    const owner = 'su-warm-idle-member';
    await seedItem('F-WARM-IDLE', owner, 8 * 60);
    await beatNow(owner);
    await seedActivity(owner, 7 * 60, 'lifecycle', '▶ session started');
    await seedActivity(owner, 2 * 60, 'tool', 'Edit');

    expect((await reclaimStaleWorkItemClaims(sql)).released.map((r) => r.feature_id)).not.toContain('F-WARM-IDLE');
    expect((await statusOf('F-WARM-IDLE')).taken_by).toBe(owner);
  });

  it('counts owner-attributed tool calls as turns (a Codex holder with no fresh activity row)', async () => {
    const owner = 'codex-warm-tool-calls';
    await seedItem('F-WARM-CODEX', owner, 8 * 60);
    await beatNow(owner);
    await seedActivity(owner, 7 * 60, 'lifecycle', '▶ session started');
    await seedToolCall(owner, 10);

    expect((await reclaimStaleWorkItemClaims(sql)).released.map((r) => r.feature_id)).not.toContain('F-WARM-CODEX');
    expect((await statusOf('F-WARM-CODEX')).taken_by).toBe(owner);
  });

  it('is conservative on missing data: a heartbeat-fresh owner with NO activity in the lookback keeps its claim', async () => {
    const owner = 'su-no-activity-evidence';
    await seedItem('F-WARM-NODATA', owner, 8 * 60);
    await beatNow(owner);

    expect((await reclaimStaleWorkItemClaims(sql)).released.map((r) => r.feature_id)).not.toContain('F-WARM-NODATA');
    expect((await statusOf('F-WARM-NODATA')).taken_by).toBe(owner);
  });

  it('an armed engine loop still protects a warm-dead owner (continuation authority, EI-21431501901242395)', async () => {
    const owner = 'su-warm-dead-looped';
    await seedItem('F-WARM-LOOPED', owner, 8 * 60);
    await beatNow(owner);
    await seedActivity(owner, 7 * 60, 'tool', 'Edit');
    await seedLoop(owner);

    expect((await reclaimStaleWorkItemClaims(sql)).released.map((r) => r.feature_id)).not.toContain('F-WARM-LOOPED');
    expect((await statusOf('F-WARM-LOOPED')).taken_by).toBe(owner);
  });

  // EI-27232210222510304 recurrence guard: su-24b08564 held WI-6554700010025562,
  // parked on a bounded task:terminal wake await while a multi-hour release cut
  // ran, and the warm-dead leg freed the claim 6h after its last turn — so
  // release:cut op:run then refused the item id. A bounded wake await is the
  // same continuation authority as an armed loop.
  async function seedAwait(
    ownerId: string,
    opts: { eventKey?: string; expiresInMin?: number | null; timeoutBehavior?: string; note?: string | null } = {},
  ): Promise<void> {
    const { eventKey = 'task:terminal:0mvexample', expiresInMin = 60, timeoutBehavior = 'wake', note = null } = opts;
    await sql`
      INSERT INTO harness_shared.event_awaits (subscriber_id, event_key, policy, note, timeout_behavior, expires_ts)
      VALUES (${ownerId}, ${eventKey}, 'wake', ${note}, ${timeoutBehavior},
              ${expiresInMin === null ? null : sql`now() + make_interval(mins => ${expiresInMin})`})`;
  }

  it('a bounded, unfired wake await protects a warm-dead owner (parked on a long job)', async () => {
    const owner = 'su-warm-dead-awaiting';
    await seedItem('F-WARM-AWAIT', owner, 8 * 60);
    await seedIssue('EI-WARM-AWAIT', 'bug', owner, 8 * 60);
    await beatNow(owner);
    await seedActivity(owner, 7 * 60, 'tool', 'Edit');
    await seedAwait(owner);

    expect((await reclaimStaleIssueClaims(sql)).released.map((r) => r.issue_id)).not.toContain('EI-WARM-AWAIT');
    expect((await reclaimStaleWorkItemClaims(sql)).released.map((r) => r.feature_id)).not.toContain('F-WARM-AWAIT');
    expect((await statusOf('F-WARM-AWAIT')).taken_by).toBe(owner);
  });

  it.each([
    ['an expired await (deadline passed, no turn followed)', { expiresInMin: -5 }],
    ['a deadline-less await (could shield a wedged owner forever)', { expiresInMin: null }],
    ['an await whose timeout lapses silently instead of waking', { timeoutBehavior: 'expire' }],
    ['only the always-armed inbox-wake keepalive', { eventKey: 'coord:inbox-wake:su-warm-dead-not-parked' }],
  ])('still reaps a warm-dead owner holding %s', async (_label, opts) => {
    const owner = 'su-warm-dead-not-parked';
    await seedItem('F-WARM-NOT-PARKED', owner, 8 * 60);
    await beatNow(owner);
    await seedActivity(owner, 7 * 60, 'tool', 'Edit');
    await seedAwait(owner, opts);

    expect((await reclaimStaleWorkItemClaims(sql)).released.map((r) => r.feature_id)).toContain('F-WARM-NOT-PARKED');
    expect((await statusOf('F-WARM-NOT-PARKED')).taken_by).toBeNull();
  });

  it('a deliberate coord:await-inbox park on the inbox-wake key does protect the owner', async () => {
    const owner = 'su-warm-dead-inbox-park';
    await seedItem('F-WARM-INBOX-PARK', owner, 8 * 60);
    await beatNow(owner);
    await seedActivity(owner, 7 * 60, 'tool', 'Edit');
    await seedAwait(owner, {
      eventKey: `coord:inbox-wake:${owner}`,
      note: '[coord:await-inbox:explicit-park] waiting on leader reply',
    });

    expect((await reclaimStaleWorkItemClaims(sql)).released.map((r) => r.feature_id)).not.toContain('F-WARM-INBOX-PARK');
    expect((await statusOf('F-WARM-INBOX-PARK')).taken_by).toBe(owner);
  });
});
