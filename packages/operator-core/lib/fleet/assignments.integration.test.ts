/**
 * assignments.integration.test.ts — the harness_shared.fleet_assignment view +
 * listFleetAssignments reader + the fleet_assignment NOTIFY change-feed against
 * REAL Postgres (state-not-chat-fleet-state-2026-06-05, P-001/P-002/P-005/P-006).
 *
 * Uses the baseline-schema DB (the full migration set incl. 165), through the
 * modules' OWN getOrgPg()/getHarnessAdminUrl() handles via the coord fixture.
 *
 * The two load-bearing invariants:
 *   1. CLAIM-PRIMARY (D-002): a live lease whose holder has no/stale presence
 *      surfaces as orphaned=true — never silently dropped.
 *   2. Change-feed precision (D-003): meaningful changes notify; heartbeat-only
 *      presence bumps and lease renewals do NOT (they'd fire per tool call).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../_baseline-coord-fixture';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { listFleetAssignments, groupByAgent, orphanedClaims } from './assignments';
import { recordedLiveOwnerIds } from '../adv-sessions';
import { reorderWorkItem } from '../work-items';
import { DEFAULT_WORKSPACE_ID } from '../workspace-id-constant';
import { onFleetAssignmentChange, _stopForTests, type FleetAssignmentChange } from '../fleet-assignment-bus';

// getWorkItem (used by reorderWorkItem) scopes its feature lookup by activeWorkspaceId()
// (F-B3 workspace-data-isolation-leaks). Every row here is seeded under WS, but
// nothing in this isolated test sets the process-global active workspace — so the lookup
// filtered the wrong workspace and an existing-but-unassigned row read as 'not found'
// (intermittently, on whatever global state a sibling test leaked into the worker). Pin
// the active workspace to the seed workspace so the lookup sees the seeded rows.
//
// EI-18683737202696167: WS is deliberately NOT 'default' (nor listFleetAssignments'
// other always-included bucket, GLOBAL_WORKSPACE='*'). listFleetAssignments's workspace
// filter is `(workspace_id = opts.workspaceId OR workspace_id = '*' OR workspace_id =
// 'default')` by design (EI-295, for plan-store-default-scoped claims) — so ANY row
// seeded under workspace_id='default' by ANY OTHER concurrent consumer of the shared
// baseline-coord fixture (e.g. stalled-claim-collector.integration.test.ts, which used to
// share this exact 'default' id) is ALWAYS pulled into this file's own listFleetAssignments
// reads, regardless of any mutex/serialization between the two files. A unique WS
// separates this suite's ordinary rows; a caller-owned migrated DB below also
// isolates the default/global buckets the reader must include.
vi.mock('../workspace-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace-registry')>();
  return { ...actual, activeWorkspaceId: () => 'fa-assign-test-ws' };
});

let fx: BaselineCoordFixture;
let admin: postgres.Sql;
let isolatedDb: OrgTestDb;

const WS = 'fa-assign-test-ws';

// EI-18683737202696167: scoped DELETEs (by WS), never a blunt TRUNCATE of these
// globally-shared tables — a TRUNCATE wipes every row from every OTHER concurrent
// consumer of the same fixture (any file, any fleet agent, any moment), not just this
// file's own seed. Scoping by workspace_id makes this file's cleanup structurally
// incapable of touching another file's rows, independent of the fixture mutex's timing.
async function truncateAll(): Promise<void> {
  await admin`DELETE FROM harness_shared.coord_presence WHERE workspace_id = ${WS}`;
  await admin`DELETE FROM harness_shared.plan_item_claims WHERE workspace_id = ${WS}`;
  await admin`DELETE FROM harness_shared.plan_item_assignments WHERE workspace_id = ${WS}`;
  await admin`DELETE FROM harness_shared.harness_features_consolidated WHERE feature_id LIKE 'FA-TEST-%'`;
  await admin`DELETE FROM harness_shared.engineer_issues WHERE issue_id LIKE 'FA-TEST-%'`;
  await admin`DELETE FROM harness_shared.spawned_agents WHERE spawn_id LIKE 'fa-test-%'`;
  // EI-18690480039212432: this literal owner id is unique to the workspace-mismatch
  // regression test below — its whole point is a membership fact recorded under WS
  // while its claim lives under a DIFFERENT workspace_id, so it can't be scoped by WS
  // alone like the rest of this cleanup.
  await admin`DELETE FROM harness_shared.fleet_membership_events WHERE owner_id = 'fa-test-ws-mismatch'`;
  // Same reasoning applies to the CLAIM itself: seedPlanClaim(owner, { workspaceId:
  // DEFAULT_WORKSPACE_ID }) below deliberately inserts under DEFAULT_WORKSPACE_ID, not
  // WS, so the `workspace_id = WS` DELETE above never touches it. Without this line the
  // row survives every beforeEach/afterAll, leaking into every OTHER test's WS-scoped
  // read (listFleetAssignments intentionally surfaces plan-store-scoped rows alongside
  // WS ones — that's the bug this test exists to cover) and colliding with itself as a
  // duplicate-key error on the very next run (plan_item_claims_pkey is keyed on
  // workspace_id+harness_slug+plan_slug+item_id, all four of which repeat verbatim).
  // Self-caught 2026-07-26 re-verifying EI-18690480039212432's own completion: this gap
  // reproducibly broke 4 sibling tests in this same file plus the new test's own re-run.
  await admin`DELETE FROM harness_shared.plan_item_claims WHERE owner = 'fa-test-ws-mismatch'`;
}

/** A nursery row (EI-311 alias-liveness leg) — cup:spawn's three identity
 *  aliases: spawn_id == session_owner (s-…), plus the per-invocation run_id. */
