/**
 * claim.integration.test.ts — claimDueRoutine, the atomic routine-claim primitive,
 * against a real Postgres.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - a recurring (cron/rrule) routine is claimed ONLY when active + due
 *    (next_fire_at IS NULL OR <= now()); the claim advances next_fire_at, so a
 *    second racing claim sees not-due and loses;
 *  - a ONE-SHOT (no recurrence) claim DEACTIVATES the routine (active=FALSE), not
 *    just nulls next_fire_at (which would refire forever);
 *  - EI-1371: claiming a `plan-schedule-<slug>` one-shot ALSO un-arms the owning
 *    plan (harness_plans.schedule_active=FALSE) — the two-write.
 *  - EI-1387: claiming a RECURRING `plan-schedule-<slug>` routine whose owning plan's
 *    expires_at is in the past DEACTIVATES it (and un-arms the plan) instead of
 *    advancing next_fire_at, and reports NOT claimed (no fire for the expired tick).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual };
});
// The claim integration fixture predates migration 745. Loop-transition logging is
// fail-soft instrumentation, not part of the claim behavior under test; keep its
// fire-and-forget write from producing an unexpected-console warning here.
vi.mock('./loop-transition-log', () => ({ recordLoopTransition: vi.fn() }));

const { claimDueRoutine, claimedRoutineDispatchAllowed } = await import('./claim');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `claim_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.routines (
      id text PRIMARY KEY, install_slug text NOT NULL, name text NOT NULL,
      trigger_kind text NOT NULL, trigger_config jsonb NOT NULL, target_role text NOT NULL,
      active boolean DEFAULT true NOT NULL, last_fired_at timestamptz, next_fire_at timestamptz,
      updated_at timestamptz DEFAULT now() NOT NULL, workspace_id text NOT NULL,
      -- migration 323 (B-LOOP-1): the loop recurrence kind.
      reschedule_interval_sec integer, target_owner_id text
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL,
      schedule_active boolean NOT NULL DEFAULT false, expires_at timestamptz,
      updated_at timestamptz DEFAULT now() NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    )`);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.routines, harness_shared.harness_plans`;
});

async function insertRoutine(o: {
  id: string;
  name?: string;
  targetRole?: string;
  cfg: Record<string, unknown>;
  active?: boolean;
  nextFireAt?: Date | null;
  rescheduleIntervalSec?: number | null;
}) {
  const name = o.name ?? o.id;
  const intervalSec = o.rescheduleIntervalSec ?? null;
  await rootSql`
    INSERT INTO harness_shared.routines (id, install_slug, name, trigger_kind, trigger_config, target_role, active, next_fire_at, workspace_id, reschedule_interval_sec)
    VALUES (${o.id}, 'web', ${name}, 'schedule', ${JSON.stringify(o.cfg)}::text::jsonb, ${o.targetRole ?? 'worker'},
            ${o.active ?? true}, ${o.nextFireAt ?? null}, 'ws1', ${intervalSec})`;
  // The stub MUST carry rescheduleIntervalSec — claimDueRoutine reads it to detect a loop.
  return {
    id: o.id,
    workspaceId: 'ws1',
    installSlug: 'web',
    name,
    targetRole: o.targetRole ?? 'worker',
    triggerConfig: o.cfg,
    rescheduleIntervalSec: intervalSec,
    nextFireAt: o.nextFireAt ?? null,
  } as never;
}
const activeOf = async (id: string) =>
  (await rootSql<{ active: boolean }[]>`SELECT active FROM harness_shared.routines WHERE id=${id}`)[0]?.active;
const nextFireOf = async (id: string) =>
  (await rootSql<{ next_fire_at: Date | null }[]>`SELECT next_fire_at FROM harness_shared.routines WHERE id=${id}`)[0]
    ?.next_fire_at;
// A parked loop's next_fire_at is 'infinity' (postgres-js parses it to an Invalid Date,
// so compare in SQL, not JS): true iff next_fire_at = 'infinity'::timestamptz.
const parkedOf = async (id: string) =>
  (
    await rootSql<
      { parked: boolean }[]
    >`SELECT next_fire_at = 'infinity'::timestamptz AS parked FROM harness_shared.routines WHERE id=${id}`
  )[0]?.parked;
// Simulate B-LOOP-2's completion-rebase: re-arm a parked loop to a DUE time.
const rearmDue = async (id: string): Promise<Date> => {
  const at = new Date(Date.now() - 1_000);
  await rootSql`UPDATE harness_shared.routines SET next_fire_at = ${at} WHERE id=${id}`;
  return at;
};

describe('claimDueRoutine — recurring', () => {
  it('claims a due cron routine and advances next_fire_at; a second claim then loses', async () => {
    const r = await insertRoutine({ id: 'r1', cfg: { cron: '0 0 * * *' }, nextFireAt: null }); // null = due
    expect(await claimDueRoutine(rootSql, r)).toBe(true);
    expect(await nextFireOf('r1')).toBeInstanceOf(Date); // advanced to the next cron time (future)
    expect(await activeOf('r1')).toBe(true); // recurring stays active
    expect(await claimDueRoutine(rootSql, r)).toBe(false); // not due anymore → loser
  });

  it('does NOT claim a not-yet-due routine', async () => {
    const future = new Date(Date.now() + 3_600_000);
    const r = await insertRoutine({ id: 'r2', cfg: { cron: '0 0 * * *' }, nextFireAt: future });
    expect(await claimDueRoutine(rootSql, r)).toBe(false);
  });

  it('does NOT claim an inactive routine', async () => {
    const r = await insertRoutine({ id: 'r3', cfg: { cron: '0 0 * * *' }, active: false, nextFireAt: null });
    expect(await claimDueRoutine(rootSql, r)).toBe(false);
  });

  it('does not let a stale tick overwrite a newly retuned due timestamp', async () => {
    const r = await insertRoutine({ id: 'routines-set-cas', cfg: { cron: '0 0 * * *' }, nextFireAt: null });
    const retunedAt = new Date(Date.now() - 1_000);

    // The ticker listed r before routines:set replaced both the cron config and
    // next_fire_at. The retuned timestamp is already due to make the regression
    // deterministic; the stale snapshot must still lose the compare-and-swap.
    await rootSql`
      UPDATE harness_shared.routines
         SET trigger_config = ${JSON.stringify({ cron: '* * * * *' })}::text::jsonb,
             next_fire_at = ${retunedAt},
             updated_at = now()
       WHERE id = 'routines-set-cas'
    `;

    expect(await claimDueRoutine(rootSql, r)).toBe(false);
    const preserved = await nextFireOf('routines-set-cas');
    expect(preserved?.getTime()).toBe(retunedAt.getTime());
  });
});

describe('claimedRoutineDispatchAllowed — queued-fire pause fence (EI-20509996472706488)', () => {
  it('cancels a recurring fire that was claimed before the routine was paused', async () => {
    const r = await insertRoutine({ id: 'fence-cron-paused', cfg: { cron: '0 */15 * * * *' }, nextFireAt: null });
    expect(await claimDueRoutine(rootSql, r)).toBe(true);

    // Reproduce the live incident: the durable fire is queued, then routines:set
    // flips active=false before an executor starts it.
    await rootSql`UPDATE harness_shared.routines SET active = FALSE, updated_at = now() WHERE id = 'fence-cron-paused'`;

    expect(await claimedRoutineDispatchAllowed(rootSql, r)).toBe(false);
  });

  it('allows a claimed recurring fire while the routine remains active', async () => {
    const r = await insertRoutine({ id: 'fence-cron-active', cfg: { cron: '0 */15 * * * *' }, nextFireAt: null });
    expect(await claimDueRoutine(rootSql, r)).toBe(true);
    expect(await claimedRoutineDispatchAllowed(rootSql, r)).toBe(true);
  });

  it('allows a claimed one-shot even though claiming intentionally deactivates its row', async () => {
    const r = await insertRoutine({ id: 'fence-one-shot', cfg: {}, nextFireAt: null });
    expect(await claimDueRoutine(rootSql, r)).toBe(true);
    expect(await activeOf('fence-one-shot')).toBe(false);
    expect(await claimedRoutineDispatchAllowed(rootSql, r)).toBe(true);
  });

  it('cancels a pure loop fire when loop:end pauses it after claim', async () => {
    const r = await insertRoutine({ id: 'fence-loop-paused', cfg: {}, rescheduleIntervalSec: 60, nextFireAt: null });
    expect(await claimDueRoutine(rootSql, r)).toBe(true);
    await rootSql`UPDATE harness_shared.routines SET active = FALSE, updated_at = now() WHERE id = 'fence-loop-paused'`;
    expect(await claimedRoutineDispatchAllowed(rootSql, r)).toBe(false);
  });
});

