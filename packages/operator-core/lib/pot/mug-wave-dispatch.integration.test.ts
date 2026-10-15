/**
 * mug-wave-dispatch.integration.test.ts — the END-TO-END wave-ordering proof
 * (queen-wave-dispatch-2026-06-13 W-04 / P-040), against REAL migrated PG.
 *
 * A multi-wave `## Promote` block, once promoted + converted, is a set of
 * feature-family work-items in `harness_features_consolidated` with
 * `coord_links rel='blocks'` edges (tier2 `blocked_by` tier1) and a per-lane
 * `payload.brief`. This test drives the two halves the Mug actually runs over
 * that state — her placement chokepoint (`gatherFrontier`) and the completion
 * edge-resolution sweep (`reconcileOnePot`) — and proves the wave ordering
 * executes THROUGH cup placement with ZERO pair-emit:
 *
 *   1. tier1 (incl. a `generate`-derived lane) is placeable as a BATCH, each lane
 *      carrying its OWN brief; tier2 is NOT placeable (blocked at the chokepoint
 *      with the structural skip reason).
 *   2. completing ONE tier1 lane fires the watchdog's `unblocked` edge-resolution
 *      wake (payload kind `placement-unblocked`) — the replacement for the
 *      hand-rolled pair-emit `:done` events (D-006/P-032) — yet tier2 stays
 *      blocked: the edges sequence requires the WHOLE upstream batch.
 *   3. completing the rest of the tier1 batch un-gates tier2.
 *   4. tier2 is NOW placeable, carrying its brief — the next wave batch.
 *
 * Schema, DB fixture and side-effect mocks mirror
 * placement-watchdog.integration.test.ts. `gatherFrontier` reads through
 * `getOrgPg()` (no `sql` param), so we point it at the throwaway DB via the mock;
 * `reconcileOnePot` takes the `sql` explicitly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';

const mocks = vi.hoisted(() => ({
  wakeRecipients: vi.fn(async (..._args: unknown[]) => ({ woken: 1 })),
  openEscalation: vi.fn(async () => ({ msg_id: 'esc-test', ts: new Date(0).toISOString() })),
  mugKettleSystemEnabled: vi.fn(async () => false),
  sql: undefined as unknown as Sql,
}));
vi.mock('../agent-tools/coordination/inbox-wake', async (orig) => ({
  ...(await (orig as () => Promise<Record<string, unknown>>)()),
  wakeRecipients: mocks.wakeRecipients,
}));
vi.mock('../agent-tools/coordination/escalations', async (orig) => ({
  ...(await (orig as () => Promise<Record<string, unknown>>)()),
  openEscalation: mocks.openEscalation,
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await (orig as () => Promise<Record<string, unknown>>)()),
  getOrgPg: () => ({ sql: mocks.sql }),
}));
vi.mock('../workspace-registry', async (orig) => ({
  ...(await (orig as () => Promise<Record<string, unknown>>)()),
  activeWorkspaceId: () => 'default',
}));
vi.mock('./started', async (orig) => ({
  ...(await (orig as () => Promise<Record<string, unknown>>)()),
  mugKettleSystemEnabled: mocks.mugKettleSystemEnabled,
}));

import { gatherFrontier } from '../fleet/placement-gather';
import { reconcileOnePot, type PlacementConfig } from './placement-watchdog';

const WS = 'default'; // coord_links default workspace == the org workspace here
const POT = 'papercup';
const MUG = 'mug-owner-1';
const CFG: PlacementConfig = { breakerThreshold: 3, recoveryDebounceMs: 5 * 60_000, dormancyGraceMs: 10 * 60_000, infraBreakerThreshold: 12 };
const NOW = 1_900_000_000_000;
const BLOCKED_REASON = 'blocked — an upstream lane (blocked_by) is not yet complete';

let db: OrgTestDb;
let sql: Sql;

async function seedMugSession(): Promise<void> {
  await sql`
    INSERT INTO harness_shared.adv_sessions (workspace_id, mode, label, coord_owner_id, started_at)
    VALUES (${WS}, 'omp', ${'pot · ' + POT + '/sess-1'}, ${MUG}, now())`;
}

/**
 * A converted wave lane: a `todo` feature-family work-item carrying its per-lane
 * brief. The brief goes in as a real jsonb OBJECT via `sql.json()` — under this
 * client's `prepare:false`, interpolating a pre-`JSON.stringify`'d string (with or
 * without a `::jsonb` cast) double-encodes it into a jsonb STRING SCALAR, so
 * `payload->>'brief'` would read null. `sql.json()` is the form that stores a
 * true object, matching production's stored representation (createWorkItem's
 * `$N::jsonb` write) that the placement read (`workItemToTask`) expects.
 */
