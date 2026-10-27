/**
 * claim-precision.integration.test.ts — WI-40883.
 *
 * A routine whose `next_fire_at` was written by SQL `now()` could NEVER be claimed, so it
 * never fired once in its life. PostgreSQL `timestamptz` stores MICROSECONDS; postgres-js
 * parses it into a JS `Date`, which holds only MILLISECONDS; `claimDueRoutine` then sends that
 * lossy value back as the parameter of its optimistic-concurrency guard. The sub-millisecond
 * digits cannot be reproduced, so the guard was FALSE forever, the claim UPDATE matched zero
 * rows, and routinesTick's `if (!claimed) continue;` skipped the routine on every tick —
 * silently, with the row active, due, correctly configured and its handler registered.
 *
 * Measured on the live operator DB before the fix: 11 active routines had never fired against
 * 162 healthy ones, split EXACTLY by whether their next_fire_at carried sub-millisecond
 * precision. Among the dark ones was green-checkpoint for three pots — their release gate had
 * never once run, one for ~36 hours.
 *
 * These tests run against the pre-migration column type (plain `timestamptz`, microsecond
 * precision) ON PURPOSE. Migration 909 narrows the real column to timestamptz(3) so PG cannot
 * store such a value at all, but the two fixes are deliberately redundant: this file pins the
 * claim.ts guard on its own, so it still protects a routines table that has not been migrated
 * or a future column that reintroduces microsecond precision.
 *
 * The first test is a PRECONDITION, not a formality: if this Postgres' now() happened to return
 * whole milliseconds, the regression test below would pass without exercising the bug at all.
 * It asserts the trap is actually armed before the regression test claims to have sprung it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual };
});
// Fail-soft instrumentation, not part of the claim behavior under test.
vi.mock('./loop-transition-log', () => ({ recordLoopTransition: vi.fn() }));

const { claimDueRoutine } = await import('./claim');
const { listDueCronRoutines } = await import('@papercusp/db-org');
const { classifyClaimSkip, recordUnclaimableRoutine, clearUnclaimableRoutine } =
  await import('./unclaimable-routine-detector');

let rootSql: postgres.Sql;

const WS = 'ws-precision';

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `claimprec_${randomBytes(5).toString('hex')}`;
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
  // Plain `timestamptz` — microsecond precision, the shape the bug lives in. Deliberately NOT
  // timestamptz(3): this fixture reproduces a table migration 909 has not reached.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.routines (
      id text PRIMARY KEY, install_slug text NOT NULL, name text NOT NULL,
      workspace_id text NOT NULL,
      trigger_kind text NOT NULL, trigger_config jsonb NOT NULL, target_role text NOT NULL,
      payload_template jsonb, concurrency text DEFAULT 'skip' NOT NULL,
      catchup text DEFAULT 'skip-old' NOT NULL, tier text DEFAULT 'durable' NOT NULL,
      active boolean DEFAULT true NOT NULL,
      last_fired_at timestamptz, next_fire_at timestamptz,
      updated_at timestamptz DEFAULT now() NOT NULL,
      metadata jsonb,
      reschedule_interval_sec integer, target_owner_id text
    )`);
});

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`DELETE FROM harness_shared.routines`;
});

/**
 * Seed one due cron routine. `nextFireSql` is raw SQL so a test can choose EXACTLY how the
 * timestamp is written — which is the whole variable under test: `now()` carries microseconds,
 * a JS-supplied ISO string carries milliseconds.
 */
