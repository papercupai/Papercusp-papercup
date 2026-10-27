/**
 * collectRoutineStarvationSignals (WI-6554700010029793) against a REAL migrated Postgres
 * (testcontainer). The predicate under test: an ACTIVE routine whose next_fire_at is older
 * than max(30min, its loop interval) while ANOTHER routine in the same workspace fired after
 * it came due. That is the 2026-10-26 shape (EI-27084758447422793): the pool-shed floor
 * skipped the pr-drill green-checkpoint for ~100min while critical routines kept firing, and
 * routine-engine-death (every routine overdue) could not see it.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/improvements/routine-starvation.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { collectRoutineStarvationSignals } from './watchdog';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-routine-starvation';
const OTHER_WS = 'ws-routine-starvation-other';
const HARNESS = 'papercusp-pr-drill-20261014';
const MIN = 60_000;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});
afterAll(async () => {
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id IN (${WS}, ${OTHER_WS})`;
  await sql`DELETE FROM harness_shared.routine_pool_shed_events WHERE workspace_id IN (${WS}, ${OTHER_WS})`;
});

interface Seed {
  id: string;
  workspace?: string;
  active?: boolean;
  /** Minutes from now; negative = in the past. 'infinity' = parked loop. null = unscheduled. */
  nextFireInMin: number | 'infinity' | null;
  /** Minutes ago; null = never fired. */
  lastFiredMinAgo?: number | null;
  intervalSec?: number | null;
}

async function seed(s: Seed): Promise<void> {
  const now = Date.now();
  const next =
    s.nextFireInMin === 'infinity' ? 'infinity' : s.nextFireInMin === null ? null : new Date(now + s.nextFireInMin * MIN).toISOString();
  const last = s.lastFiredMinAgo == null ? null : new Date(now - s.lastFiredMinAgo * MIN).toISOString();
  const interval = s.intervalSec ?? null;
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id,
       metadata, next_fire_at, last_fired_at, reschedule_interval_sec, target_owner_id)
    VALUES (
      ${s.id}, ${HARNESS}, ${s.id}, 'cron', '{}'::jsonb, 'system:green-checkpoint', ${s.active ?? true},
      ${s.workspace ?? WS}, '{}'::jsonb, ${next}::timestamptz, ${last}::timestamptz, ${interval},
      ${interval === null ? null : 'su-starvation-test'}
    )`;
}

/** A routine that fired 2 minutes ago and is next due in 10: the proof the engine is alive. */
async function seedHealthy(id = 'rt-healthy', workspace = WS): Promise<void> {
  await seed({ id, workspace, nextFireInMin: 10, lastFiredMinAgo: 2 });
}

async function keys(workspace = WS): Promise<string[]> {
  return (await collectRoutineStarvationSignals(sql, workspace)).map((s) => s.key).sort();
}

describe('collectRoutineStarvationSignals (real PG)', () => {
  it('flags the one starved routine while the engine fires another, and not the healthy one', async () => {
    await seed({ id: 'rt-starved', nextFireInMin: -100, lastFiredMinAgo: 160 });
    await seedHealthy();
    expect(await keys()).toEqual([`routine-starvation:${HARNESS}:rt-starved`]);
  });

  it('stays quiet when NO other routine fired since it came due (engine death is not starvation)', async () => {
    await seed({ id: 'rt-a', nextFireInMin: -100, lastFiredMinAgo: 160 });
    await seed({ id: 'rt-b', nextFireInMin: -90, lastFiredMinAgo: 150 });
    expect(await keys()).toEqual([]);
  });

  it('does not flag a routine overdue by less than the 30min bound', async () => {
    await seed({ id: 'rt-late', nextFireInMin: -20, lastFiredMinAgo: 80 });
    await seedHealthy();
    expect(await keys()).toEqual([]);
  });

  it('uses the loop interval as the bound when it exceeds 30min', async () => {
    // 45min overdue on a 60min loop: inside one interval, so not starved.
    await seed({ id: 'rt-loop-ok', nextFireInMin: -45, lastFiredMinAgo: 105, intervalSec: 3600 });
    // 70min overdue on a 60min loop: past one interval.
    await seed({ id: 'rt-loop-starved', nextFireInMin: -70, lastFiredMinAgo: 130, intervalSec: 3600 });
    await seedHealthy();
    expect(await keys()).toEqual([`routine-starvation:${HARNESS}:rt-loop-starved`]);
  });

  it('ignores parked loops, unscheduled and inactive routines', async () => {
    await seed({ id: 'rt-parked', nextFireInMin: 'infinity', lastFiredMinAgo: 300, intervalSec: 600 });
    await seed({ id: 'rt-unscheduled', nextFireInMin: null, lastFiredMinAgo: 300 });
    await seed({ id: 'rt-inactive', active: false, nextFireInMin: -300, lastFiredMinAgo: 400 });
    await seedHealthy();
    expect(await keys()).toEqual([]);
  });

  it('is scoped to its own workspace: another tenant neither starves nor vouches', async () => {
    // A starved routine whose only "engine alive" proof is in ANOTHER workspace.
    await seed({ id: 'rt-starved', nextFireInMin: -100, lastFiredMinAgo: 160 });
    await seedHealthy('rt-other-healthy', OTHER_WS);
    // And a genuinely starved routine in the other workspace.
    await seed({ id: 'rt-other-starved', workspace: OTHER_WS, nextFireInMin: -100, lastFiredMinAgo: 160 });
    expect(await keys(WS)).toEqual([]);
    expect(await keys(OTHER_WS)).toEqual([`routine-starvation:${HARNESS}:rt-other-starved`]);
  });

  it('reports pool-shed events recorded since the routine came due as context', async () => {
    await seed({ id: 'rt-starved', nextFireInMin: -100, lastFiredMinAgo: 160 });
    await seedHealthy();
    const now = Date.now();
    for (const [minAgo, count] of [
      [200, 50], // before it came due: not counted
      [60, 3],
      [10, 4],
    ] as const) {
      await sql`
        INSERT INTO harness_shared.routine_pool_shed_events (workspace_id, at, shed_count, probe_ms, host)
        VALUES (${WS}, ${new Date(now - minAgo * MIN).toISOString()}::timestamptz, ${count}, 5, 'test-host')`;
    }
    const [sig] = await collectRoutineStarvationSignals(sql, WS);
    expect(sig.body).toContain('recorded 7 shed routine fire(s)');
  });
});