async function seedSpawn(
  spawnId: string,
  opts: { runId?: string; status?: string; heartbeatAgeSeconds?: number } = {},
): Promise<void> {
  await admin`
    INSERT INTO harness_shared.spawned_agents
      (spawn_id, workspace_id, harness_slug, parent_role, child_role, run_id,
       status, session_owner, heartbeat_at)
    VALUES (${spawnId}, ${WS}, 'demo', 'operator', 'cup', ${opts.runId ?? `${spawnId}-run`},
            ${opts.status ?? 'running'}, ${spawnId},
            now() - ${`${opts.heartbeatAgeSeconds ?? 0} seconds`}::interval)
  `;
}

async function seedPresence(
  ownerId: string,
  opts: { ageSeconds?: number; intent?: string; planSlug?: string | null; workspaceId?: string } = {},
): Promise<void> {
  // EI-18683737202696167: coord_presence_pkey is PRIMARY KEY (owner_id) ONLY — globally
  // unique across the ENTIRE table, not scoped by workspace_id. Short, common literal
  // owner_ids ('su-a', 'su-b', …) are reused by many *.integration.test.ts files across
  // the repo, all sharing this same reused baseline container under a heavily concurrent
  // fleet — so a bare INSERT here can throw a duplicate-key error against a row some
  // OTHER concurrent file/process seeded under the SAME literal (a different failure mode
  // than the workspace-scoped read/cleanup pollution this fixture's WS-uniqueness change
  // already fixes). Upsert so this test's own intended presence values always win,
  // regardless of what a concurrent stranger's row happened to leave behind.
  await admin`
    INSERT INTO harness_shared.coord_presence
      (owner_id, owner_label, workspace_id, source, intent, current_plan_slug, heartbeat_at)
    VALUES (${ownerId}, ${ownerId}, ${opts.workspaceId ?? WS}, 'test', ${opts.intent ?? ''},
            ${opts.planSlug ?? null}, now() - ${`${opts.ageSeconds ?? 0} seconds`}::interval)
    ON CONFLICT (owner_id) DO UPDATE SET
      owner_label = EXCLUDED.owner_label,
      workspace_id = EXCLUDED.workspace_id,
      source = EXCLUDED.source,
      intent = EXCLUDED.intent,
      current_plan_slug = EXCLUDED.current_plan_slug,
      heartbeat_at = EXCLUDED.heartbeat_at
  `;
}

async function seedPlanClaim(
  owner: string,
  opts: { plan?: string; item?: string; ttlSec?: number; ownerName?: string | null; workspaceId?: string } = {},
): Promise<void> {
  await admin`
    INSERT INTO harness_shared.plan_item_claims
      (workspace_id, harness_slug, plan_slug, item_id, owner, owner_name, intent, expires_ts)
    VALUES (${opts.workspaceId ?? WS}, 'all', ${opts.plan ?? 'plan-x'}, ${opts.item ?? 'P-001'},
            ${owner}, ${opts.ownerName ?? null}, 'testing',
            now() + ${`${opts.ttlSec ?? 1200} seconds`}::interval)
  `;
}

/** Append a fleet-membership fact (WI-1345) — the canonical source
 *  fleet_slug/fleet_role is projected from. Fires the presence-guard triggers
 *  for real, exactly like `fleet:join`'s appendFleetMembershipEvent. */
async function seedMembershipEvent(
  ownerId: string,
  fleetSlug: string,
  opts: { workspaceId?: string; fleetRole?: string } = {},
): Promise<void> {
  await admin`
    INSERT INTO harness_shared.fleet_membership_events
      (workspace_id, owner_id, fleet_slug, fleet_role, event)
    VALUES (${opts.workspaceId ?? WS}, ${ownerId}, ${fleetSlug}, ${opts.fleetRole ?? 'member'}, 'join')
  `;
}

beforeAll(async () => {
  isolatedDb = await createOrgTestDb();
  fx = await setupBaselineCoordFixture({ dsn: isolatedDb.adminDsn });
  admin = fx.admin;
  await truncateAll();
}, 120_000);

afterAll(async () => {
  try {
    await truncateAll().catch(() => {});
    await _stopForTests();
  } finally {
    try {
      await fx?.dispose();
    } finally {
      await isolatedDb?.cleanup();
    }
  }
});

beforeEach(async () => {
  await truncateAll();
});

