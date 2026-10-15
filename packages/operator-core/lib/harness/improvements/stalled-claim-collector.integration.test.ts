/**
 * stalled-claim-collector.integration.test.ts — bug-drain-200k live find
 * (2026-07-21, WI-3669 recurrence).
 *
 * `collectStalledClaimSignals` (the "claim held by a live agent, no progress"
 * watchdog) must NOT re-flag a work-item the holder has deliberately parked via
 * `payload._claimHold: true` (WI-2797 "held open" — the same floor that already
 * excludes the row from claim_next/scheduler:get_next self-select). Before this
 * fix the collector only checked holder-liveness + last_progress_at age against
 * `harness_shared.fleet_assignment`, with no awareness of `_claimHold` — so a
 * considered "nothing more to do right now, needs a live rig / owner decision"
 * disposition kept re-surfacing as a fresh "stalled claim" bug forever (it never
 * gets a checkpoint/state update again by design), burning a full
 * investigate-and-rediscover cycle on every sweep (confirmed live on WI-3669,
 * held+blocked ~20h earlier, resurfaced verbatim under bug-drain-200k).
 *
 * Uses the full baseline-schema fixture (real `fleet_assignment` view +
 * `coord_presence` + `work_items`), same wiring as fleet/assignments.integration.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { collectStalledClaimSignals } from './watchdog';

let fx: BaselineCoordFixture;
// EI-18683737202696167: WS is deliberately NOT 'default'. listFleetAssignments (the reader
// `harness_shared.fleet_assignment` is exposed through elsewhere, e.g.
// assignments.integration.test.ts) always OR's in `workspace_id = 'default'` regardless of
// the caller's own workspace filter (EI-295, for plan-store-default-scoped claims) — so
// seeding under 'default' here made every row this file inserts (`su-held-holder`,
// `su-stalled-holder`, …) visible to ANY other concurrent consumer of the same shared
// baseline-coord fixture's reads, independent of the fixture mutex's timing. A workspace id
// outside that always-included bucket makes this file's rows structurally invisible to
// other files' workspace-scoped reads.
const WS = 'sct-collector-test-ws';
const H = 'papercup';

// Scoped DELETEs (by WS / the SCT-TEST-% feature-id namespace), never a blunt TRUNCATE of
// the globally-shared coord_presence table — a TRUNCATE wipes every row from every OTHER
// concurrent consumer of the same fixture (any file, any fleet agent, any moment), not just
// this file's own seed (EI-18683737202696167).
async function truncateAll(): Promise<void> {
  await fx.admin`DELETE FROM harness_shared.coord_presence WHERE workspace_id = ${WS}`;
  await fx.admin`DELETE FROM harness_shared.work_items WHERE feature_id LIKE 'SCT-TEST-%'`;
  await fx.admin`DELETE FROM harness_shared.carry_notes WHERE scope LIKE 'workitem:%SCT-TEST-%'`;
}

async function seedPresence(ownerId: string): Promise<void> {
  // EI-18683737202696167: coord_presence_pkey is PRIMARY KEY (owner_id) ONLY — globally
  // unique, not scoped by workspace_id — so a bare INSERT can collide with a same-named
  // literal ('su-held-holder' et al.) seeded by another concurrent *.integration.test.ts
  // process on this shared fixture. Upsert so this test's own values always win.
  await fx.admin`
    INSERT INTO harness_shared.coord_presence (owner_id, owner_label, workspace_id, source, intent, heartbeat_at)
    VALUES (${ownerId}, ${ownerId}, ${WS}, 'test', '', now())
    ON CONFLICT (owner_id) DO UPDATE SET
      owner_label = EXCLUDED.owner_label,
      workspace_id = EXCLUDED.workspace_id,
      source = EXCLUDED.source,
      intent = EXCLUDED.intent,
      heartbeat_at = EXCLUDED.heartbeat_at`;
}

/** Seed an issue-family (bug) work_items row, claimed a while ago with a stale
 *  last_progress_at — the "holder alive, no item-scoped progress" stalled shape. */