async function seedLane(opts: { id: string; status?: string; brief?: string; order: number }): Promise<void> {
  await sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, payload, feature_order, created_ts, updated_ts)
    VALUES (${POT}, ${opts.id}, 'feature', ${opts.status ?? 'todo'}, ${null}, ${WS},
            ${opts.brief != null ? sql.json({ brief: opts.brief }) : null}, ${opts.order}, 0, 0)`;
}

async function seedCup(owner: string, featureId: string, status: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.spawned_agents
      (spawn_id, workspace_id, harness_slug, parent_spawn_id, parent_role, child_role,
       session_owner, feature_id, run_id, status, heartbeat_at, last_output_at, started_at)
    VALUES (${owner}, ${WS}, ${POT}, ${MUG}, 'mug', 'cup',
            ${owner}, ${featureId}, ${'run-' + owner}, ${status}, ${new Date(NOW)}, ${null}, now())`;
}

async function blocksEdge(blocker: string, blocked: string): Promise<void> {
  // A wave blocks-edge has TWO consumers post P-004, so the promote/convert path (and
  // therefore this seed) writes BOTH:
  //   • coord_links rel='blocks' — the placement-watchdog edge-resolution sweep
  //     (reconcileOnePot, placement-watchdog.ts) reads it to emit the `unblocked`
  //     decision + the placement-unblocked wake when a blocker completes. (mig 383 only
  //     dropped the dead change-notify TRIGGER on it, NOT this read path.)
  //   • work_item_deps — the readiness GATE (Mug survey + scheduler claim, the P-004
  //     seam) reads it; migration 379's wir_* triggers maintain the work_item_blocked
  //     sidecar from it so the blocked tier2 lane is held out of the dispatch.
  // src_ref=blocker→dst_ref=blocked (coord_links); blocked_ref/blocker_ref harness-qualified.
  await sql`
    INSERT INTO harness_shared.coord_links (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel)
    VALUES ('default', 'feature', ${POT + '#' + blocker}, 'feature', ${POT + '#' + blocked}, 'blocks')`;
  await sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES ('default', 'feature', ${POT + '#' + blocked}, 'feature', ${POT + '#' + blocker}, 'blocks')`;
}

/** EI-865 / WI-677 — seed a cursed breaker ledger row for a lane (the latched-out state).
 *  `failCount` defaults to 3 (a genuine PATHOLOGY curse, hard-blocked); pass 0 with a high
 *  `infraLossCount` to seed an INFRA false-curse (the WI-677 deadlock signature). */
async function seedCursed(id: string, failCount = 3, infraLossCount = 0): Promise<void> {
  await sql`
    INSERT INTO harness_shared.pot_placements
      (workspace_id, install_slug, work_item_id, harness_slug, status, fail_count, infra_loss_count)
    VALUES (${WS}, ${POT}, ${id}, ${POT}, 'cursed', ${failCount}, ${infraLossCount})`;
}

/** Mark a tier1 lane completed by its placed cup — terminal status + held by the cup. */
async function completeLane(id: string, cup: string): Promise<void> {
  await sql`
    UPDATE harness_shared.harness_features_consolidated
       SET status = 'passed', taken_by = ${cup}, updated_ts = 1
     WHERE harness_slug = ${POT} AND feature_id = ${id}`;
}

async function readPlacementStatus(id: string): Promise<string | null> {
  const rows = await sql<{ status: string }[]>`
    SELECT status FROM harness_shared.pot_placements
     WHERE workspace_id = ${WS} AND install_slug = ${POT} AND work_item_id = ${id}`;
  return rows[0]?.status ?? null;
}

describe('mug wave dispatch — wave ordering through cup placement (real PG, P-040)', () => {
  beforeAll(async () => {
    db = await createOrgTestDb();
    sql = db.adminSql;
    mocks.sql = sql;
  }, 120_000);
  afterAll(async () => {
    await db?.cleanup();
  });
  beforeEach(async () => {
    mocks.wakeRecipients.mockClear();
    mocks.openEscalation.mockClear();
    // Match production's hard-false default, then locally reopen the retired gate
    // to keep this test focused on the underlying wave-dispatch delivery contract.
    mocks.mugKettleSystemEnabled.mockResolvedValue(true);
    // work_item_spec_revision_edges (and spec_evidence_bindings) carry an FK to work_items,
    // so they must be truncated with it — same list as placement-watchdog's fixture.
    await sql`TRUNCATE harness_shared.pot_placements, harness_shared.spawned_agents, harness_shared.spec_evidence_bindings, harness_shared.work_item_spec_revision_edges, harness_shared.work_items, harness_shared.work_item_deps, harness_shared.work_item_blocked, harness_shared.coord_links, harness_shared.adv_sessions `;
    await seedMugSession();
  });

  it('places tier1 as a batch (briefs attached) then tier2 only after the upstream batch completes — zero pair-emit', async () => {
    // ── post-promote/convert state: tier1 = F-501/F-502 (static) + F-503 (generate-
    //    derived); tier2 = F-510 blocked_by all of tier1. Each carries its own brief. ──
    await seedLane({ id: 'F-501', brief: 'Lane A: touch only fetchers/a', order: 1 });
    await seedLane({ id: 'F-502', brief: 'Lane B: touch only fetchers/b', order: 2 });
    await seedLane({ id: 'F-503', brief: 'Universal schema reviews: single handler', order: 3 });
    await seedLane({ id: 'F-510', brief: 'Tier2: integrate the universal handlers', order: 4 });
    for (const upstream of ['F-501', 'F-502', 'F-503']) await blocksEdge(upstream, 'F-510');

    // ── Phase 1: tier1 is placeable as a BATCH (each lane's brief attached); tier2 blocked. ──
    const f1 = await gatherFrontier({ harness: POT, workspaceId: WS, limit: 10 });
    expect(f1.tasks.map((t) => t.id).sort()).toEqual(['F-501', 'F-502', 'F-503']);
    expect(f1.tasks.find((t) => t.id === 'F-501')?.brief).toBe('Lane A: touch only fetchers/a');
    expect(f1.tasks.find((t) => t.id === 'F-503')?.brief).toBe('Universal schema reviews: single handler');
    // tier2 is NOT placeable by any route — dropped at the chokepoint with the structural reason.
    expect(f1.skipped).toContainEqual({ id: 'F-510', reason: BLOCKED_REASON });

    // ── Phase 2: complete ONE tier1 lane through the real path → an `unblocked`
    //    edge-resolution wake fires (NOT a pair-emit) — but tier2 stays blocked. ──
    await seedCup('cup-a', 'F-501', 'done');
    await completeLane('F-501', 'cup-a');
    const sweep1 = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    expect(await readPlacementStatus('F-501')).toBe('completed');
    expect(sweep1.find((r) => r.workItemId === 'F-501' && r.decision === 'unblocked')).toBeTruthy();
    expect(mocks.wakeRecipients).toHaveBeenCalled();
    const wake = mocks.wakeRecipients.mock.calls.at(-1)!;
    expect(wake[0]).toEqual([MUG]);
    expect((wake[1] as unknown as { payload?: { kind?: string } }).payload?.kind).toBe('placement-unblocked');

    // tier2 STILL not placeable — F-502/F-503 are non-terminal (the edges sequence: ALL upstream).
    const f2 = await gatherFrontier({ harness: POT, workspaceId: WS, limit: 10 });
    expect(f2.tasks.map((t) => t.id).sort()).toEqual(['F-502', 'F-503']);
    expect(f2.skipped.map((s) => s.id)).toContain('F-510');

    // ── Phase 3: complete the rest of the tier1 batch → tier2 un-gated. ──
    mocks.wakeRecipients.mockClear();
    await seedCup('cup-b', 'F-502', 'done');
    await completeLane('F-502', 'cup-b');
    await seedCup('cup-c', 'F-503', 'done');
    await completeLane('F-503', 'cup-c');
    const sweep2 = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    // the newly-completed lanes resolve their edges (the already-completed F-501 stays silent).
    expect(sweep2.filter((r) => r.decision === 'unblocked').length).toBeGreaterThan(0);
    expect(sweep2.find((r) => r.workItemId === 'F-501' && r.decision === 'unblocked')).toBeFalsy();

    // ── Phase 4: tier2 NOW places as the next wave batch, carrying its own brief. ──
    const f3 = await gatherFrontier({ harness: POT, workspaceId: WS, limit: 10 });
    expect(f3.tasks.map((t) => t.id)).toEqual(['F-510']);
    expect(f3.tasks[0].brief).toBe('Tier2: integrate the universal handlers');
    expect(f3.skipped).toEqual([]);
  });

  it('EI-865: a CURSED lane is excluded from the placement frontier — by backlog AND by explicit id', async () => {
    await seedLane({ id: 'F-700', brief: 'a healthy ready lane', order: 1 });
    await seedLane({ id: 'F-701', brief: 'a doomed lane the breaker latched', order: 2 });
    await seedCursed('F-701');

    // Backlog path: the cursed lane never appears as a candidate.
    const backlog = await gatherFrontier({ harness: POT, workspaceId: WS, limit: 10 });
    expect(backlog.tasks.map((t) => t.id)).toEqual(['F-700']);

    // Explicit-id path: even named directly, the cursed lane is skipped (not re-placed).
    const byId = await gatherFrontier({ ids: ['F-700', 'F-701'], workspaceId: WS, limit: 10 });
    expect(byId.tasks.map((t) => t.id)).toEqual(['F-700']);
    expect(byId.skipped).toContainEqual({
      id: 'F-701',
      reason: 'cursed — the placement breaker has halted re-placing this item',
    });
  });

  it('WI-677: an INFRA false-curse (fail_count 0, infra_loss_count 12) is RE-PLACED, while a pathology curse (fail_count 3) is still blocked', async () => {
    // The deadlock: after the EI-85 host restart the bounded infra breaker cursed genuinely-
    // ready items at fail_count=0 / infra_loss_count=12, and place_batch then refused them
    // forever. The fix keys the hard-block on fail_count >= breakerThreshold, so a fail_count-0
    // infra-curse re-enters the frontier (and clears on completion) while a real 3-strike curse
    // stays halted.
    await seedLane({ id: 'F-800', brief: 'a healthy ready lane', order: 1 });
    await seedLane({ id: 'F-801', brief: 'an INFRA-false-cursed lane (host restart victim)', order: 2 });
    await seedLane({ id: 'F-802', brief: 'a genuinely pathology-cursed lane', order: 3 });
    await seedCursed('F-801', 0, 12); // infra false-curse — the WI-677 signature
    await seedCursed('F-802', 3, 0); // genuine 3-strike pathology curse

    // Backlog path: the infra-cursed lane is BACK in the frontier; the pathology curse stays out.
    const backlog = await gatherFrontier({ harness: POT, workspaceId: WS, limit: 10 });
    expect(backlog.tasks.map((t) => t.id).sort()).toEqual(['F-800', 'F-801']);
    expect(backlog.tasks.map((t) => t.id)).not.toContain('F-802');

    // Explicit-id path (what the Mug's place_batch does): the infra-cursed lane re-places;
    // the pathology curse is still skipped with the breaker reason.
    const byId = await gatherFrontier({ ids: ['F-800', 'F-801', 'F-802'], workspaceId: WS, limit: 10 });
    expect(byId.tasks.map((t) => t.id).sort()).toEqual(['F-800', 'F-801']);
    expect(byId.skipped).toContainEqual({
      id: 'F-802',
      reason: 'cursed — the placement breaker has halted re-placing this item',
    });
    expect(byId.skipped.map((s) => s.id)).not.toContain('F-801');
  });

  it('a generate-derived lane with no blocker is placeable immediately, carrying its substituted brief', async () => {
    // A standalone generate wave (no blocked_by) — its lanes are ready at once.
    await seedLane({ id: 'F-601', brief: 'Universal schema offers: single handler, offers-specific tests', order: 1 });
    await seedLane({ id: 'F-602', brief: 'Universal schema reviews: single handler, reviews-specific tests', order: 2 });

    const f = await gatherFrontier({ harness: POT, workspaceId: WS, limit: 10 });
    expect(f.tasks.map((t) => t.id).sort()).toEqual(['F-601', 'F-602']);
    expect(f.tasks.find((t) => t.id === 'F-601')?.brief).toContain('offers-specific tests');
    expect(f.skipped).toEqual([]);
  });
});