describe('fleet_assignment view + reader (P-001/P-002)', () => {
  it('EI-8106: running nursery aliases are positive recorded-live evidence during bootstrap', async () => {
    await seedSpawn('fa-test-bootstrap', { runId: 'fa-test-bootstrap-run' });
    await seedSpawn('fa-test-stale', { heartbeatAgeSeconds: 1200 });

    const live = await recordedLiveOwnerIds([
      'fa-test-bootstrap',
      'fa-test-bootstrap-run',
      'fa-test-stale',
      'missing-owner',
    ]);

    expect(live.has('fa-test-bootstrap')).toBe(true);
    expect(live.has('fa-test-bootstrap-run')).toBe(true);
    expect(live.has('fa-test-stale')).toBe(false);
    expect(live.has('missing-owner')).toBe(false);
  });

  it('unifies presence, plan-item claims, and work-item claims in one read', async () => {
    await seedPresence('su-live', { intent: 'building', planSlug: 'plan-x' });
    await seedPlanClaim('su-live', { plan: 'plan-x', item: 'P-007' });
    await admin`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, taken_by, taken_at, source_plan_slug)
      VALUES (${WS}, 'demo', 'FA-TEST-1', 'a feature', 'todo', 'su-live', now(), 'plan-x')
    `;
    await admin`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, title, state, assignee)
      VALUES (${WS}, 'FA-TEST-EI1', 'an issue', 'open', 'su-live')
    `;

    const rows = await listFleetAssignments({ workspaceId: WS });
    const sources = rows.map((r) => r.source).sort();
    expect(sources).toEqual(['plan_item_claim', 'presence', 'work_item_claim', 'work_item_claim']);

    const grouped = groupByAgent(rows);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].agentId).toBe('su-live');
    expect(grouped[0].alive).toBe(true);
    expect(grouped[0].claims).toHaveLength(3);
    expect(grouped[0].declaredUnclaimed).toBe(false); // plan-x is backed by a claim
  });

  it('CLAIM-PRIMARY: a live lease with a stale/absent holder is orphaned, not dropped', async () => {
    // Stale holder (presence row 20 min old — beyond the 10-min alive window).
    await seedPresence('su-stale', { ageSeconds: 20 * 60 });
    await seedPlanClaim('su-stale', { plan: 'plan-a', item: 'P-001' });
    // Absent holder (no presence row at all — crashed agent).
    await seedPlanClaim('su-gone', { plan: 'plan-b', item: 'P-002' });

    const rows = await listFleetAssignments({ workspaceId: WS });
    const orphans = orphanedClaims(rows);
    expect(orphans.map((o) => o.agentId).sort()).toEqual(['su-gone', 'su-stale']);
    const gone = orphans.find((o) => o.agentId === 'su-gone');
    expect(gone?.holderPresent).toBe(false);
    const stale = orphans.find((o) => o.agentId === 'su-stale');
    expect(stale?.holderPresent).toBe(true);
    expect(stale?.holderAlive).toBe(false);
  });

  it('terminal work-items and lapsed leases drop out (activeOnly default)', async () => {
    await admin`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, taken_by, taken_at)
      VALUES (${WS}, 'demo', 'FA-TEST-DONE', 'done feature', 'done', 'su-x', now())
    `;
    // A lapsed lease (expired 100s ago, unreclaimed).
    await seedPlanClaim('su-x', { plan: 'plan-l', item: 'P-009', ttlSec: -100 });

    const rows = await listFleetAssignments({ workspaceId: WS });
    expect(rows.filter((r) => r.source !== 'presence')).toHaveLength(0);

    // include_lapsed surfaces the expired lease (flagged inactive).
    const all = await listFleetAssignments({ workspaceId: WS, activeOnly: false });
    const lapsed = all.find((r) => r.itemId === 'P-009');
    expect(lapsed?.claimActive).toBe(false);
  });

  // EI-18688119768148709: `needs-human` and `blocked` are CORRECTLY-PARKED statuses
  // (excluded from claim_next/scheduler:get_next by design, EI-9360) — not stuck work.
  // Before this fix, only the terminal statuses (done/passed/deprecated/resolved/
  // closed/dropped) dropped out of the work_item_claim leg, so a needs-human or
  // blocked item with a live (heartbeating) holder and no recent progress read as a
  // false-positive `stalled` claim, inviting the exact wasteful re-placement cycle
  // EI-8529 already paid for once. Assert both statuses drop out of the view
  // entirely (same as `done`), regardless of holder liveness or progress age.
  it('EI-18688119768148709: needs-human and blocked work-items drop out like terminal ones, never surfacing as stalled', async () => {
    await seedPresence('su-parked-nh', { ageSeconds: 0 }); // alive holder
    await seedPresence('su-parked-blocked', { ageSeconds: 0 }); // alive holder
    await admin`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, taken_by, taken_at, last_progress_at)
      VALUES
        (${WS}, 'demo', 'FA-TEST-NEEDS-HUMAN', 'needs-human feature', 'needs-human', 'su-parked-nh', now() - interval '4 hours', now() - interval '4 hours'),
        (${WS}, 'demo', 'FA-TEST-BLOCKED', 'blocked feature', 'blocked', 'su-parked-blocked', now() - interval '4 hours', now() - interval '4 hours')
    `;

    const rows = await listFleetAssignments({ workspaceId: WS });
    const workItemRows = rows.filter((r) => r.source === 'work_item_claim');
    expect(workItemRows).toHaveLength(0);

    // Sanity check the fixture actually exercises the stall window this fix guards:
    // an ordinary `open` item in the exact same shape (alive holder, no progress in
    // >10min) DOES surface as a live, stalled claim — proving the needs-human/blocked
    // rows above are excluded by STATUS, not by some unrelated fixture quirk.
    await admin`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, taken_by, taken_at, last_progress_at)
      VALUES (${WS}, 'demo', 'FA-TEST-OPEN-STALLED', 'open feature', 'open', 'su-parked-nh', now() - interval '4 hours', now() - interval '4 hours')
    `;
    const rowsWithOpen = await listFleetAssignments({ workspaceId: WS });
    const openRow = rowsWithOpen.find((r) => r.workItemId === 'FA-TEST-OPEN-STALLED');
    expect(openRow?.stalled).toBe(true);
  });

  it('EI-18838892159155751: a fresh reclaim outranks retained older progress for the stall window', async () => {
    await seedPresence('su-fresh-reclaim', { ageSeconds: 0 });
    await admin`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, taken_by, taken_at, last_progress_at)
      VALUES
        (${WS}, 'demo', 'FA-TEST-FRESH-RECLAIM', 'fresh reclaim', 'open',
         'su-fresh-reclaim', now() - interval '2 minutes', now() - interval '4 hours')
    `;

    const rows = await listFleetAssignments({ workspaceId: WS });
    const reclaimed = rows.find((r) => r.workItemId === 'FA-TEST-FRESH-RECLAIM');
    expect(reclaimed?.holderAlive).toBe(true);
    expect(reclaimed?.lastProgressAt).not.toBeNull();
    expect(reclaimed?.stalled).toBe(false);
  });

  it('EI-21830607512202892: resource-governor receipts do not surface as fleet work claims', async () => {
    const owner = 'su-resource-governor';
    const realWorkItem = 'FA-TEST-REAL-CLAIM';
    const receipt = 'FA-TEST-GOVERNOR-RECEIPT';
    await seedPresence(owner, { ageSeconds: 0, intent: 'working real fleet item' });
    await admin`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind, taken_by, taken_at, payload)
      VALUES
        (${WS}, 'demo', ${realWorkItem}, 'real fleet work', 'open', 'task', ${owner}, now(), NULL),
        (${WS}, '', ${receipt}, 'Queued inference admission', 'open', 'task', ${owner}, now(),
         ${admin.json({
           resource_governor: {
             schemaVersion: 1,
             namespace: 'inference',
             idempotencyKey: 'fleet-assignment-regression',
             state: 'queued',
           },
         } as never)})
    `;

    // FALSIFIER FIRST: both rows must exist in the source table, with the receipt
    // still actively assigned. Otherwise a missing-row fixture would make the
    // exclusion assertion pass without exercising migration 1033.
    const sourceRows = await admin<Array<{ feature_id: string; taken_by: string | null; has_receipt: boolean }>>`
      SELECT feature_id, taken_by, jsonb_exists(COALESCE(payload, '{}'::jsonb), 'resource_governor') AS has_receipt
        FROM harness_shared.work_items
       WHERE feature_id IN (${realWorkItem}, ${receipt})
       ORDER BY feature_id
    `;
    expect(sourceRows).toEqual([
      { feature_id: receipt, taken_by: owner, has_receipt: true },
      { feature_id: realWorkItem, taken_by: owner, has_receipt: false },
    ]);

    const rows = await listFleetAssignments({ workspaceId: WS, agent: owner });
    const workClaims = rows.filter((r) => r.source === 'work_item_claim');
    expect(workClaims.map((r) => r.workItemId)).toEqual([realWorkItem]);
    expect(rows.some((r) => r.workItemId === receipt)).toBe(false);
    expect(rows.some((r) => r.workItemId === realWorkItem)).toBe(true);
  });

  it('filters: by plan ("who\'s on P"), by agent ("what is X doing"), by workspace', async () => {
    await seedPresence('su-a', { planSlug: 'plan-x' });
    await seedPlanClaim('su-a', { plan: 'plan-x', item: 'P-001' });
    await seedPlanClaim('su-b', { plan: 'plan-y', item: 'P-002' });
    await seedPresence('su-other-ws', { workspaceId: 'other' });

    const onPlanX = await listFleetAssignments({ workspaceId: WS, plan: 'plan-x' });
    expect(onPlanX.every((r) => r.planSlug === 'plan-x')).toBe(true);
    expect(new Set(onPlanX.map((r) => r.agentId))).toEqual(new Set(['su-a']));

    const agentB = await listFleetAssignments({ workspaceId: WS, agent: 'su-b' });
    expect(agentB).toHaveLength(1);
    expect(agentB[0].itemId).toBe('P-002');

    const scoped = await listFleetAssignments({ workspaceId: WS });
    expect(scoped.some((r) => r.agentId === 'su-other-ws')).toBe(false);
  });

  // EI-18683155325549123: presence rows carry harness_slug=NULL BY DESIGN (identity
  // is workspace-scoped, never harness-bound) — an { agent, harness } self-scoped
  // read (coord:orient's monitor-mode "me" fold) for an agent holding NO harness-
  // scoped claim (a fleet leader with presence only) previously ANDed harness_slug
  // straight onto the union and came back completely empty, misreading as "the
  // fleet is dead" to a leader deciding whether to relaunch/stand down.
  it("EI-18683155325549123: an { agent, harness } self-read sees the caller's own presence-only row, not empty", async () => {
    await seedPresence('su-leader-only', { intent: 'leading, no claims of my own' });

    const selfRead = await listFleetAssignments({ workspaceId: WS, agent: 'su-leader-only', harness: 'demo' });
    expect(selfRead).toHaveLength(1);
    expect(selfRead[0].source).toBe('presence');
    expect(selfRead[0].agentId).toBe('su-leader-only');

    // A DIFFERENT agent's { harness } self-read must NOT see this agent (no cross-
    // identity leakage — the loosened match is scoped to the queried agent alone).
    const otherAgent = await listFleetAssignments({ workspaceId: WS, agent: 'su-someone-else', harness: 'demo' });
    expect(otherAgent).toHaveLength(0);

    // A bare { harness } listing (no agent — the harness-wide roster read) must
    // still EXCLUDE presence-only agents: the loosening is self-identification-only,
    // never a general leak of every workspace presence row into a harness's roster.
    const harnessWide = await listFleetAssignments({ workspaceId: WS, harness: 'demo' });
    expect(harnessWide.some((r) => r.agentId === 'su-leader-only')).toBe(false);
  });

  it('surfaces the declared-but-unclaimed smell (D-002)', async () => {
    await seedPresence('su-talk', { planSlug: 'plan-z', intent: 'on plan-z (allegedly)' });
    const grouped = groupByAgent(await listFleetAssignments({ workspaceId: WS }));
    expect(grouped[0].declaredUnclaimed).toBe(true);
  });

  // ── EI-311: nursery alias liveness (migration 225) ──────────────────────────
  // A spawned bee's claim can key to ANY of its identity aliases (spawn_id ==
  // session_owner, or the run_id a degraded bee self-identified by), and a
  // short-lived bee may never write a presence row at all — the nursery's
  // process heartbeat is its liveness.

  it("EI-311: a claim keyed to a RUNNING spawn's run_id reads alive, not orphaned (the WI-122 repro)", async () => {
    await seedSpawn('fa-test-bee', { runId: 'opspawn-fa-test-bee' });
    await admin`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, taken_by, taken_at)
      VALUES (${WS}, 'demo', 'FA-TEST-EI311', 'bee work', 'open', 'opspawn-fa-test-bee', now())
    `;
    const rows = await listFleetAssignments({ workspaceId: WS });
    const claim = rows.find((r) => r.workItemId === 'FA-TEST-EI311');
    expect(claim?.holderPresent).toBe(true);
    expect(claim?.holderAlive).toBe(true);
    expect(claim?.orphaned).toBe(false);
  });

  it('EI-311: spawn_id-keyed claims join the nursery too; presence wins when both exist', async () => {
    // spawn_id-keyed claim, no presence row → nursery liveness carries it.
    await seedSpawn('fa-test-bee2');
    await seedPlanClaim('fa-test-bee2', { plan: 'plan-n', item: 'P-031' });
    // The same owner ALSO has a presence row (declared intent) → presence's
    // richer fields (intent) must win over the nursery synthetic row.
    await seedSpawn('fa-test-bee3');
    await seedPresence('fa-test-bee3', { intent: 'declared via coord' });
    await seedPlanClaim('fa-test-bee3', { plan: 'plan-n', item: 'P-032' });

    const rows = await listFleetAssignments({ workspaceId: WS });
    const viaNursery = rows.find((r) => r.itemId === 'P-031');
    expect(viaNursery?.holderAlive).toBe(true);
    expect(viaNursery?.orphaned).toBe(false);
    const viaPresence = rows.find((r) => r.itemId === 'P-032');
    expect(viaPresence?.holderAlive).toBe(true);
    expect(viaPresence?.holderIntent).toBe('declared via coord');
  });

  it('EI-311: a FINISHED or stale-heartbeat spawn still orphans its claims', async () => {
    await seedSpawn('fa-test-done', { runId: 'opspawn-fa-test-done', status: 'done' });
    await seedPlanClaim('opspawn-fa-test-done', { plan: 'plan-n', item: 'P-033' });
    await seedSpawn('fa-test-stale', { heartbeatAgeSeconds: 20 * 60 });
    await seedPlanClaim('fa-test-stale', { plan: 'plan-n', item: 'P-034' });

    const rows = await listFleetAssignments({ workspaceId: WS });
    const done = rows.find((r) => r.itemId === 'P-033');
    expect(done?.holderPresent).toBe(false); // finished spawn emits no holder row
    expect(done?.orphaned).toBe(true);
    const stale = rows.find((r) => r.itemId === 'P-034');
    expect(stale?.holderPresent).toBe(true); // running but heartbeat stale
    expect(stale?.holderAlive).toBe(false);
    expect(stale?.orphaned).toBe(true);
  });

  // EI-18690480039212432: fleet:assignments returned agents[].fleet = null for a
  // LIVE fleet member fleet:status correctly reported as a member. Root cause: the
  // view's claim legs joined the membership CTE on the CLAIM ROW's OWN workspace_id
  // (often the plan-store DEFAULT_WORKSPACE_ID scope, EI-295) instead of the
  // holder's REAL (presence) workspace where fleet_membership_events is actually
  // appended — so a claim recorded under the plan-store scope missed the
  // membership fact entirely. Repro: presence + the membership fact both live
  // under the agent's real workspace (WS), but its plan-item CLAIM is recorded
  // under DEFAULT_WORKSPACE_ID (a real, common split — EI-295's own comment).
  it('EI-18690480039212432: fleetSlug resolves for a claim whose workspace_id differs from the holder\'s real (membership) workspace', async () => {
    const owner = 'fa-test-ws-mismatch';
    await seedPresence(owner, { intent: 'draining bugs' }); // real workspace: WS
    await seedMembershipEvent(owner, 'gui-chat-controls', { workspaceId: WS, fleetRole: 'member' });
    // The claim itself lives in the OTHER accepted bucket (plan-store scope) —
    // listFleetAssignments' outer filter always includes it alongside WS/'*', so
    // the row is never dropped outright; only its OWN fleet_slug join used to
    // silently miss.
    await seedPlanClaim(owner, { plan: 'plan-x', item: 'P-050', workspaceId: DEFAULT_WORKSPACE_ID });

    const rows = await listFleetAssignments({ workspaceId: WS });
    const claimRow = rows.find((r) => r.itemId === 'P-050');
    expect(claimRow?.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
    expect(claimRow?.fleetSlug).toBe('gui-chat-controls');
    expect(claimRow?.fleetRole).toBe('member');

    // groupByAgent must not lose it either — the field a fleet-leader actually
    // filters `agents[]` by.
    const grouped = groupByAgent(rows);
    const g = grouped.find((a) => a.agentId === owner);
    expect(g?.fleetSlug).toBe('gui-chat-controls');
  });
});