async function seed(id: string, nextFireSql: postgres.PendingQuery<any> | postgres.Fragment) {
  await rootSql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role, next_fire_at)
    VALUES (${id}, 'papercusp', ${WS}, ${id}, 'cron',
            ${rootSql.json({ cron: '0 */10 * * * *' })}, 'system:noop', ${nextFireSql})
  `;
}

/** Read the routine back through the SAME path routinesTick uses — the lossy Date round-trip. */
async function readDue(id: string) {
  const due = await listDueCronRoutines(rootSql as any);
  return due.find((r: any) => r.id === id);
}

async function rowOf(id: string) {
  const [row] = await rootSql`
    SELECT next_fire_at, last_fired_at,
           (date_part('microseconds', next_fire_at)::bigint % 1000) AS sub_ms
      FROM harness_shared.routines WHERE id = ${id}`;
  return row;
}

describe('claimDueRoutine — timestamp precision (WI-40883)', () => {
  it('PRECONDITION: SQL now() really does write sub-millisecond precision here', async () => {
    // If this fails, every other test in this file is vacuous — the trap would not be armed,
    // and a passing regression test below would prove nothing about the bug. Assert the
    // instrument before trusting the measurement.
    await seed('precond', rootSql`now() - interval '1 minute'`);
    const row = await rowOf('precond');
    expect(Number(row.sub_ms)).not.toBe(0);
  });

  it('REGRESSION: a routine whose next_fire_at was written by now() IS claimed', async () => {
    await seed('mu', rootSql`now() - interval '1 minute'`);
    const before = await rowOf('mu');
    expect(Number(before.sub_ms)).not.toBe(0); // the row really is in the broken shape
    expect(before.last_fired_at).toBeNull();

    const routine = await readDue('mu');
    expect(routine).toBeDefined();

    // Before the fix this returned false on every tick, forever.
    await expect(claimDueRoutine(rootSql as any, routine as any)).resolves.toBe(true);

    const after = await rowOf('mu');
    expect(after.last_fired_at).not.toBeNull();
    // Claimed rows advance to the next cron time — no longer stuck in the past.
    expect(new Date(after.next_fire_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('CONTROL: the PRE-FIX guard matches zero rows on that same row — the fix is load-bearing', async () => {
    // A deliberately-wrong implementation kept permanently as a control (the repo's guidance for
    // proving a guard is falsifiable without mutating the shared tree). This is the exact
    // comparison claim.ts used before WI-40883. If this ever starts matching, the regression
    // test above has stopped exercising the bug and something upstream changed — the fixture's
    // column type, or postgres-js gaining sub-millisecond parsing.
    await seed('ctl', rootSql`now() - interval '1 minute'`);
    const routine = await readDue('ctl');
    const captured = (routine as any).nextFireAt as Date;

    const preFix = await rootSql`
      SELECT id FROM harness_shared.routines
       WHERE id = 'ctl' AND active = TRUE
         AND next_fire_at IS NOT DISTINCT FROM ${captured}`;
    expect(preFix.length).toBe(0); // ← the bug, reproduced exactly

    const postFix = await rootSql`
      SELECT id FROM harness_shared.routines
       WHERE id = 'ctl' AND active = TRUE
         AND date_trunc('milliseconds', next_fire_at) IS NOT DISTINCT FROM ${captured}`;
    expect(postFix.length).toBe(1); // ← the fix, on the identical row
  });

  it('CALIBRATION: a whole-millisecond next_fire_at is still claimed (normal path intact)', async () => {
    // The 162 healthy routines' shape. Guards against a "fix" that only moves the failure.
    const ms = new Date(Date.now() - 60_000).toISOString();
    await seed('ms', rootSql`${ms}::timestamptz`);
    expect(Number((await rowOf('ms')).sub_ms)).toBe(0);

    const routine = await readDue('ms');
    await expect(claimDueRoutine(rootSql as any, routine as any)).resolves.toBe(true);
    expect((await rowOf('ms')).last_fired_at).not.toBeNull();
  });

  it('CALIBRATION: a NULL next_fire_at (due-by-NULL) is still claimed', async () => {
    // date_trunc(NULL) IS NOT DISTINCT FROM NULL is TRUE — the documented NULL-is-due case
    // must survive the truncation.
    await seed('nul', rootSql`NULL::timestamptz`);
    const routine = await readDue('nul');
    expect(routine).toBeDefined();
    await expect(claimDueRoutine(rootSql as any, routine as any)).resolves.toBe(true);
  });

  it('NEGATIVE CONTROL: a concurrent reschedule still LOSES the claim', async () => {
    // The relaxation must not neuter optimistic concurrency — that guard is what stops a stale
    // snapshot from consuming a schedule `routines:set` replaced under it. This is the risk the
    // fix introduces, so it is tested explicitly rather than assumed.
    await seed('race', rootSql`now() - interval '1 minute'`);
    const stale = await readDue('race');
    expect(stale).toBeDefined();

    // Someone reschedules between our read and our claim — still due, but a DIFFERENT instant.
    await rootSql`
      UPDATE harness_shared.routines
         SET next_fire_at = now() - interval '5 seconds' WHERE id = 'race'`;

    await expect(claimDueRoutine(rootSql as any, stale as any)).resolves.toBe(false);
    expect((await rowOf('race')).last_fired_at).toBeNull();
  });

  it('NEGATIVE CONTROL: an inactive routine is never claimed', async () => {
    await seed('off', rootSql`now() - interval '1 minute'`);
    const routine = await readDue('off');
    await rootSql`UPDATE harness_shared.routines SET active = FALSE WHERE id = 'off'`;
    await expect(claimDueRoutine(rootSql as any, routine as any)).resolves.toBe(false);
  });

  it('does not restore an old unclaimable alarm after another tick claims and clears it', async () => {
    await seed('late-alarm', rootSql`now() - interval '90 minutes'`);
    const stale = await readDue('late-alarm');
    expect(stale).toBeDefined();
    const verdict = classifyClaimSkip(stale as any, Date.now());
    expect(verdict.state).toBe('unclaimable');
    if (verdict.state !== 'unclaimable') throw new Error('expected overdue fixture');

    // The losing tick can finish its fire-and-forget diagnostic AFTER the winner's
    // claim and clear. Exercise that order against real PG, without timer sleeps.
    await expect(claimDueRoutine(rootSql as any, stale as any)).resolves.toBe(true);
    await clearUnclaimableRoutine(rootSql, 'late-alarm');
    await recordUnclaimableRoutine(rootSql, stale as any, verdict);

    const [row] = await rootSql`
      SELECT metadata, next_fire_at, last_fired_at
        FROM harness_shared.routines WHERE id = 'late-alarm'`;
    expect(new Date(row.next_fire_at).getTime()).toBeGreaterThan(Date.now());
    expect(row.last_fired_at).not.toBeNull();
    expect(row.metadata?.unclaimable).toBeUndefined();
  });

  it('stamps an unchanged overdue row despite PG microseconds and preserves other metadata', async () => {
    await seed('current-alarm', rootSql`now() - interval '90 minutes'`);
    await rootSql`
      UPDATE harness_shared.routines SET last_fired_at = now() - interval '2 hours',
        metadata = '{"retained":"other-health"}'::jsonb WHERE id = 'current-alarm'`;
    expect(Number((await rowOf('current-alarm')).sub_ms)).not.toBe(0);
    const current = await readDue('current-alarm');
    const verdict = classifyClaimSkip(current as any, Date.now());
    if (verdict.state !== 'unclaimable') throw new Error('expected overdue fixture');

    await recordUnclaimableRoutine(rootSql, current as any, verdict);
    const [row] = await rootSql`SELECT metadata FROM harness_shared.routines WHERE id = 'current-alarm'`;
    expect(row.metadata.retained).toBe('other-health');
    expect(row.metadata.unclaimable.reason).toBe(verdict.reason);
    expect(row.metadata.unclaimable.never_fired).toBe(false);
  });

  it('stamps and clears a valid never-claimed alarm with a NULL claim timestamp', async () => {
    await seed('never-claimed-alarm', rootSql`now() - interval '90 minutes'`);
    const current = await readDue('never-claimed-alarm');
    const verdict = classifyClaimSkip(current as any, Date.now());
    if (verdict.state !== 'unclaimable') throw new Error('expected overdue fixture');
    await recordUnclaimableRoutine(rootSql, current as any, verdict);
    const [before] = await rootSql`SELECT metadata FROM harness_shared.routines WHERE id = 'never-claimed-alarm'`;
    expect(before.metadata.unclaimable.never_fired).toBe(true);
    await clearUnclaimableRoutine(rootSql, 'never-claimed-alarm');
    const [after] = await rootSql`SELECT metadata FROM harness_shared.routines WHERE id = 'never-claimed-alarm'`;
    expect(after.metadata.unclaimable).toBeUndefined();
  });

  it.each(['schedule', 'claim', 'inactive'] as const)(
    'rejects an old alarm after a concurrent %s change while the row remains overdue',
    async (change) => {
      await seed('changed-alarm', rootSql`now() - interval '90 minutes'`);
      const stale = await readDue('changed-alarm');
      const verdict = classifyClaimSkip(stale as any, Date.now());
      if (verdict.state !== 'unclaimable') throw new Error('expected overdue fixture');
      if (change === 'schedule') {
        await rootSql`UPDATE harness_shared.routines SET next_fire_at = now() - interval '60 minutes' WHERE id = 'changed-alarm'`;
      } else if (change === 'claim') {
        await rootSql`UPDATE harness_shared.routines SET last_fired_at = now() - interval '1 minute' WHERE id = 'changed-alarm'`;
      } else {
        await rootSql`UPDATE harness_shared.routines SET active = FALSE WHERE id = 'changed-alarm'`;
      }
      await recordUnclaimableRoutine(rootSql, stale as any, verdict);
      const [row] = await rootSql`SELECT metadata FROM harness_shared.routines WHERE id = 'changed-alarm'`;
      expect(row.metadata?.unclaimable).toBeUndefined();
    },
  );
});
