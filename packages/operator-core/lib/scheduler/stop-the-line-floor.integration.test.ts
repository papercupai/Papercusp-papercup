/**
 * stop-the-line-floor.integration.test.ts — P-013/D-012 of
 * gate-verdict-liveness-and-repair-reliability-2026-08-31: while a harness's
 * `gate-red-streak:<harness>` condition item has been OPEN for more than
 * STOP_THE_LINE_RED_HOURS, non-repair rows are not SELF-SELECTABLE on that harness —
 * and repair keeps flowing (ordinary bugs + alarm-condition items exempt). The two
 * LIVE_GATE_OPS singletons are a narrower exception: they are explicit-ID only so a
 * generic repair fleet cannot contest the registered live gate fixer.
 *
 * What only a real database can prove, asserted against BOTH sides of the anti-drift
 * contract (the same both-sides shape as claim-respects-blocking.integration.test.ts):
 *
 *   1. PREVIEW — aggregateIssueClaimExclusions counts the `stopTheLine` bucket and
 *      listIssueClaimableRows drops the throttled row (the shared subquery's
 *      ok_stop_line leg).
 *   2. CLAIM DOOR — claimNextIssueWorkItem (the real issue self-select UPDATE, which
 *      hand-ANDs individual floor fragments) refuses the same rows the preview refuses.
 *   3. FEATURE FAMILY — claimNextWorkItem (claimFloorsWhereSql) pauses feature
 *      self-select on the harness entirely while the line is stopped.
 *   4. The trigger is the condition item's AGE + OPENNESS: 23h-old ⇒ no throttle;
 *      terminal ⇒ no throttle (settling the item IS the kill-switch, D-012);
 *      another harness is never affected.
 *
 * Real Postgres (testcontainer; Docker required).
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/stop-the-line-floor.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { fileURLToPath } from 'node:url';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  SUBSTRATE_OUTBOX_DDL,
  applyClaimPathReadDeps,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const { aggregateIssueClaimExclusions, listIssueClaimableRows } = await import('./get-next');
const { claimNextIssueWorkItem, claimNextWorkItem, claimWorkItem } = await import('../work-items');
const { STOP_THE_LINE_RED_HOURS, stopTheLineExclusionSql } = await import('../work-items-admission');
const { greenMainSloConditionKey } = await import('../release/green-main-slo-watchdog');

const H = 'papercup';
const H2 = 'other-harness';
const WS = 'default';
const HOUR_MS = 3_600_000;
let db: FreshPgDb;

/** Seed one work_items row (either family) with explicit kind/harness/condition/age. */
async function seedRow(
  id: string,
  opts: {
    itemKind: 'bug' | 'change' | 'task' | 'feature';
    harness?: string;
    status?: string;
    conditionKey?: string;
    createdAgoMs?: number;
  },
) {
  const createdTs = Date.now() - (opts.createdAgoMs ?? 0);
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, workspace_id, origin,
       created_ts, updated_ts, title, condition_key)
    VALUES (${opts.harness ?? H}, ${id}, ${opts.itemKind}, ${opts.status ?? 'open'}, ${WS}, 'local',
            ${createdTs}, 0, ${'t ' + id}, ${opts.conditionKey ?? null})`;
}

/** The open red-streak condition item that arms the throttle for `harness`. */
async function seedRedStreakCondition(opts: { ageMs: number; status?: string; harness?: string }) {
  const harness = opts.harness ?? H;
  await seedRow(`WI-STL-${harness}`, {
    itemKind: 'bug',
    harness,
    status: opts.status ?? 'open',
    conditionKey: `gate-red-streak:${harness}`,
    createdAgoMs: opts.ageMs,
  });
}

beforeAll(async () => {
  db = await createFreshPgDb('stop-the-line-floor');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  // Use the production singleton index for the probe-plan recurrence guard.
  await applyMigrationForTest(
    db.sql,
    fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/741-work-items-condition-key-singleton.sql', import.meta.url)),
  );
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(SUBSTRATE_OUTBOX_DDL).simple();
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  // The explicit by-id assertion auto-subscribes the gate fixer to the item.
  await ensureCoordCapabilityTables(db.sql);
  await db.sql
    .unsafe(
      `ALTER TABLE harness_shared.work_items
         ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`,
    )
    .simple();
}, 90_000);
afterAll(async () => {
  await db?.cleanup?.();
});
beforeEach(async () => {
  // SCHEDULER_ISSUES_CLAIMABLE off: the FEATURE FAMILY case asserts the feature door in
  // isolation — with tier-3 on, claimNextWorkItem correctly falls through to the issue
  // family and serves the EXEMPT repair bug (the red-streak condition item itself), which
  // is the intended live behavior but not the door under test.
  setFlagOverridesForTest({
    [FLAGS.SCHEDULER_MAINTAINED_READY]: false,
    [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: false,
  });
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
});
afterEach(() => setFlagOverridesForTest({}));

const AGE_ACTIVE = (STOP_THE_LINE_RED_HOURS + 1) * HOUR_MS; // 25h — over the threshold
const AGE_FRESH = (STOP_THE_LINE_RED_HOURS - 1) * HOUR_MS; // 23h — under it

describe('P-013/D-012 — stop-the-line claim floor', () => {
  it('bounds both family probes by the complete condition singleton key', async () => {
    // Many unrelated conditions made the old correlated row-expression scan the
    // whole harness thousands of times before returning a scheduler candidate.
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, origin,
         created_ts, updated_ts, title, condition_key)
      SELECT ${WS}, ${H}, 'WI-NOISE-' || n, 'task', 'open', 'local', 0, 0,
             'unrelated condition', 'unrelated:' || n
        FROM generate_series(1, 4000) n`;
    await seedRow('WI-CANDIDATE', { itemKind: 'change' });
    await seedRow('F-CANDIDATE', { itemKind: 'feature' });
    await db.sql`ANALYZE harness_shared.work_items`;

    type PlanNode = { Alias?: string; 'Index Cond'?: string; Plans?: PlanNode[] };
    const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
    for (const context of ['issue-wi', 'feature-consolidated'] as const) {
      const relation = context === 'issue-wi'
        ? db.sql`harness_shared.work_items wi`
        : db.sql`harness_shared.harness_features_consolidated`;
      const id = context === 'issue-wi' ? 'WI-CANDIDATE' : 'F-CANDIDATE';
      const rows = await db.sql<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>`
        EXPLAIN (FORMAT JSON)
        SELECT feature_id, ${stopTheLineExclusionSql(db.sql, context)} AS survives
          FROM ${relation}
         WHERE workspace_id = ${WS} AND harness_slug = ${H} AND feature_id = ${id}`;
      const probes = nodes(rows[0]['QUERY PLAN'][0].Plan).filter((node) => node.Alias === 'stl');
      expect(probes, context).toHaveLength(1);
      // Assert the indexed bound rather than a wall-clock limit or planner cost.
      expect(probes[0]['Index Cond'], context).toContain('condition_key =');
    }
  });

  it('PREVIEW: >24h open red-streak throttles non-repair rows, exempts bugs + alarm conditions', async () => {
    await seedRedStreakCondition({ ageMs: AGE_ACTIVE });
    await seedRow('WI-CHANGE', { itemKind: 'change' });
    await seedRow('WI-TASK', { itemKind: 'task' });
    await seedRow('WI-BUG', { itemKind: 'bug' });
    // The prefix leg, independent of the bug exemption: a CHANGE that is itself an
    // alarm-condition item (P-015's deploy-parity is filed directly, outside the bridge).
    await seedRow('WI-PARITY', { itemKind: 'change', conditionKey: `deploy-parity:${H}` });
    // NOT exempt: an ordinary work-flow condition item (plan-promotion inflow).
    await seedRow('WI-PROMO', { itemKind: 'change', conditionKey: `plan-promotion:${WS}/${H}/some-plan/P-001` });

    const out = await aggregateIssueClaimExclusions(undefined, { harness: H });
    // Throttled: the plain change, the task, and the plan-promotion condition change.
    expect(out.excluded.stopTheLine).toBe(3);
    // The red-streak singleton is repair work, but exclusively owned LIVE_GATE_OPS:
    // visible in the pool and explainable under its own floor, never self-selected.
    expect(out.excluded.liveGateOps).toBe(1);
    const rows = await listIssueClaimableRows(undefined, { harness: H }, 50);
    const ids = rows.map((r) => r.id).sort();
    // Claimable: the ordinary bug and deploy-parity condition change. The red-streak
    // singleton is deliberately absent; its registered fixer uses the by-id door.
    expect(ids).toEqual(['WI-BUG', 'WI-PARITY'].sort());
  });

  it('CLAIM DOOR: claimNextIssueWorkItem refuses exactly what the preview refuses', async () => {
    await seedRedStreakCondition({ ageMs: AGE_ACTIVE });
    await seedRow('WI-CHANGE', { itemKind: 'change' });
    await seedRow('WI-BUG', { itemKind: 'bug' });

    const filter = { harness: H, assignee: 'su-test' } as Parameters<typeof claimNextIssueWorkItem>[0];
    const first = await claimNextIssueWorkItem(filter, WS);
    const second = await claimNextIssueWorkItem(filter, WS);
    const third = await claimNextIssueWorkItem(filter, WS);
    const served = [first, second, third].filter((r) => r != null).map((r) => r!.id);
    // Only the ordinary repair bug is served; neither the plain change nor the
    // exclusively owned red-streak singleton circulates through self-select.
    expect(served).toEqual(['WI-BUG']);
    expect(served).not.toContain('WI-CHANGE');
    expect(served).not.toContain(`WI-STL-${H}`);
    expect(second).toBeNull();
    expect(third).toBeNull();
  });

  it('LIVE_GATE_OPS: green-stall is explicit-ID only while ordinary repair bugs flow', async () => {
    await seedRow('WI-GREEN-STALL', {
      itemKind: 'bug',
      conditionKey: `green-stall:${H}`,
    });
    await seedRow('WI-BUG', { itemKind: 'bug' });

    const out = await aggregateIssueClaimExclusions(undefined, { harness: H });
    expect(out.excluded.liveGateOps).toBe(1);
    expect((await listIssueClaimableRows(undefined, { harness: H }, 50)).map((r) => r.id)).toEqual(['WI-BUG']);

    const filter = { harness: H, assignee: 'su-generic' } as Parameters<typeof claimNextIssueWorkItem>[0];
    expect((await claimNextIssueWorkItem(filter, WS))?.id).toBe('WI-BUG');
    expect(await claimNextIssueWorkItem(filter, WS)).toBeNull();

    // The floor governs self-select only: after ownership is checked, the registered
    // gate fixer still acquires the singleton through the named by-id path.
    expect((await claimWorkItem('WI-GREEN-STALL', 'su-gate-fixer', { harness: H }))?.id).toBe('WI-GREEN-STALL');
  });

  it('LIVE_GATE_OPS: live-gate green-main-slo alarms are explicit-ID only; per-sync alarms still flow (EI-27062367026577459)', async () => {
    // Real watchdog keys. The encoded key contains `%`, which LIKE would otherwise read as a wildcard.
    const scope = { workspaceId: WS, installSlug: H };
    await seedRow('WI-SLO-RED-ADD', {
      itemKind: 'bug',
      conditionKey: greenMainSloConditionKey(scope, 'red-adding-admission', `green-main-slo:${H}:red-adding-admission:55bbd`, '4a0ab7'),
    });
    await seedRow('WI-SLO-ROUND', {
      itemKind: 'bug',
      conditionKey: greenMainSloConditionKey(scope, 'round-cycle-time', `green-main-slo:${H}:round-cycle-time:0a16:2`, '0a16'),
    });
    // Ordinary repair: a sync fleet's red rate, whose subject happens to spell a reserved metric.
    await seedRow('WI-SLO-SYNC', {
      itemKind: 'bug',
      conditionKey: greenMainSloConditionKey(scope, 'per-sync-red-rate', `green-main-slo:${H}:per-sync-red-rate:queue-idle:20387`, 'queue-idle'),
    });

    const out = await aggregateIssueClaimExclusions(undefined, { harness: H });
    expect(out.excluded.liveGateOps).toBe(2);
    expect((await listIssueClaimableRows(undefined, { harness: H }, 50)).map((r) => r.id)).toEqual(['WI-SLO-SYNC']);

    const filter = { harness: H, assignee: 'su-generic' } as Parameters<typeof claimNextIssueWorkItem>[0];
    expect((await claimNextIssueWorkItem(filter, WS))?.id).toBe('WI-SLO-SYNC');
    expect(await claimNextIssueWorkItem(filter, WS)).toBeNull();

    expect((await claimWorkItem('WI-SLO-RED-ADD', 'su-gate-fixer', { harness: H }))?.id).toBe('WI-SLO-RED-ADD');
  });

  it('FEATURE FAMILY: feature self-select pauses while active, resumes when the item settles', async () => {
    await seedRedStreakCondition({ ageMs: AGE_ACTIVE });
    await seedRow('F-1', { itemKind: 'feature' });

    const filter = { harness: H, assignee: 'su-test' } as Parameters<typeof claimNextWorkItem>[0];
    expect(await claimNextWorkItem(filter)).toBeNull();

    // Settling the condition item IS the kill-switch (D-012): terminal ⇒ throttle lifts.
    await db.sql`
      UPDATE harness_shared.work_items SET status = 'resolved'
       WHERE feature_id = ${`WI-STL-${H}`} AND workspace_id = ${WS}`;
    const claimed = await claimNextWorkItem(filter);
    expect(claimed?.id).toBe('F-1');
  });

  it('BOUNDARY: a red streak under the threshold does not throttle', async () => {
    await seedRedStreakCondition({ ageMs: AGE_FRESH });
    await seedRow('WI-CHANGE', { itemKind: 'change' });

    const out = await aggregateIssueClaimExclusions(undefined, { harness: H });
    expect(out.excluded.stopTheLine).toBe(0);
    const rows = await listIssueClaimableRows(undefined, { harness: H }, 50);
    expect(rows.map((r) => r.id)).toContain('WI-CHANGE');
  });

  it('TERMINAL: a settled red-streak item never throttles, however old', async () => {
    await seedRedStreakCondition({ ageMs: AGE_ACTIVE, status: 'resolved' });
    await seedRow('WI-CHANGE', { itemKind: 'change' });

    const out = await aggregateIssueClaimExclusions(undefined, { harness: H });
    expect(out.excluded.stopTheLine).toBe(0);
  });

  it('SCOPE: only the affected harness throttles', async () => {
    await seedRedStreakCondition({ ageMs: AGE_ACTIVE, harness: H });
    await seedRow('WI-OTHER-CHANGE', { itemKind: 'change', harness: H2 });

    const out = await aggregateIssueClaimExclusions(undefined, { harness: H2 });
    expect(out.excluded.stopTheLine).toBe(0);
    const rows = await listIssueClaimableRows(undefined, { harness: H2 }, 50);
    expect(rows.map((r) => r.id)).toContain('WI-OTHER-CHANGE');
  });
});