describe('per-assignee work-list: reorder + projection (local-hive P-020/P-021/D-008)', () => {
  // Seed a bee holding a mix of feature + issue work-items, then exercise the
  // reorder_work_item SQL fn (via the engine) + the fleet_assignment rank surfacing.
  async function seedBeeQueue(): Promise<void> {
    await seedPresence('su-bee', { intent: 'working its list' });
    await admin`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, item_kind, taken_by, taken_at, created_ts, ts, updated_ts)
      VALUES
        (${WS}, 'demo', 'FA-TEST-F1', 'feature one', 'todo', 'feature', 'su-bee', now(), 1, 1, 1),
        (${WS}, 'demo', 'FA-TEST-F2', 'feature two', 'todo', 'feature', 'su-bee', now(), 2, 2, 2),
        (${WS}, 'demo', 'FA-TEST-F3', 'feature three', 'todo', 'feature', 'su-bee', now(), 3, 3, 3)
    `;
    await admin`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, scope, title, kind, state, assignee, assigned_at)
      VALUES (${WS}, 'FA-TEST-B1', 'harness:demo', 'a blocking bug', 'bug', 'open', 'su-bee', now())
    `;
  }

  it('reorder places items at a rank (insert-at-rank, peers shift) across both families', async () => {
    await seedBeeQueue();
    // Bee self-sequences its initial list 0..3 (default writer 'cup').
    await reorderWorkItem('FA-TEST-F1', 0);
    await reorderWorkItem('FA-TEST-F2', 1);
    await reorderWorkItem('FA-TEST-F3', 2);
    const seeded = await reorderWorkItem('FA-TEST-B1', 3);
    expect('error' in seeded).toBe(false);

    // Queen injects the bug to head-of-line (writer 'mug' — the propose/dispose audit).
    const moved = await reorderWorkItem('FA-TEST-B1', 0, { writer: 'mug' });
    if ('error' in moved) throw new Error(moved.error);
    expect(moved.rank).toBe(0);
    expect(moved.writer).toBe('mug');
    expect(moved.queue.map((q) => q.id)).toEqual(['FA-TEST-B1', 'FA-TEST-F1', 'FA-TEST-F2', 'FA-TEST-F3']);
  });

  it('rejects ranking an unassigned item', async () => {
    await admin`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, item_kind, created_ts, ts, updated_ts)
      VALUES (${WS}, 'demo', 'FA-TEST-UNASSIGNED', 'nobody owns me', 'todo', 'feature', 1, 1, 1)
    `;
    const res = await reorderWorkItem('FA-TEST-UNASSIGNED', 0);
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toMatch(/unassigned/);
  });

  it('the projection surfaces doing/queued/load with rank_writer through the view', async () => {
    await seedBeeQueue();
    await reorderWorkItem('FA-TEST-F1', 0);
    await reorderWorkItem('FA-TEST-F2', 1);
    await reorderWorkItem('FA-TEST-F3', 2);
    await reorderWorkItem('FA-TEST-B1', 0, { writer: 'mug' }); // Queen head-of-line

    const rows = await listFleetAssignments({ workspaceId: WS, agent: 'su-bee' });
    // every work-item row carries its rank + writer off the view
    const wiRows = rows.filter((r) => r.source === 'work_item_claim');
    expect(wiRows.length).toBe(4);
    const head = wiRows.find((r) => r.assigneeRank === 0);
    expect(head?.workItemId).toBe('FA-TEST-B1');
    expect(head?.rankWriter).toBe('mug');

    const grouped = groupByAgent(rows);
    const bee = grouped.find((g) => g.agentId === 'su-bee')!;
    expect(bee.load).toBe(4);
    expect(bee.doing?.id).toBe('FA-TEST-B1'); // head-of-line
    expect(bee.doing?.rankWriter).toBe('mug');
    expect(bee.queued.map((q) => q.id)).toEqual(['FA-TEST-B1', 'FA-TEST-F1', 'FA-TEST-F2', 'FA-TEST-F3']);
  });
});