describe('claimDueRoutine — one-shot', () => {
  it('claims a one-shot (no recurrence) and DEACTIVATES it', async () => {
    const r = await insertRoutine({ id: 'os1', cfg: {}, nextFireAt: null }); // no cron/rrule
    expect(await claimDueRoutine(rootSql, r)).toBe(true);
    expect(await activeOf('os1')).toBe(false); // deactivated — won't refire
  });

  it('EI-1371: claiming a plan-schedule one-shot ALSO un-arms the owning plan', async () => {
    await rootSql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, schedule_active)
                  VALUES ('ws1', 'web', 'myplan', true)`;
    const r = await insertRoutine({
      id: 'ps1',
      name: 'plan-schedule-myplan',
      targetRole: 'system:plan-run',
      cfg: {},
      nextFireAt: null,
    });
    expect(await claimDueRoutine(rootSql, r)).toBe(true);
    expect(await activeOf('ps1')).toBe(false); // routine deactivated
    const plan = (
      await rootSql<
        { schedule_active: boolean }[]
      >`SELECT schedule_active FROM harness_shared.harness_plans WHERE plan_slug='myplan'`
    )[0]!;
    expect(plan.schedule_active).toBe(false); // plan un-armed too (the two-write)
  });
});

// EI-1387 — a recurring plan-schedule must STOP firing once its owning plan expires.
describe('claimDueRoutine — recurring plan-schedule expiry (EI-1387)', () => {
  it('a due recurring plan-schedule PAST its plan expires_at is DEACTIVATED, not re-claimed, and un-arms the plan', async () => {
    const past = new Date(Date.now() - 3_600_000);
    await rootSql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, schedule_active, expires_at)
                  VALUES ('ws1', 'web', 'expiredplan', true, ${past})`;
    const r = await insertRoutine({
      id: 'ps-exp1',
      name: 'plan-schedule-expiredplan',
      targetRole: 'system:plan-run',
      cfg: { cron: '0 0 * * *' },
      nextFireAt: null,
    });
    expect(await claimDueRoutine(rootSql, r)).toBe(false); // NOT claimed — must not fire the expired occurrence
    expect(await activeOf('ps-exp1')).toBe(false); // deactivated — won't refire
    const plan = (
      await rootSql<
        { schedule_active: boolean }[]
      >`SELECT schedule_active FROM harness_shared.harness_plans WHERE plan_slug='expiredplan'`
    )[0]!;
    expect(plan.schedule_active).toBe(false); // plan un-armed too (the two-write, mirrors EI-1371)
    // A second tick sees the routine inactive and never re-enters this branch — stays deactivated.
    expect(await claimDueRoutine(rootSql, r)).toBe(false);
    expect(await activeOf('ps-exp1')).toBe(false);
  });

  it('a due recurring plan-schedule with a FUTURE expires_at claims + advances normally', async () => {
    const future = new Date(Date.now() + 3_600_000);
    await rootSql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, schedule_active, expires_at)
                  VALUES ('ws1', 'web', 'liveplan', true, ${future})`;
    const r = await insertRoutine({
      id: 'ps-live1',
      name: 'plan-schedule-liveplan',
      targetRole: 'system:plan-run',
      cfg: { cron: '0 0 * * *' },
      nextFireAt: null,
    });
    expect(await claimDueRoutine(rootSql, r)).toBe(true);
    expect(await activeOf('ps-live1')).toBe(true); // stays active — not yet expired
    expect(await nextFireOf('ps-live1')).toBeInstanceOf(Date); // advanced normally
    const plan = (
      await rootSql<
        { schedule_active: boolean }[]
      >`SELECT schedule_active FROM harness_shared.harness_plans WHERE plan_slug='liveplan'`
    )[0]!;
    expect(plan.schedule_active).toBe(true); // untouched
  });

  it('a due recurring plan-schedule with NO expires_at (open-ended) claims + advances normally', async () => {
    await rootSql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, schedule_active, expires_at)
                  VALUES ('ws1', 'web', 'foreverplan', true, NULL)`;
    const r = await insertRoutine({
      id: 'ps-forever1',
      name: 'plan-schedule-foreverplan',
      targetRole: 'system:plan-run',
      cfg: { cron: '0 0 * * *' },
      nextFireAt: null,
    });
    expect(await claimDueRoutine(rootSql, r)).toBe(true);
    expect(await activeOf('ps-forever1')).toBe(true);
  });

  it('a plain (non-plan-schedule) recurring routine is unaffected — no owning-plan lookup happens', async () => {
    const r = await insertRoutine({ id: 'plain-cron1', cfg: { cron: '0 0 * * *' }, nextFireAt: null });
    expect(await claimDueRoutine(rootSql, r)).toBe(true);
    expect(await activeOf('plain-cron1')).toBe(true);
  });
});

