/**
 * placement-watchdog.integration.test.ts — the COMPLETION GUARANTEE sweep against
 * REAL migrated PG (mug-autonomous-execution B-09, migration 263).
 *
 * Validates the schema + every sweep query end-to-end: the migration applies (a
 * broken 263 throws in beforeAll), and reconcileOnePot's real SQL — the cup-spawn
 * join, the candidate fetch, the pot_placements upsert, and the stranded-blocker
 * coord_links/split_part query — round-trips against live rows, producing the
 * right P-020 (recover/completed), P-021 (cursed) and P-022 (stranded) decisions.
 *
 * The two side-effect modules (recovery wake, owner escalation) are mocked so the
 * test asserts they fire WITHOUT touching the coord substrate — the durable proof
 * is the pot_placements row state, the same way the system reads it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';

const mocks = vi.hoisted(() => ({
  wakeRecipients: vi.fn(async (..._args: unknown[]) => ({ woken: 1 })),
  openEscalation: vi.fn(async () => ({ msg_id: 'esc-test', ts: new Date(0).toISOString() })),
  resolveEscalation: vi.fn(async () => undefined),
  mugKettleSystemEnabled: vi.fn(async () => false),
}));
vi.mock('../agent-tools/coordination/inbox-wake', async (orig) => ({
  ...(await (orig as () => Promise<Record<string, unknown>>)()),
  wakeRecipients: mocks.wakeRecipients,
}));
vi.mock('../agent-tools/coordination/escalations', async (orig) => ({
  ...(await (orig as () => Promise<Record<string, unknown>>)()),
  openEscalation: mocks.openEscalation,
  resolveEscalation: mocks.resolveEscalation,
}));
vi.mock('../severe-event-broadcast', () => ({ broadcastSevereEvent: vi.fn(async () => true) }));
vi.mock('../agent-tools/coordination/tools/conditions', () => ({
  readConditionEnvelopes: async () => [], computeConditionStates: () => [],
}));
// The tier is permanently retired, so its production gate is always closed.
// Force that one seam open here to keep the watchdog's delivery-body contract
// covered; placement-watchdog.test.ts separately proves the gate stays closed.
vi.mock('./started', async (orig) => ({
  ...(await (orig as () => Promise<Record<string, unknown>>)()),
  mugKettleSystemEnabled: mocks.mugKettleSystemEnabled,
}));

import { hostname } from 'node:os';
import { reconcileOnePot, placementConditionKey, summarizeOpenPlacements, type PlacementConfig } from './placement-watchdog';
import { RECLAIM_STALE_MS } from '../fleet/spawn-reclaim';

const WS = 'default'; // coord_links default workspace == the org workspace here
const POT = 'papercup';
const MUG = 'mug-owner-1';
const CFG: PlacementConfig = {
  breakerThreshold: 3,
  recoveryDebounceMs: 5 * 60_000,
  dormancyGraceMs: 10 * 60_000,
  infraBreakerThreshold: 12,
};
const NOW = 1_900_000_000_000;

let db: OrgTestDb;
let sql: Sql;

async function seedMugSession(): Promise<void> {
  await sql`
    INSERT INTO harness_shared.adv_sessions (workspace_id, mode, label, coord_owner_id, started_at)
    VALUES (${WS}, 'omp', ${'pot · ' + POT + '/sess-1'}, ${MUG}, now())`;
}

async function seedCup(opts: {
  owner: string;
  featureId: string | null;
  status: string;
  heartbeatAtMs?: number;
  lastOutputAtMs?: number | null;
  errorMessage?: string | null;
  pid?: number | null;
  launcherHost?: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO harness_shared.spawned_agents
      (spawn_id, workspace_id, harness_slug, parent_spawn_id, parent_role, child_role,
       session_owner, feature_id, run_id, status, error_message, heartbeat_at, last_output_at, started_at,
       pid, launcher_host)
    VALUES (
      ${opts.owner}, ${WS}, ${POT}, ${MUG}, 'mug', 'cup',
      ${opts.owner}, ${opts.featureId}, ${'run-' + opts.owner}, ${opts.status}, ${opts.errorMessage ?? null},
      ${new Date(opts.heartbeatAtMs ?? NOW)},
      ${opts.lastOutputAtMs == null ? null : new Date(opts.lastOutputAtMs)},
      now(),
      ${opts.pid ?? null}, ${opts.launcherHost ?? null})`;
}

/** A governed model call (agent_usage_samples row) for a cup's run — the WI-233
 *  liveness signal that a heartbeat-stale / reclaimed cup was actually SLOW-BUT-ALIVE. */
async function seedUsageSample(owner: string, tsMs: number): Promise<void> {
  await sql`
    INSERT INTO harness_shared.agent_usage_samples
      (workspace_id, ts, bucket_key, provider, model_class, source, run_id, harness_slug)
    VALUES (${WS}, ${tsMs}, 'anthropic:opus', 'anthropic', 'opus', 'headers', ${'run-' + owner}, ${POT})`;
}

async function seedUnit(opts: {
  id: string;
  status: string;
  takenBy?: string | null;
  harness?: string;
}): Promise<void> {
  const payload = opts.status === 'blocked'
    ? { blockedReason: 'placement test: deliberately parked by leader triage', blockedAt: new Date().toISOString() }
    : {};
  await sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts, payload)
    VALUES (${opts.harness ?? POT}, ${opts.id}, 'feature', ${opts.status},
            ${opts.takenBy ?? null}, ${WS}, 0, 0, ${sql.json(payload)})`;
}

async function readPlacement(
  id: string,
): Promise<{
  status: string;
  fail_count: number;
  infra_loss_count: number;
  escalation_msg_id: string | null;
  recovery_started_at: string | Date | null;
} | null> {
  const rows = await sql<
    {
      status: string;
      fail_count: number;
      infra_loss_count: number;
      escalation_msg_id: string | null;
      recovery_started_at: string | Date | null;
    }[]
  >`
    SELECT status, fail_count, infra_loss_count, escalation_msg_id, recovery_started_at
      FROM harness_shared.pot_placements
     WHERE workspace_id = ${WS} AND install_slug = ${POT} AND work_item_id = ${id}`;
  return rows[0] ?? null;
}

/** F-FIX-041 — a native tool-call activity row for a cup (agent_activity kind='tool'),
 *  marking it a FAIR ATTEMPT (not a zombie). A cup with NO such row reads as a
 *  no-fair-attempt zombie, so its loss feeds the bounded infra breaker, not the pathology one. */
async function seedToolCall(owner: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.agent_activity (workspace_id, owner_id, kind, summary, created_at)
    VALUES (${WS}, ${owner}, 'tool', 'capability:bash', now())`;
}