describe('fleet_assignment change-feed (P-005/P-006)', () => {
  const received: FleetAssignmentChange[] = [];
  let unsubscribe: (() => void) | null = null;

  beforeEach(async () => {
    received.length = 0;
    unsubscribe = onFleetAssignmentChange((c) => received.push(c));
    // Let the lazy LISTEN connection establish before triggering writes.
    await vi.waitFor(async () => {
      await admin`SELECT 1`;
    });
    await new Promise((r) => setTimeout(r, 150));
  });

  afterEach(async () => {
    unsubscribe?.();
    await _stopForTests();
  });

  it('claim acquire → wake; lease renewal → silent; release → wake', async () => {
    await seedPlanClaim('su-feed', { plan: 'plan-f', item: 'P-001' });
    await vi.waitFor(() => {
      expect(received.some((c) => c.source === 'plan_item_claim' && c.agentId === 'su-feed')).toBe(true);
    });

    received.length = 0;
    // Renewal: only the lease timestamps move — must NOT notify.
    await admin`
      UPDATE harness_shared.plan_item_claims
      SET expires_ts = now() + interval '40 minutes', last_activity_ts = now()
      WHERE owner = 'su-feed'`;
    await new Promise((r) => setTimeout(r, 400));
    expect(received).toHaveLength(0);

    await admin`DELETE FROM harness_shared.plan_item_claims WHERE owner = 'su-feed'`;
    await vi.waitFor(() => {
      expect(received.some((c) => c.source === 'plan_item_claim')).toBe(true);
    });
  });

  it('presence intent change → wake; heartbeat-only bump → silent', async () => {
    await seedPresence('su-pulse', { intent: 'first' });
    await vi.waitFor(() => {
      expect(received.some((c) => c.source === 'presence' && c.agentId === 'su-pulse')).toBe(true);
    });

    received.length = 0;
    await admin`UPDATE harness_shared.coord_presence SET heartbeat_at = now() WHERE owner_id = 'su-pulse'`;
    await new Promise((r) => setTimeout(r, 400));
    expect(received).toHaveLength(0);

    await admin`UPDATE harness_shared.coord_presence SET intent = 'second' WHERE owner_id = 'su-pulse'`;
    await vi.waitFor(() => {
      expect(received.some((c) => c.source === 'presence' && c.agentId === 'su-pulse')).toBe(true);
    });
  });

  it('work-item claim scalar change → wake (features + issues); status churn → silent', async () => {
    await admin`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, item_kind, taken_by, taken_at)
      VALUES (${WS}, 'demo', 'FA-TEST-FEED', 'feed feature', 'todo', 'feature', 'su-wf', now())
    `;
    await vi.waitFor(() => {
      expect(received.some((c) => c.source === 'work_item_claim' && c.agentId === 'su-wf')).toBe(true);
    });

    received.length = 0;
    // Status churn without a claim change must NOT fire the assignment feed.
    await admin`
      UPDATE harness_shared.harness_features_consolidated
      SET status = 'validating' WHERE feature_id = 'FA-TEST-FEED'`;
    await new Promise((r) => setTimeout(r, 400));
    expect(received).toHaveLength(0);

    // Release (taken_by → NULL) fires, attributed to the OLD holder.
    await admin`
      UPDATE harness_shared.harness_features_consolidated
      SET taken_by = NULL WHERE feature_id = 'FA-TEST-FEED'`;
    await vi.waitFor(() => {
      expect(received.some((c) => c.source === 'work_item_claim' && c.agentId === 'su-wf')).toBe(true);
    });
  });
});