// loop-routines-interval-recurrence-2026-06-20 P-003 (B-LOOP-1) — the THIRD recurrence kind.
describe('claimDueRoutine — loop (P-003)', () => {
  it('a PURE loop stays active + PARKS at infinity on claim (not deactivated, not NULL)', async () => {
    const r = await insertRoutine({ id: 'lp1', cfg: {}, rescheduleIntervalSec: 60, nextFireAt: null }); // due, no cron/rrule
    expect(await claimDueRoutine(rootSql, r)).toBe(true);
    expect(await activeOf('lp1')).toBe(true); // NOT deactivated (the one-shot trap)
    expect(await parkedOf('lp1')).toBe(true); // next_fire_at='infinity', NOT NULL (the refire trap)
  });

  it('never refires while parked: a second claim on a parked loop LOSES', async () => {
    const r = await insertRoutine({ id: 'lp2', cfg: {}, rescheduleIntervalSec: 60, nextFireAt: null });
    expect(await claimDueRoutine(rootSql, r)).toBe(true); // claim → park
    expect(await parkedOf('lp2')).toBe(true);
    expect(await claimDueRoutine(rootSql, r)).toBe(false); // 'infinity' <= now() is false → not due → no re-claim
    expect(await activeOf('lp2')).toBe(true); // still alive, still parked
  });

  it('re-fires after the completion-rebase re-arms it (survives MANY claims, never deactivates)', async () => {
    // Each engine tick lists a fresh RoutineRow. Refresh the captured timestamp
    // after the simulated completion-rebase so the CAS models that next tick.
    const r = (await insertRoutine({ id: 'lp3', cfg: {}, rescheduleIntervalSec: 60, nextFireAt: null })) as any;
    for (let i = 0; i < 5; i++) {
      expect(await claimDueRoutine(rootSql, r)).toBe(true); // claim
      expect(await parkedOf('lp3')).toBe(true); // parked in-flight
      expect(await activeOf('lp3')).toBe(true); // P-003 regression: a pure loop NEVER deactivates
      r.nextFireAt = await rearmDue('lp3'); // B-LOOP-2 re-arm after the turn settles
    }
    expect(await activeOf('lp3')).toBe(true);
  });

  it('a pure loop NEVER touches harness_plans, even when named plan-schedule-*', async () => {
    await rootSql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, schedule_active)
                  VALUES ('ws1', 'web', 'looplan', true)`;
    // A loop branch returns BEFORE the one-shot plan-unarm — the loop must not disarm the plan.
    const r = await insertRoutine({
      id: 'lp4',
      name: 'plan-schedule-looplan',
      targetRole: 'system:plan-run',
      cfg: {},
      rescheduleIntervalSec: 60,
      nextFireAt: null,
    });
    expect(await claimDueRoutine(rootSql, r)).toBe(true);
    expect(await parkedOf('lp4')).toBe(true); // parked, not deactivated
    expect(await activeOf('lp4')).toBe(true);
    const plan = (
      await rootSql<
        { schedule_active: boolean }[]
      >`SELECT schedule_active FROM harness_shared.harness_plans WHERE plan_slug='looplan'`
    )[0]!;
    expect(plan.schedule_active).toBe(true); // plan STILL armed — the loop never disarmed it
  });

  it('cron+loop is recurrence: advances to cron-next (does NOT park), stays active', async () => {
    // hasRecurrence (cron present) → the recurrence branch; the loop re-arm is folded in later by B-LOOP-2.
    const r = await insertRoutine({
      id: 'cl1',
      cfg: { cron: '0 0 * * *' },
      rescheduleIntervalSec: 60,
      nextFireAt: null,
    });
    expect(await claimDueRoutine(rootSql, r)).toBe(true);
    expect(await activeOf('cl1')).toBe(true);
    expect(await parkedOf('cl1')).toBe(false); // NOT parked at infinity
    const nf = await nextFireOf('cl1');
    expect(nf).toBeInstanceOf(Date); // advanced to a real cron-next time
    expect(nf!.getTime()).toBeGreaterThan(Date.now()); // a finite future time, not infinity
  });
});