describe('pot_placements completion sweep (real PG, migration 263)', () => {
  beforeAll(async () => {
    db = await createOrgTestDb();
    sql = db.adminSql;
    // EI-6650: summarizeOpenPlacements (unlike reconcileOnePot above, which takes
    // `sql` as an explicit param) calls the module-level `getOrgPg()` internally, so
    // without env-routing it a la _org-test-db.ts's own doc comment / the established
    // pattern (pot-canary-action.integration.test.ts etc.) it silently connects to
    // whatever getOrgPg() falls back to (discovery file / native :5432) — NOT this
    // throwaway test DB — making every summarizeOpenPlacements assertion in this file
    // vacuously true (querying an unrelated, likely-empty DB) rather than actually
    // exercising the query against the seeded rows.
    process.env.HARNESS_DATABASE_URL = db.appDsn;
    process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
    process.env.DATABASE_URL = db.adminDsn;
    // getOrgPg()'s client is a lazy module-level singleton that only rebuilds when
    // `_adminClient` is null — setting the env vars above does nothing if something
    // already built it against the native-fallback DSN earlier in this worker. Force
    // a rebuild against the just-set env so it actually targets this throwaway DB.
    const { _resetForTests } = await import('@papercusp/db-org');
    await _resetForTests();
  }, 120_000);
  afterAll(async () => {
    await db?.cleanup();
  });
  beforeEach(async () => {
    mocks.wakeRecipients.mockClear();
    mocks.openEscalation.mockClear();
    mocks.resolveEscalation.mockClear();
    mocks.mugKettleSystemEnabled.mockResolvedValue(true);
    await sql`TRUNCATE harness_shared.pot_placements, harness_shared.spawned_agents, harness_shared.spec_evidence_bindings, harness_shared.work_item_spec_revision_edges, harness_shared.work_items, harness_shared.work_item_deps, harness_shared.coord_links, harness_shared.adv_sessions, harness_shared.agent_usage_samples, harness_shared.agent_activity `;
    await seedMugSession();
  });

  it('P-020: a dead cup on a non-terminal unit → recovering + a recovery wake to the Mug', async () => {
    await seedCup({ owner: 'cup-1', featureId: 'F-100', status: 'failed' });
    await seedToolCall('cup-1'); // a fair attempt (made tool calls) then died → item-pathology loss
    await seedUnit({ id: 'F-100', status: 'in_progress', takenBy: 'cup-1' });

    const out = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    const p = await readPlacement('F-100');
    expect(p?.status).toBe('recovering');
    expect(p?.fail_count).toBe(1);
    expect(p?.recovery_started_at).not.toBeNull();
    expect(out.find((r) => r.workItemId === 'F-100')?.decision).toBe('recover');
    expect(mocks.wakeRecipients).toHaveBeenCalledTimes(1);
    expect(mocks.wakeRecipients.mock.calls[0]![0]).toEqual([MUG]);
  });

  it('condition rail opens independent original detector episodes before legacy dedup and recovers exact PG subjects', async () => {
    const open = new Map<string, number>();
    const broadcast = vi.fn(async (event: { conditionKey?: string; oneShot?: boolean }) => {
      expect(event.oneShot).toBe(true); open.set(event.conditionKey!, open.get(event.conditionKey!) ?? NOW); return true;
    });
    const resolve = vi.fn(async (event: { conditionKey: string }) => open.delete(event.conditionKey));
    const conditions = { rail: { broadcast, resolve }, readOpenConditions: async () =>
      [...open].map(([conditionKey, openedAtMs]) => ({ conditionKey, openedAtMs })) };
    for (const [id, state, fails, infra, disposition] of [
      ['F-CURSED-RAIL', 'cursed', 3, 0, 'breaker'], ['F-INFRA-RAIL', 'cursed', 0, 12, 'breaker'],
      ['F-STALE-RAIL', 'recovering', 1, 0, 'recovering'],
    ] as const) {
      await seedUnit({ id, status: 'open' });
      await sql`INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id, status, fail_count,
         infra_loss_count, last_disposition, placed_at, last_seen_at, updated_at, recovery_started_at, last_recovery_at)
        VALUES (${WS}, ${POT}, ${id}, ${POT}, ${MUG}, ${state}, ${fails}, ${infra}, ${disposition},
          now(), ${new Date(NOW)}, now(), ${new Date(NOW - 25 * 3_600_000)}, ${new Date(NOW - 6 * 60_000)})`;
    }
    await seedUnit({ id: 'F-BLOCKER-RAIL', status: 'failing' });
    await seedUnit({ id: 'F-DOWNSTREAM-RAIL', status: 'open' });
    await sql`INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocker_kind, blocker_ref, blocked_kind, blocked_ref, dep_type)
      VALUES ('default', 'feature', ${POT + '#F-BLOCKER-RAIL'}, 'feature', ${POT + '#F-DOWNSTREAM-RAIL'}, 'blocks')`;
    await reconcileOnePot(sql, WS, POT, CFG, NOW, () => false, conditions);
    expect(open.size).toBe(4);
    await reconcileOnePot(sql, WS, POT, CFG, NOW + 1, () => false, conditions);
    expect(open.size).toBe(4); expect(broadcast).toHaveBeenCalledTimes(8);
    const foreign = placementConditionKey('foreign', POT, POT, 'F-CURSED-RAIL', 'cursed');
    open.set(foreign, NOW);
    // Recovery is independent of the vanished historical driver and serving cups.
    await sql`DELETE FROM harness_shared.adv_sessions`;
    await sql`UPDATE harness_shared.harness_features_consolidated SET status = 'done'
      WHERE workspace_id = ${WS} AND harness_slug = ${POT} AND feature_id IN
        ('F-CURSED-RAIL', 'F-INFRA-RAIL', 'F-STALE-RAIL', 'F-DOWNSTREAM-RAIL')`;
    await reconcileOnePot(sql, WS, POT, CFG, NOW + 2, () => false, conditions);
    expect([...open.keys()]).toEqual([foreign]); expect(resolve).toHaveBeenCalledTimes(4);
  });

  it('EI-15990: recovery_started_at survives exit from recovering — a durable timeline marker, not wiped on completion', async () => {
    const recoveryStart = NOW - 5 * 60_000;
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         status, fail_count, last_recovery_at, recovery_started_at, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-RECOVERY-THEN-DONE', ${POT}, ${MUG},
              'recovering', 1, ${new Date(recoveryStart)}, ${new Date(recoveryStart)}, now(), now(), now())`;
    // Unit reaches TERMINAL while the placement row was still 'recovering' — the
    // completion sweep converges it to 'completed'.
    await seedUnit({ id: 'F-RECOVERY-THEN-DONE', status: 'resolved', takenBy: null });

    await reconcileOnePot(sql, WS, POT, CFG, NOW);

    const p = await readPlacement('F-RECOVERY-THEN-DONE');
    expect(p?.status).toBe('completed');
    // Before the EI-15990 fix this column was unconditionally NULLed the instant
    // status left 'recovering' (a CASE ... ELSE NULL), so a completed placement's
    // recovery history was unobservable — confirmed live: 0 of 180 real papercusp
    // placements ever had a non-null recovery_started_at despite 110 recorded infra
    // losses. It must now be PRESERVED verbatim as a durable timeline marker.
    expect(p?.recovery_started_at).not.toBeNull();
    expect(new Date(p!.recovery_started_at!).getTime()).toBe(recoveryStart);
  });

  it('EI-12108: a cup-less open placement is still reconciled and a parked unit converges to blocked', async () => {
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         status, fail_count, last_recovery_at, recovery_started_at, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-ORPHAN-PARKED', ${POT}, ${MUG},
              'recovering', 1, ${new Date(NOW - 60_000)}, ${new Date(NOW - 60 * 60_000)}, now(), now(), now())`;
    await seedUnit({ id: 'F-ORPHAN-PARKED', status: 'blocked', takenBy: null });

    await reconcileOnePot(sql, WS, POT, CFG, NOW);

    expect((await readPlacement('F-ORPHAN-PARKED'))?.status).toBe('blocked');
    expect(mocks.wakeRecipients).not.toHaveBeenCalled();
  });

  it('EI-12108: an overdue cup-less recovery halts as stranded and escalates once', async () => {
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         status, fail_count, last_recovery_at, recovery_started_at, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-RECOVERY-TIMEOUT', ${POT}, ${MUG},
              'recovering', 1, ${new Date(NOW - 60_000)}, ${new Date(NOW - 25 * 60 * 60_000)}, now(), now(), now())`;
    await seedUnit({ id: 'F-RECOVERY-TIMEOUT', status: 'in_progress', takenBy: null });

    const first = await reconcileOnePot(sql, WS, POT, CFG, NOW);
    const second = await reconcileOnePot(sql, WS, POT, CFG, NOW + 30_000);

    const stranded = await readPlacement('F-RECOVERY-TIMEOUT');
    expect(stranded?.status).toBe('stranded');
    expect(first.find((r) => r.workItemId === 'F-RECOVERY-TIMEOUT')?.decision).toBe('stale-recovery');
    expect(second.find((r) => r.workItemId === 'F-RECOVERY-TIMEOUT')?.decision).toBe('latched');
    expect(mocks.openEscalation).toHaveBeenCalledTimes(1);
    expect(mocks.wakeRecipients).not.toHaveBeenCalled();
    // EI-15990 — stranding (leaving 'recovering') must not wipe the timeline marker.
    expect(stranded?.recovery_started_at).not.toBeNull();
  });

  // WI-3977 — the duplicate-placement false-positive this reconcile fixes: a cup
  // whose heartbeat_at went stale beyond RECLAIM_STALE_MS (the launcher-side gap
  // WI-3961 documented — a scope-isolated cup's heartbeat can go un-bumped for a
  // stretch, e.g. after a bg-host restart, without the process ever dying) is NOT
  // read `dead` when its OS process is confirmed alive on this host — so the Mug
  // is NOT woken to re-place a duplicate cup onto the same unit (mirroring the
  // reclaim sweep's WI-3961 exemption, applied here to the watchdog's independent
  // liveness derivation).
  it('WI-3977: a heartbeat-stale but process-confirmed-alive cup reads healthy — no duplicate re-place wake', async () => {
    await seedCup({
      owner: 'cup-stale-alive',
      featureId: 'F-115',
      status: 'running',
      heartbeatAtMs: NOW - RECLAIM_STALE_MS - 1, // stale by the naive heartbeat-only check
      lastOutputAtMs: NOW - 1000, // still producing output — not wedged
      pid: 424242,
      launcherHost: hostname(), // same-host as the code under test (real hostname(), no mock)
    });
    await seedUnit({ id: 'F-115', status: 'in_progress', takenBy: 'cup-stale-alive' });

    const fakeIsAlive = vi.fn((pid: number) => pid === 424242);
    await reconcileOnePot(sql, WS, POT, CFG, NOW, fakeIsAlive);

    // 'healthy' is the silent no-op path (steer, don't dispatch — P-023) and never
    // pushes a PlacementSweepResult; the durable proof is the placement row + the
    // absence of a recovery wake, matching the existing "live cup" test's pattern.
    expect((await readPlacement('F-115'))?.status).toBe('working'); // NOT recovering
    expect(mocks.wakeRecipients).not.toHaveBeenCalled(); // NOT re-placed
    expect(fakeIsAlive).toHaveBeenCalledWith(424242, 'spawn');
  });

  // The dual: WITHOUT the pid confirmation (isAlive says dead), the SAME stale
  // heartbeat still reads `dead` and re-places — proving the fix narrows the
  // false-positive without silently exempting every stale cup.
  it('WI-3977 (dual): a heartbeat-stale cup NOT confirmed alive still recovers as before (no false negative)', async () => {
    await seedCup({
      owner: 'cup-stale-dead',
      featureId: 'F-116',
      status: 'running',
      heartbeatAtMs: NOW - RECLAIM_STALE_MS - 1,
      lastOutputAtMs: NOW - 1000,
      pid: 424243,
      launcherHost: hostname(),
    });
    await seedToolCall('cup-stale-dead');
    await seedUnit({ id: 'F-116', status: 'in_progress', takenBy: 'cup-stale-dead' });

    const fakeIsAlive = vi.fn(() => false); // /proc confirms it's actually gone
    await reconcileOnePot(sql, WS, POT, CFG, NOW, fakeIsAlive);

    expect((await readPlacement('F-116'))?.status).toBe('recovering');
    expect(mocks.wakeRecipients).toHaveBeenCalledTimes(1);
  });

  it('P-020: a live cup on a non-terminal unit → working, no wake (steering, hands-off)', async () => {
    await seedCup({
      owner: 'cup-1',
      featureId: 'F-110',
      status: 'running',
      heartbeatAtMs: NOW - 1000,
      lastOutputAtMs: NOW - 1000,
    });
    await seedUnit({ id: 'F-110', status: 'in_progress', takenBy: 'cup-1' });

    await reconcileOnePot(sql, WS, POT, CFG, NOW);

    expect((await readPlacement('F-110'))?.status).toBe('working');
    expect(mocks.wakeRecipients).not.toHaveBeenCalled();
  });

  it('P-020: a re-placement that took (unit now held by a LIVE cup) reads healthy, not failed', async () => {
    // Old cup died on F-120; a new live cup re-claimed it.
    await seedCup({ owner: 'cup-dead', featureId: 'F-120', status: 'failed' });
    await seedCup({
      owner: 'cup-live',
      featureId: null,
      status: 'running',
      heartbeatAtMs: NOW - 1000,
      lastOutputAtMs: NOW - 1000,
    });
    await seedUnit({ id: 'F-120', status: 'in_progress', takenBy: 'cup-live' });

    await reconcileOnePot(sql, WS, POT, CFG, NOW);

    expect((await readPlacement('F-120'))?.status).toBe('working');
    expect(mocks.wakeRecipients).not.toHaveBeenCalled();
  });

  it('P-020: a unit that reached terminal → completed (the placement succeeded)', async () => {
    await seedCup({ owner: 'cup-1', featureId: 'F-130', status: 'done' });
    await seedUnit({ id: 'F-130', status: 'passed', takenBy: 'cup-1' });

    await reconcileOnePot(sql, WS, POT, CFG, NOW);

    expect((await readPlacement('F-130'))?.status).toBe('completed');
  });

  it('F-FIX-043: summarizeOpenPlacements does not count a stale working row once the unit is terminal', async () => {
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         cup_owner_id, status, fail_count, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-SUMMARY-DONE', ${POT}, ${MUG},
              'cup-1', 'working', 0, now(), now(), now())`;
    await seedUnit({ id: 'F-SUMMARY-DONE', status: 'passed', takenBy: 'cup-1' });

    const summary = await summarizeOpenPlacements(WS, POT);

    expect(summary.workingTracked).toBe(0);
    expect(summary.items).toEqual([]);
  });

  it('F-FIX-043: summarizeOpenPlacements does not count a stale working row after dead-holder cleanup clears the claim', async () => {
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         cup_owner_id, status, fail_count, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-SUMMARY-CLEARED', ${POT}, ${MUG},
              'cup-dead', 'working', 0, now(), now(), now())`;
    await seedUnit({ id: 'F-SUMMARY-CLEARED', status: 'todo', takenBy: null });

    const summary = await summarizeOpenPlacements(WS, POT);

    expect(summary.workingTracked).toBe(0);
    expect(summary.items).toEqual([]);
  });

  it('mig 529: pot_placements accepts the watchdog parked status `blocked` (EI-6563 write path)', async () => {
    // The parked decision (WI-1439/EI-6563) upserts status 'blocked'. Migration 263's
    // check constraint did not allow it, so ONE parked unit aborted its pot's WHOLE
    // reconcile sweep with a constraint violation and reclaimed items were never
    // re-placed (observed live 2026-07-09, plan pot-auto-loop-working-2026-07-09).
    // 529 extends the enum; this guards the constraint against drifting out from
    // under the code's status vocabulary again.
    await expect(sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         cup_owner_id, status, fail_count, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-PARKED-BLOCKED-STATUS', ${POT}, ${MUG},
              'cup-1', 'blocked', 0, now(), now(), now())`).resolves.toBeDefined();
  });

  it('EI-6650: summarizeOpenPlacements excludes a stale recovering placement once the unit is deliberately parked (blocked/needs-human)', async () => {
    // Mirrors the live-observed bug: a placement row frozen at `recovering` from
    // BEFORE the reconcile-side isUnitParked fix (or simply not yet revisited by a
    // fresh cup-spawn event), whose underlying unit has since been parked `blocked`
    // by an owner/human gate. The Mug brief must stop telling her to re-place it.
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         cup_owner_id, status, fail_count, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-SUMMARY-PARKED-BLOCKED', ${POT}, ${MUG},
              'cup-1', 'recovering', 0, now(), now(), now())`;
    await seedUnit({ id: 'F-SUMMARY-PARKED-BLOCKED', status: 'blocked', takenBy: null });

    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         cup_owner_id, status, fail_count, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-SUMMARY-PARKED-NEEDSHUMAN', ${POT}, ${MUG},
              'cup-1', 'recovering', 0, now(), now(), now())`;
    await seedUnit({ id: 'F-SUMMARY-PARKED-NEEDSHUMAN', status: 'needs-human', takenBy: null });

    const summary = await summarizeOpenPlacements(WS, POT);

    expect(summary.recovering).toBe(0);
    expect(summary.items).toEqual([]);
  });

  it('EI-6650: summarizeOpenPlacements still surfaces a genuinely-active recovering placement (not parked)', async () => {
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         cup_owner_id, status, fail_count, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-SUMMARY-STILL-RECOVERING', ${POT}, ${MUG},
              'cup-1', 'recovering', 0, now(), now(), now())`;
    await seedUnit({ id: 'F-SUMMARY-STILL-RECOVERING', status: 'in_progress', takenBy: null });

    const summary = await summarizeOpenPlacements(WS, POT);

    expect(summary.recovering).toBe(1);
    expect(summary.items).toEqual([
      expect.objectContaining({ workItemId: 'F-SUMMARY-STILL-RECOVERING', status: 'recovering' }),
    ]);
  });

  it('P-021: a unit at the breaker threshold → cursed + an owner escalation, no further wake', async () => {
    // Pre-seed two prior failed placements, past the debounce window.
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         status, fail_count, last_recovery_at, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-200', ${POT}, ${MUG},
              'recovering', 2, ${new Date(NOW - 6 * 60_000)}, now(), ${new Date(NOW)}, now())`;
    await seedCup({ owner: 'cup-2', featureId: 'F-200', status: 'failed' });
    await seedToolCall('cup-2'); // fair attempt → item-pathology loss (not a zombie)
    await seedUnit({ id: 'F-200', status: 'in_progress', takenBy: 'cup-2' });

    const out = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    const p = await readPlacement('F-200');
    expect(p?.status).toBe('cursed');
    expect(p?.fail_count).toBe(3);
    expect(p?.escalation_msg_id).toBe('esc-test');
    expect(out.find((r) => r.workItemId === 'F-200')?.decision).toBe('breaker');
    expect(mocks.openEscalation).toHaveBeenCalledTimes(1);
    expect(mocks.wakeRecipients).not.toHaveBeenCalled(); // breaker STOPS re-placing
  });

  it('WI-233: a reaper-reclaim of a STILL-ALIVE cup at the breaker threshold → recovers, does NOT curse (fail_count held)', async () => {
    // Same shape as the P-021 breaker test (fail_count 2, past the debounce) — but the
    // serving cup was REAPER-reclaimed (error `reclaimed: …`) AND made a governed model
    // call within the activity window (a slow-but-alive false reclaim, the papercup
    // owner-focus cascade). It must re-place WITHOUT counting toward the curse.
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         status, fail_count, last_recovery_at, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-ALIVE', ${POT}, ${MUG},
              'recovering', 2, ${new Date(NOW - 6 * 60_000)}, now(), ${new Date(NOW)}, now())`;
    await seedCup({
      owner: 'cup-alive',
      featureId: 'F-ALIVE',
      status: 'failed',
      errorMessage: 'reclaimed: spawn heartbeat stale > 300s (launching operator host presumed dead)',
    });
    await seedUsageSample('cup-alive', NOW - 60_000); // a model call 1 min ago → demonstrably alive
    await seedUnit({ id: 'F-ALIVE', status: 'in_progress', takenBy: 'cup-alive' });

    const out = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    const p = await readPlacement('F-ALIVE');
    expect(p?.status).toBe('recovering'); // NOT cursed
    expect(p?.fail_count).toBe(2); // HELD FLAT — the false reclaim did not climb to 3
    expect(out.find((r) => r.workItemId === 'F-ALIVE')?.decision).toBe('recover');
    expect(mocks.openEscalation).not.toHaveBeenCalled(); // no curse → no escalation
    expect(mocks.wakeRecipients).toHaveBeenCalledTimes(1); // re-placement wake still fires
  });

  it('WI-233: a reaper-reclaim of a cup with NO recent activity (genuinely wedged/dead) STILL curses — the breaker is intact', async () => {
    // The discriminator: same reclaimed cup, but no agent_usage_samples row → not alive →
    // counts toward the curse as before. Proves the relaxation is liveness-gated, not a
    // blanket "reclaims never curse" (which would let a truly cup-wedging item retry forever).
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         status, fail_count, last_recovery_at, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-DEAD', ${POT}, ${MUG},
              'recovering', 2, ${new Date(NOW - 6 * 60_000)}, now(), ${new Date(NOW)}, now())`;
    await seedCup({
      owner: 'cup-dead',
      featureId: 'F-DEAD',
      status: 'failed',
      errorMessage: 'reclaimed: spawn heartbeat stale > 300s (launching operator host presumed dead)',
    });
    // NO seedUsageSample → no recent model call → genuinely gone.
    await seedToolCall('cup-dead'); // but it DID make a fair attempt (tool calls) before wedging → item-pathology
    await seedUnit({ id: 'F-DEAD', status: 'in_progress', takenBy: 'cup-dead' });

    const out = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    const p = await readPlacement('F-DEAD');
    expect(p?.status).toBe('cursed'); // breaker still trips for a genuinely-gone cup
    expect(p?.fail_count).toBe(3);
    expect(out.find((r) => r.workItemId === 'F-DEAD')?.decision).toBe('breaker');
    expect(mocks.openEscalation).toHaveBeenCalledTimes(1);
  });

  it('F-FIX-041: a loss during an OPERATOR-DORMANCY window does NOT curse — fail_count held, item not false-cursed', async () => {
    // Same shape as the P-021 breaker test (fail_count 2, a GENUINE dead cup — not a reclaim,
    // no usage sample), so it WOULD curse. But this pot's previous sweep (last_seen_at) was
    // 30 min ago — far past the 10-min dormancy grace — so the operator/bg-host was DORMANT in
    // between and this "lost" placement is infra-induced, not item-pathology. The grace re-places
    // it with fail_count held FLAT (the overnight false-curse of tractable items, fixed).
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         status, fail_count, last_recovery_at, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-DORMANT', ${POT}, ${MUG},
              'recovering', 2, ${new Date(NOW - 30 * 60_000)}, now(), ${new Date(NOW - 30 * 60_000)}, now())`;
    await seedCup({ owner: 'cup-dorm', featureId: 'F-DORMANT', status: 'failed' });
    await seedUnit({ id: 'F-DORMANT', status: 'in_progress', takenBy: 'cup-dorm' });

    const out = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    const p = await readPlacement('F-DORMANT');
    expect(p?.status).toBe('recovering'); // NOT cursed
    expect(p?.fail_count).toBe(2); // pathology count HELD — the dormancy-window loss did not climb to 3
    // WI-677 — a post-dormancy (item-INDEPENDENT) loss is FULLY EXEMPT: BOTH counters stay flat,
    // so infra_loss_count holds at 0 (its pre-seeded value). The earlier F-FIX-041 behavior routed
    // it to the bounded infra counter, but that cursed the whole frontier in lockstep on a host
    // restart (all rows climbing to the bound together), so WI-677 exempts it entirely. The bounded
    // infra breaker is now driven ONLY by the per-item zombie signal (see the contrast tests below).
    expect(p?.infra_loss_count).toBe(0); // fully exempt — never accrues toward any breaker
    expect(out.find((r) => r.workItemId === 'F-DORMANT')?.decision).toBe('recover');
    expect(mocks.openEscalation).not.toHaveBeenCalled(); // no curse → no escalation
    // EI-3216 — a dormancy loss is item-independent INFRA: it re-places silently (the recovering
    // row is surfaced in pot:status) but does NOT fire a per-item Mug recovery wake. A host
    // restart fires this for EVERY placement in lockstep, so a wake-per-item was a 32-wake storm.
    expect(mocks.wakeRecipients).not.toHaveBeenCalled();
  });

  it('F-FIX-041 contrast: the SAME loss on a NORMAL-cadence sweep (recent last_seen_at) DOES curse — the gap gates the grace', async () => {
    // Identical to the dormancy case but last_seen_at is recent (operator healthy) → the gap is
    // under the grace → not a post-dormancy sweep → the loss counts → curse. Proves it is the
    // dormancy GAP that grants the grace (item-independent), and a healthy operator's losses
    // still curse — the breaker is not weakened in normal operation.
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         status, fail_count, last_recovery_at, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-HEALTHY', ${POT}, ${MUG},
              'recovering', 2, ${new Date(NOW - 6 * 60_000)}, now(), ${new Date(NOW - 60_000)}, now())`;
    await seedCup({ owner: 'cup-h', featureId: 'F-HEALTHY', status: 'failed' });
    await seedToolCall('cup-h'); // a fair attempt (not a zombie) → an item-pathology loss
    await seedUnit({ id: 'F-HEALTHY', status: 'in_progress', takenBy: 'cup-h' });

    const out = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    const p = await readPlacement('F-HEALTHY');
    expect(p?.status).toBe('cursed'); // operator healthy + fair attempt → the loss counts → breaker trips
    expect(p?.fail_count).toBe(3);
    expect(out.find((r) => r.workItemId === 'F-HEALTHY')?.decision).toBe('breaker');
  });

  it('F-FIX-041: a ZOMBIE cup (0 tool calls) on a healthy operator → bounded infra counter, NOT the pathology curse', async () => {
    // Operator healthy (recent last_seen), but the serving cup made ZERO tool calls (an
    // EI-1758 zombie / booted without MCP tools) — a no-fair-attempt loss. fail_count 2 would
    // curse a pathology loss; a zombie loss routes to the bounded infra counter instead.
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         status, fail_count, last_recovery_at, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-ZOMBIE', ${POT}, ${MUG},
              'recovering', 2, ${new Date(NOW - 6 * 60_000)}, now(), ${new Date(NOW)}, now())`;
    await seedCup({ owner: 'cup-z', featureId: 'F-ZOMBIE', status: 'failed' });
    // NO seedToolCall('cup-z') → 0 tool calls → zombie / no fair attempt.
    await seedUnit({ id: 'F-ZOMBIE', status: 'in_progress', takenBy: 'cup-z' });

    const out = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    const p = await readPlacement('F-ZOMBIE');
    expect(p?.status).toBe('recovering'); // NOT cursed
    expect(p?.fail_count).toBe(2); // pathology count held
    expect(p?.infra_loss_count).toBe(1); // routed to the bounded infra counter
    expect(out.find((r) => r.workItemId === 'F-ZOMBIE')?.decision).toBe('recover');
    expect(mocks.openEscalation).not.toHaveBeenCalled();
    // EI-3216 — a no-fair-attempt zombie loss is INFRA, not item-pathology: re-place silently,
    // NO per-item Mug recovery wake (re-placing just makes another zombie). This is the source
    // of the ~5min Mug wake storm during a fleet-wide no-cups window.
    expect(mocks.wakeRecipients).not.toHaveBeenCalled();
  });

  it('F-FIX-041 BOUND: infra losses STILL curse at the infra breaker threshold (no unbounded retry)', async () => {
    // infra_loss_count one below the threshold + another zombie loss → the BOUNDED infra
    // breaker trips, so even an all-infra (or mis-attributed) item eventually halts — the
    // safety property that makes the per-cup zombie signal safe.
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         status, fail_count, infra_loss_count, last_recovery_at, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-INFRA-MAX', ${POT}, ${MUG},
              'recovering', 0, ${CFG.infraBreakerThreshold - 1}, ${new Date(NOW - 6 * 60_000)}, now(), ${new Date(NOW)}, now())`;
    await seedCup({ owner: 'cup-im', featureId: 'F-INFRA-MAX', status: 'failed' });
    // 0 tool calls → zombie → the threshold-th infra loss.
    await seedUnit({ id: 'F-INFRA-MAX', status: 'in_progress', takenBy: 'cup-im' });

    const out = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    const p = await readPlacement('F-INFRA-MAX');
    expect(p?.status).toBe('cursed'); // bounded — infra losses DO eventually curse
    expect(p?.infra_loss_count).toBe(CFG.infraBreakerThreshold);
    expect(p?.fail_count).toBe(0); // the "failed 0×" case — cursed via the infra breaker, not pathology
    expect(out.find((r) => r.workItemId === 'F-INFRA-MAX')?.decision).toBe('breaker');
    // EI-3216 — an INFRA-attributed curse (fail_count=0) records `cursed` for the health metric
    // but does NOT open a per-item owner escalation: a "failed 0× — stopped auto-re-placing"
    // advisory is queue noise the owner can't act on per item (the 32-row flood this fixes).
    // Only a genuine item-PATHOLOGY curse (the F-200/F-HEALTHY tests) escalates.
    expect(mocks.openEscalation).not.toHaveBeenCalled();
    expect(mocks.wakeRecipients).not.toHaveBeenCalled(); // a breaker never re-places/wakes either
  });

  it('EI-865: an already-cursed item is LATCHED on re-sweep — failCount frozen, no re-escalation, no wake', async () => {
    // Pre-seed the unit ALREADY cursed at the breaker count (the breaker tripped on a
    // prior sweep). The bug: every later sweep re-entered the breaker, re-escalated,
    // and bumped fail_count without bound (356→460). The latch must HALT all of that.
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         status, fail_count, escalation_msg_id, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-CURSED', ${POT}, ${MUG},
              'cursed', 3, 'esc-prior', now(), now(), now())`;
    await seedCup({ owner: 'cup-c', featureId: 'F-CURSED', status: 'failed' }); // still dead, still not terminal
    await seedUnit({ id: 'F-CURSED', status: 'in_progress', takenBy: 'cup-c' });

    const out = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    const p = await readPlacement('F-CURSED');
    expect(p?.status).toBe('cursed'); // still cursed
    expect(p?.fail_count).toBe(3); // FROZEN — does not climb (the 356→460 bug)
    expect(p?.escalation_msg_id).toBe('esc-prior'); // the original escalation, NOT a new one
    expect(out.find((r) => r.workItemId === 'F-CURSED')?.decision).toBe('latched');
    expect(mocks.openEscalation).not.toHaveBeenCalled(); // no re-escalation
    expect(mocks.wakeRecipients).not.toHaveBeenCalled(); // no re-placement wake
  });

  it('EI-865: the curse CLEARS when the cursed unit finally reaches terminal (completed)', async () => {
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         status, fail_count, escalation_msg_id, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-CURED', ${POT}, ${MUG},
              'cursed', 3, 'esc-prior', now(), now(), now())`;
    await seedCup({ owner: 'cup-d', featureId: 'F-CURED', status: 'done' });
    await seedUnit({ id: 'F-CURED', status: 'passed', takenBy: 'cup-d' }); // re-placed + finally done

    await reconcileOnePot(sql, WS, POT, CFG, NOW);

    expect((await readPlacement('F-CURED'))?.status).toBe('completed'); // latch released
    // EI-972: the cursed escalation should be suppressed when the item reaches terminal state
    expect(mocks.resolveEscalation).toHaveBeenCalledTimes(1);
    expect(mocks.resolveEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        msg_id: 'esc-prior',
        choice: 'item-now-terminal',
        resolver: 'system:pot-placement-watchdog',
      }),
    );
  });

  it('EI-972: suppress cursed escalation when the work item is already in a terminal state', async () => {
    // Scenario: a unit was cursed (escalation fired), but then reached a terminal state
    // through independent action (e.g., a cup completed it). On the next sweep, the
    // escalation should be suppressed since the item is now terminal and no longer needs
    // the cursed advisory.
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         status, fail_count, escalation_msg_id, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-CURED-2', ${POT}, ${MUG},
              'cursed', 3, 'esc-cursed', now(), now(), now())`;
    // A cup completed it independently (the scenario): seed the `done` cup so the unit
    // is discovered as a placement candidate, then the cursed escalation is suppressed.
    // (Pre-existing test gap, unrelated to WI-233: the unit reached terminal but no cup
    // was seeded, so candidate discovery never picked it up and it stayed cursed.)
    await seedCup({ owner: 'cup-e', featureId: 'F-CURED-2', status: 'done' });
    await seedUnit({ id: 'F-CURED-2', status: 'passed', takenBy: 'cup-e' });

    const out = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    // The placement should transition to completed
    expect((await readPlacement('F-CURED-2'))?.status).toBe('completed');
    // The cursed escalation should be suppressed
    expect(mocks.resolveEscalation).toHaveBeenCalledTimes(1);
    expect(mocks.resolveEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        msg_id: 'esc-cursed',
        choice: 'item-now-terminal',
      }),
    );
    expect(out.find((r) => r.workItemId === 'F-CURED-2')?.decision).toBe('completed');
  });

  it('EI-1524: backstop GC closes a cursed escalation when its unit went terminal with NO cup re-anchoring it', async () => {
    // The exact gap the per-candidate suppression misses (cf. the EI-972 test's note):
    // a cursed item reaches terminal but no live cup anchors it, so it is NOT a
    // placement candidate this sweep. Without the backstop its escalation leaks forever
    // (the ~13k stale residue). NO cup is seeded here — the per-candidate path can't run.
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         status, fail_count, escalation_msg_id, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-STALE', ${POT}, ${MUG},
              'cursed', 3, 'esc-stale', now(), now(), now())`;
    await seedUnit({ id: 'F-STALE', status: 'deprecated' }); // terminal, no cup

    const out = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    expect((await readPlacement('F-STALE'))?.status).toBe('completed');
    expect(mocks.resolveEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        msg_id: 'esc-stale',
        choice: 'item-now-terminal',
        resolver: 'system:pot-placement-watchdog',
      }),
    );
    expect(out.find((r) => r.workItemId === 'F-STALE')?.decision).toBe('completed');
  });

  it('EI-1524: backstop GC also closes a STRANDED escalation once its blocker reaches terminal', async () => {
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         status, fail_count, escalation_msg_id, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-STRAND', ${POT}, ${MUG},
              'stranded', 0, 'esc-strand', now(), now(), now())`;
    await seedUnit({ id: 'F-STRAND', status: 'resolved' }); // blocker now terminal

    await reconcileOnePot(sql, WS, POT, CFG, NOW);

    expect((await readPlacement('F-STRAND'))?.status).toBe('completed');
    expect(mocks.resolveEscalation).toHaveBeenCalledWith(expect.objectContaining({ msg_id: 'esc-strand' }));
  });

  it('EI-1524: backstop GC abandons a cursed escalation whose unit no longer exists', async () => {
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         status, fail_count, escalation_msg_id, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-GONE', ${POT}, ${MUG},
              'cursed', 3, 'esc-gone', now(), now(), now())`;
    // No unit row seeded — the item was hard-retired.

    const out = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    expect((await readPlacement('F-GONE'))?.status).toBe('abandoned');
    expect(mocks.resolveEscalation).toHaveBeenCalledWith(expect.objectContaining({ msg_id: 'esc-gone' }));
    expect(out.find((r) => r.workItemId === 'F-GONE')?.decision).toBe('abandon');
  });

  it('EI-1524: backstop GC LEAVES a genuinely-open cursed escalation (unit non-terminal) untouched', async () => {
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         status, fail_count, escalation_msg_id, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-OPEN', ${POT}, ${MUG},
              'cursed', 3, 'esc-open', now(), now(), now())`;
    await seedUnit({ id: 'F-OPEN', status: 'failing' }); // still cursed, no cup, not terminal

    await reconcileOnePot(sql, WS, POT, CFG, NOW);

    expect((await readPlacement('F-OPEN'))?.status).toBe('cursed'); // untouched
    expect(mocks.resolveEscalation).not.toHaveBeenCalled();
  });

  it('EI-6109: a stale WORKING placement (no escalation, no live cup) whose unit went terminal converges to completed', async () => {
    // The exact reported drift: pot_placements kept a WORKING lane whose work-item had
    // long since completed, because the per-candidate sweep never revisits a row once its
    // serving cup dies / ages out (nothing re-anchors it) AND the EI-1524 escalation-only
    // GC skipped it (escalation_msg_id IS NULL). NO cup + NO escalation here — only the
    // EI-6109 completion-reconcile GC can converge it.
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         status, fail_count, escalation_msg_id, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-DRIFT-WORKING', ${POT}, ${MUG},
              'working', 0, NULL, now(), now(), now())`;
    await seedUnit({ id: 'F-DRIFT-WORKING', status: 'passed' }); // terminal, dead-holder gone

    const out = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    // Durable row leaves the OPEN set (pot:status / summarizeOpenPlacements stop counting it).
    expect((await readPlacement('F-DRIFT-WORKING'))?.status).toBe('completed');
    expect(out.find((r) => r.workItemId === 'F-DRIFT-WORKING')?.decision).toBe('completed');
    // A working row carries no advisory, so nothing is resolved (only the status converges).
    expect(mocks.resolveEscalation).not.toHaveBeenCalled();
  });

  it('EI-6109: a stale RECOVERING placement (no escalation, no live cup) whose unit was retired converges to abandoned', async () => {
    await sql`
      INSERT INTO harness_shared.pot_placements
        (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
         status, fail_count, escalation_msg_id, placed_at, last_seen_at, updated_at)
      VALUES (${WS}, ${POT}, 'F-DRIFT-GONE', ${POT}, ${MUG},
              'recovering', 1, NULL, now(), now(), now())`;
    // No unit row seeded — the work-item was hard-retired while the lane still read recovering.

    const out = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    expect((await readPlacement('F-DRIFT-GONE'))?.status).toBe('abandoned');
    expect(out.find((r) => r.workItemId === 'F-DRIFT-GONE')?.decision).toBe('abandon');
    expect(mocks.resolveEscalation).not.toHaveBeenCalled();
  });

  it('P-022: a stuck failing blocker gating a non-terminal downstream → stranded + one escalation', async () => {
    await seedUnit({ id: 'F-300', status: 'failing' }); // the stuck blocker
    await seedUnit({ id: 'F-301', status: 'todo' }); // the gated downstream
    await sql`
      INSERT INTO harness_shared.work_item_deps (workspace_id, blocker_kind, blocker_ref, blocked_kind, blocked_ref, dep_type)
      VALUES ('default', 'feature', ${POT + '#F-300'}, 'feature', ${POT + '#F-301'}, 'blocks')`;

    const out = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    const p = await readPlacement('F-300');
    expect(p?.status).toBe('stranded');
    expect(p?.escalation_msg_id).toBe('esc-test');
    expect(out.find((r) => r.workItemId === 'F-300')?.decision).toBe('stranded');
    expect(mocks.openEscalation).toHaveBeenCalledTimes(1);
  });

  it('P-022: a stuck blocker gating ONLY terminal downstream is NOT stranded (nothing to un-gate)', async () => {
    await seedUnit({ id: 'F-310', status: 'failing' });
    await seedUnit({ id: 'F-311', status: 'passed' }); // already terminal
    await sql`
      INSERT INTO harness_shared.work_item_deps (workspace_id, blocker_kind, blocker_ref, blocked_kind, blocked_ref, dep_type)
      VALUES ('default', 'feature', ${POT + '#F-310'}, 'feature', ${POT + '#F-311'}, 'blocks')`;

    await reconcileOnePot(sql, WS, POT, CFG, NOW);

    expect(await readPlacement('F-310')).toBeNull();
    expect(mocks.openEscalation).not.toHaveBeenCalled();
  });

  it('P-032: a COMPLETED blocker gating a non-terminal downstream → ONE unblock wake to the Mug', async () => {
    // tier1 completed (passed); tier2 still todo and blocked_by tier1 — now un-gated.
    await seedCup({ owner: 'cup-1', featureId: 'F-500', status: 'done' });
    await seedUnit({ id: 'F-500', status: 'passed', takenBy: 'cup-1' });
    await seedUnit({ id: 'F-501', status: 'todo' });
    await sql`
      INSERT INTO harness_shared.work_item_deps (workspace_id, blocker_kind, blocker_ref, blocked_kind, blocked_ref, dep_type)
      VALUES ('default', 'feature', ${POT + '#F-500'}, 'feature', ${POT + '#F-501'}, 'blocks')`;

    const out = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    expect((await readPlacement('F-500'))?.status).toBe('completed');
    expect(out.find((r) => r.workItemId === 'F-500' && r.decision === 'unblocked')?.detail).toBe('1 downstream');
    expect(mocks.wakeRecipients).toHaveBeenCalledTimes(1);
    expect(mocks.wakeRecipients.mock.calls[0]![0]).toEqual([MUG]);
    const opts = mocks.wakeRecipients.mock.calls[0]![1] as unknown as { payload?: { kind?: string } };
    expect(opts.payload?.kind).toBe('placement-unblocked');
  });

  it('P-032: a completed lane gating ONLY terminal downstream fires NO unblock wake', async () => {
    await seedCup({ owner: 'cup-1', featureId: 'F-510', status: 'done' });
    await seedUnit({ id: 'F-510', status: 'passed', takenBy: 'cup-1' });
    await seedUnit({ id: 'F-511', status: 'passed' }); // downstream already terminal
    await sql`
      INSERT INTO harness_shared.work_item_deps (workspace_id, blocker_kind, blocker_ref, blocked_kind, blocked_ref, dep_type)
      VALUES ('default', 'feature', ${POT + '#F-510'}, 'feature', ${POT + '#F-511'}, 'blocks')`;

    const out = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    expect((await readPlacement('F-510'))?.status).toBe('completed');
    expect(out.find((r) => r.decision === 'unblocked')).toBeUndefined();
    expect(mocks.wakeRecipients).not.toHaveBeenCalled();
  });

  it('P-032: the unblock wake fires only ONCE — a re-sweep of an already-completed lane is silent', async () => {
    await seedCup({ owner: 'cup-1', featureId: 'F-520', status: 'done' });
    await seedUnit({ id: 'F-520', status: 'passed', takenBy: 'cup-1' });
    await seedUnit({ id: 'F-521', status: 'todo' });
    await sql`
      INSERT INTO harness_shared.work_item_deps (workspace_id, blocker_kind, blocker_ref, blocked_kind, blocked_ref, dep_type)
      VALUES ('default', 'feature', ${POT + '#F-520'}, 'feature', ${POT + '#F-521'}, 'blocks')`;

    await reconcileOnePot(sql, WS, POT, CFG, NOW); // first sweep records completed + wakes
    expect(mocks.wakeRecipients).toHaveBeenCalledTimes(1);
    mocks.wakeRecipients.mockClear();
    await reconcileOnePot(sql, WS, POT, CFG, NOW); // already completed → no re-wake

    expect(mocks.wakeRecipients).not.toHaveBeenCalled();
  });

  it('returns no placements + no side effects when the pot has no resolvable Mug session', async () => {
    await sql`TRUNCATE harness_shared.adv_sessions `; // no mug owner to attribute cups / wake
    await seedCup({ owner: 'cup-x', featureId: 'F-400', status: 'failed' });
    await seedUnit({ id: 'F-400', status: 'in_progress', takenBy: 'cup-x' });

    const out = await reconcileOnePot(sql, WS, POT, CFG, NOW);

    expect(out).toEqual([]);
    expect(mocks.wakeRecipients).not.toHaveBeenCalled();
  });
});