/**
 * EI-21302052245180843 — a `{ harness }` filter must not zero a PRESENCE-only agent
 * when another predicate has already pinned the read's scope.
 *
 * The view's presence branch emits `NULL::text AS harness_slug` BY DESIGN (identity is
 * workspace-scoped, never harness-bound) while populating `plan_slug` from
 * `current_plan_slug`. So `AND harness_slug = $h` can NEVER match a presence row.
 * EI-18683155325549123 already fixed this for `{ agent }` but reasoned that "a bare
 * `{ harness }` listing (no agent) is unaffected" — true of a BARE listing, but
 * `{ plan }` and `{ fleet }` are not bare, and were affected identically.
 *
 * Measured live before the fix: `fleet:assignments { plan: 'byoc-cloud-workspaces-…',
 * workspace, harness: 'papercusp' }` returned agents:0 / candidates:0 while the SAME
 * call without `harness` returned ELEVEN live agents, each carrying that exact plan.
 *
 * The last test is the one that keeps this fix HONEST: a bare `{ harness }` must still
 * exclude presence rows, or the fix has over-widened into the EI-6176 leak it must not
 * reintroduce.
 */
describe('harness filter vs presence-only rows (EI-21302052245180843)', () => {
  const PLAN = 'fa-harness-presence-plan';
  const FLEET = 'fa-harness-presence-fleet';
  const HARNESS = 'papercusp';

  beforeEach(async () => {
    // Presence ONLY — deliberately no plan/work-item claim, so this agent's sole row
    // is the harness_slug=NULL presence row. That is the whole hazard surface.
    await seedPresence('su-presence-only', { planSlug: PLAN });
    await seedMembershipEvent('su-presence-only', FLEET);
  });

  it('NEGATIVE CONTROL: the PRE-FIX predicate returns zero for the very same row', async () => {
    // The point of this file's fix, kept executable rather than described. This is the
    // OLD clause verbatim — `harness_slug = $h` with no presence escape — run against the
    // SAME seeded presence row the tests below assert IS returned. It must find nothing.
    //
    // Without this, every assertion below would pass just as happily if the fix were
    // reverted and the presence row happened to be visible for some other reason. With it,
    // the file demonstrates the before AND the after on every run, which is stronger
    // evidence than a one-shot mutation of the shared tree (and needs no sweep lock).
    const preFix = await admin`
      SELECT agent_id FROM harness_shared.fleet_assignment
       WHERE workspace_id = ${WS}
         AND plan_slug = ${PLAN}
         AND harness_slug = ${HARNESS}
    `;
    expect(preFix.map((r) => r.agent_id)).not.toContain('su-presence-only');

    // ...and the POST-FIX clause, equally verbatim, does find it. Same row, same seed,
    // one predicate apart — so a zero above is attributable to the clause and nothing else.
    const postFix = await admin`
      SELECT agent_id FROM harness_shared.fleet_assignment
       WHERE workspace_id = ${WS}
         AND plan_slug = ${PLAN}
         AND (harness_slug = ${HARNESS} OR (source = 'presence' AND harness_slug IS NULL))
    `;
    expect(postFix.map((r) => r.agent_id)).toContain('su-presence-only');
  });

  it('CONTROL: the seeded presence row is visible with no harness filter', async () => {
    // Proves the fixture and the plan filter both work, so a zero below is attributable
    // to the harness clause alone rather than to a broken seed.
    const rows = await listFleetAssignments({ workspaceId: WS, plan: PLAN });
    expect(rows.map((r) => r.agentId)).toContain('su-presence-only');
    expect(rows.every((r) => r.harnessSlug === null)).toBe(true); // the NULL that breaks it
  });

  it('{ plan } + { harness } still returns the presence-only agent', async () => {
    const rows = await listFleetAssignments({ workspaceId: WS, plan: PLAN, harness: HARNESS });
    expect(rows.map((r) => r.agentId)).toContain('su-presence-only');
  });

  it('{ fleet } + { harness } still returns the presence-only agent', async () => {
    const rows = await listFleetAssignments({ workspaceId: WS, fleet: FLEET, harness: HARNESS });
    expect(rows.map((r) => r.agentId)).toContain('su-presence-only');
  });

  it('{ agent } + { harness } still returns it — the original EI-18683155325549123 fix', async () => {
    const rows = await listFleetAssignments({ workspaceId: WS, agent: 'su-presence-only', harness: HARNESS });
    expect(rows.map((r) => r.agentId)).toContain('su-presence-only');
  });

  it('OVER-WIDENING GUARD: a BARE { harness } listing still excludes presence rows', async () => {
    // Nothing pins a presence row here, so admitting it would surface agents working a
    // DIFFERENT harness — the EI-6176 cross-harness leak. This must stay excluded.
    const rows = await listFleetAssignments({ workspaceId: WS, harness: HARNESS });
    expect(rows.map((r) => r.agentId)).not.toContain('su-presence-only');
  });
});