async function seedBug(
  featureId: string,
  takenBy: string,
  takenAgoMin: number,
  opts: { claimHold?: boolean; status?: string } = {},
): Promise<void> {
  const payload = opts.claimHold ? { _claimHold: true, held_open_by: takenBy, held_open_reason: 'blocked' } : {};
  await fx.admin`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, status, taken_by, taken_at,
       last_progress_at, payload, created_ts, updated_ts)
    VALUES
      (${WS}, ${H}, ${featureId}, 'bug', ${featureId}, ${opts.status ?? 'blocked'}, ${takenBy},
       now() - make_interval(mins => ${takenAgoMin}),
       now() - make_interval(mins => ${takenAgoMin}),
       ${fx.admin.json(payload)}, ${Date.now()}, ${Date.now()})`;
}

const collect = () => collectStalledClaimSignals(fx.admin, WS, { stalledClaimMinutes: 5 });

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
}, 120_000);

afterAll(async () => {
  // EI-18683737202696167: clean up this file's own seeded rows BEFORE releasing the
  // shared-fixture mutex, so the next waiter never inherits leftover SCT-TEST-* rows.
  await truncateAll().catch(() => {});
  await fx?.dispose();
});

beforeEach(async () => {
  await truncateAll();
});

describe('collectStalledClaimSignals — claim-hold exclusion (WI-3669 recurrence)', () => {
  it('flags a genuinely stalled claim (alive holder, stale progress, NOT claim-held)', async () => {
    // EI-18683737202696167 (pre-existing, unrelated to the file's cross-pollution bug):
    // seedBug's default `status: 'blocked'` is itself EXCLUDED by
    // collectStalledClaimSignals's `fa.status IS DISTINCT FROM 'blocked'` filter (a
    // blocked status IS one of the two "deliberately parked" shapes the query defends
    // against — see the SQL comment in watchdog.ts). A "genuinely stalled, actively
    // claimed" item must use a non-blocked status (e.g. 'wip') or this seed can never
    // match the query regardless of holder/progress-age, silently asserting on an
    // always-empty result.
    await seedPresence('su-stalled-holder');
    await seedBug('SCT-TEST-001', 'su-stalled-holder', 60, { status: 'wip' });
    const sigs = await collect();
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.source).toBe('stalled-claim');
    expect(sigs[0]!.body).toContain('SCT-TEST-001');
  });

  it('recent owner-wide activity does not mask stale item-scoped progress', async () => {
    const owner = 'su-active-elsewhere';
    await seedPresence(owner);
    await seedBug('SCT-TEST-005', owner, 60, { status: 'wip' });
    await fx.admin`
      INSERT INTO harness_shared.agent_activity (workspace_id, owner_id, kind, summary, created_at)
      VALUES (${WS}, ${owner}, 'tool', 'working elsewhere', now())`;
    await fx.admin`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key,
         status, coord_owner_id, goal_ref, invoked_at)
      VALUES
        (${WS}, ${H}, 'agent-mcp', 'work_items:get', 'operator', 's-watchdog-test',
         'w-watchdog-test', 'ok', ${owner}, 'WI-OTHER', now())`;

    const sigs = await collect();
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.body).toContain('SCT-TEST-005');
  });

  it('does NOT flag a deliberately claim-held item (payload._claimHold: true)', async () => {
    await seedPresence('su-held-holder');
    await seedBug('SCT-TEST-002', 'su-held-holder', 60, { claimHold: true });
    expect(await collect()).toEqual([]);
  });

  it('a mixed set flags only the non-held stalled claim', async () => {
    await seedPresence('su-stalled-holder');
    await seedPresence('su-held-holder');
    await seedBug('SCT-TEST-003', 'su-stalled-holder', 60, { status: 'wip' });
    await seedBug('SCT-TEST-004', 'su-held-holder', 60, { claimHold: true });
    const sigs = await collect();
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.body).toContain('SCT-TEST-003');
    expect(sigs[0]!.body).not.toContain('SCT-TEST-004');
  });
});
