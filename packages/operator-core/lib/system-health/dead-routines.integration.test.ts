/**
 * dead-routines.integration.test.ts — `readDeadRoutines` (the workFeed
 * engine-starvation detector) against a real Postgres.
 *
 * EI-11797 regression: the dead-routine detector must count only routines whose
 * overdue `next_fire_at` genuinely means the routinesTick is NOT firing them —
 * i.e. CRON/rrule routines (incl. cron+loop). A PURE LOOP (reschedule_interval_sec
 * set, no cron/rrule) has period (turn-duration + interval): a busy owner (an
 * actively-running fleet loop) or the transient completion-rebase→next-claim window
 * legitimately leaves it briefly overdue, which is NOT engine starvation. Counting
 * it mis-fired the workFeed CRIT + a fleet-wide "routine engine is starved" blocker
 * "while the active fleet loop is running" (the dead-routines flap, 2026-07-11/12).
 *
 * Behaviors a fake-sql unit test can't prove (the exclusion lives in SQL):
 *  - an overdue CRON routine IS reported (a genuine engine-starvation signal);
 *  - an overdue PURE LOOP is NOT reported (the false positive this fixes);
 *  - a PARKED loop (next_fire_at='infinity') is NOT reported (never < now());
 *  - an overdue cron+loop IS reported (a recurrence the engine advances → real);
 *  - a not-yet-due / inactive routine is NOT reported.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

// WI-4310: resolveDeadRoutineOverdueMs's lock-probe leg is mocked per-test (it reads a real
// fs lock file, which is orthogonal to what THIS integration test proves — the pipeline_events
// DB query). `../release-deploy-launch` is mocked too since resolveDeadRoutineOverdueMs
// dynamic-imports it purely to get an integrationRoot() string to pass through.
const lockProbe = vi.fn<() => { held: boolean; elapsedSec: number | null }>(() => ({ held: false, elapsedSec: null }));
vi.mock('../release-checkpoint-launch', () => ({ isCheckpointRunLockHeldCheap: () => lockProbe() }));
vi.mock('../release-deploy-launch', () => ({ integrationRoot: () => '/fake-tree' }));

const { readDeadRoutines, resolveDeadRoutineOverdueMs } = await import('./compute');

const OVERDUE_MS = 10 * 60_000;

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `deadroutines_${randomBytes(5).toString('hex')}`;
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
  // WI-4310: mirrors migration 177 (harness_shared.pipeline_events) — the shape
  // resolveDeadRoutineOverdueMs's grace-window query reads.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.pipeline_events (
      id bigserial NOT NULL, workspace_id text NOT NULL, install_slug text NOT NULL,
      kind text NOT NULL, status text NOT NULL, detail jsonb DEFAULT '{}'::jsonb NOT NULL,
      created_at timestamptz DEFAULT now() NOT NULL
    )`);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.routines`;
  await rootSql`TRUNCATE harness_shared.pipeline_events`;
  lockProbe.mockReset();
  lockProbe.mockReturnValue({ held: false, elapsedSec: null });
});

/** next_fire_at 15min in the past — comfortably past the 10min overdue window. */
const overduePast = () => new Date(Date.now() - 15 * 60_000);
/** next_fire_at 1h in the future — never overdue. */
const future = () => new Date(Date.now() + 60 * 60_000);

async function insertRoutine(o: {
  id: string;
  name?: string;
  cfg: Record<string, unknown>;
  active?: boolean;
  nextFireAt?: Date | 'infinity' | null;
  rescheduleIntervalSec?: number | null;
  workspaceId?: string;
  installSlug?: string;
  lastFiredAt?: Date | null;
}) {
  const nf = o.nextFireAt === 'infinity' ? null : (o.nextFireAt ?? null);
  await rootSql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, next_fire_at, workspace_id, reschedule_interval_sec, last_fired_at)
    VALUES (${o.id}, ${o.installSlug ?? 'web'}, ${o.name ?? o.id}, 'schedule', ${JSON.stringify(o.cfg)}::text::jsonb, 'system:loop-wake',
            ${o.active ?? true}, ${nf}, ${o.workspaceId ?? 'ws1'}, ${o.rescheduleIntervalSec ?? null}, ${o.lastFiredAt ?? null})`;
  // 'infinity' can't bind as a Date param — set it via SQL after insert (mirrors a parked loop).
  if (o.nextFireAt === 'infinity') {
    await rootSql`UPDATE harness_shared.routines SET next_fire_at = 'infinity'::timestamptz WHERE id = ${o.id}`;
  }
}

describe('readDeadRoutines — engine-starvation detector (EI-11797)', () => {
  it('reports an overdue CRON routine (a genuine engine-starvation signal)', async () => {
    await insertRoutine({ id: 'cron-dead', cfg: { cron: '*/30 * * * * *' }, nextFireAt: overduePast() });
    expect((await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1')).names).toEqual(['cron-dead']);
  });

  it('does NOT report an overdue PURE LOOP (busy fleet loop, not engine starvation)', async () => {
    // A pure loop: interval set, NO cron/rrule. Its next_fire_at is 'completed_at +
    // interval' — 15min past here (the owner is running a long turn) — yet the engine
    // is fine. This is the exact false positive EI-11797 fixes.
    await insertRoutine({ id: 'loop-overdue', cfg: {}, rescheduleIntervalSec: 60, nextFireAt: overduePast() });
    expect((await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1')).names).toEqual([]);
  });

  it('does NOT report a PARKED loop (next_fire_at=infinity, actively running)', async () => {
    await insertRoutine({ id: 'loop-parked', cfg: {}, rescheduleIntervalSec: 60, nextFireAt: 'infinity' });
    expect((await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1')).names).toEqual([]);
  });

  it('STILL reports an overdue cron+loop (a recurrence the engine should be advancing)', async () => {
    // cron+loop has an interval AND a cron → claimDueRoutine advances it to cron-next
    // every tick (never parks it), so an overdue one genuinely means the engine is stuck.
    await insertRoutine({ id: 'cronloop-dead', cfg: { cron: '*/30 * * * * *' }, rescheduleIntervalSec: 60, nextFireAt: overduePast() });
    expect((await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1')).names).toEqual(['cronloop-dead']);
  });

  it('does NOT report a not-yet-due cron routine, nor an inactive one', async () => {
    await insertRoutine({ id: 'cron-future', cfg: { cron: '*/30 * * * * *' }, nextFireAt: future() });
    await insertRoutine({ id: 'cron-inactive', cfg: { cron: '*/30 * * * * *' }, active: false, nextFireAt: overduePast() });
    expect((await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1')).names).toEqual([]);
  });

  it('mixes them: only genuine engine-starvation rows surface, loops excluded', async () => {
    await insertRoutine({ id: 'cron-dead', cfg: { cron: '*/30 * * * * *' }, nextFireAt: new Date(Date.now() - 20 * 60_000) });
    await insertRoutine({ id: 'cronloop-dead', cfg: { rrule: 'FREQ=MINUTELY' }, rescheduleIntervalSec: 60, nextFireAt: new Date(Date.now() - 15 * 60_000) });
    await insertRoutine({ id: 'loop-overdue', cfg: {}, rescheduleIntervalSec: 60, nextFireAt: overduePast() });
    await insertRoutine({ id: 'loop-parked', cfg: {}, rescheduleIntervalSec: 1800, nextFireAt: 'infinity' });
    await insertRoutine({ id: 'cron-future', cfg: { cron: '*/30 * * * * *' }, nextFireAt: future() });
    // Ordered by next_fire_at ASC → cron-dead (20m) before cronloop-dead (15m).
    expect((await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1')).names).toEqual(['cron-dead', 'cronloop-dead']);
  });

  it('scopes the census and denominator to the requested workspace', async () => {
    await insertRoutine({ id: 'other-ws-dead', cfg: { cron: '*/30 * * * * *' }, nextFireAt: overduePast(), workspaceId: 'ws-other' });
    await insertRoutine({ id: 'current-ws-dead', cfg: { cron: '*/30 * * * * *' }, nextFireAt: overduePast(), workspaceId: 'ws1' });
    await insertRoutine({ id: 'current-ws-healthy', cfg: { cron: '*/30 * * * * *' }, nextFireAt: future(), workspaceId: 'ws1' });

    const census = await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1');
    expect(census).toMatchObject({ count: 1, distinctCount: 1, totalInScope: 2, names: ['current-ws-dead'] });
  });
});

describe('readDeadRoutines — cadence-scaled threshold for FAST routines (WI-10005073)', () => {
  const minAgo = (m: number) => new Date(Date.now() - m * 60_000);
  /** A row as the engine leaves it after a fire: next_fire_at = last_fired_at + cadence. */
  async function fired(id: string, cadenceSec: number, overdueMin: number) {
    const next = minAgo(overdueMin);
    await insertRoutine({
      id,
      cfg: { cron: `*/${cadenceSec} * * * * *` },
      nextFireAt: next,
      lastFiredAt: new Date(next.getTime() - cadenceSec * 1000),
    });
  }

  it('reports an every-1s routine silent 6 min (past the 5 min fast floor, under the 10 min base)', async () => {
    await fired('fast-dead', 1, 6);
    expect((await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1')).names).toEqual(['fast-dead']);
  });

  it('does NOT report an every-1s routine silent 4 min: a normal restart gap (measured ~3.7 min)', async () => {
    await fired('fast-restart-gap', 1, 4);
    expect((await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1')).names).toEqual([]);
  });

  it('scales with cadence between 30 and 60 s: a 45 s routine is dead after 7.5 min, not 5', async () => {
    await fired('every-45s-7min', 45, 7);
    await fired('every-45s-8min', 45, 8);
    expect((await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1')).names).toEqual(['every-45s-8min']);
  });

  it('keeps the base threshold for a slower routine (5 min cadence, 6 min overdue)', async () => {
    await fired('every-5m', 300, 6);
    expect((await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1')).names).toEqual([]);
  });

  it('keeps the base threshold for a never-fired row (no observed cadence)', async () => {
    await insertRoutine({ id: 'never-fired', cfg: { cron: '*/1 * * * * *' }, nextFireAt: minAgo(6) });
    expect((await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1')).names).toEqual([]);
  });

  it('doubles the fast floor with the checkpoint-widened base (20 min -> 10 min)', async () => {
    await fired('fast-widened-8', 1, 8);
    await fired('fast-widened-11', 1, 11);
    expect((await readDeadRoutines(rootSql, 2 * OVERDUE_MS, 'ws1')).names).toEqual(['fast-widened-11']);
  });
});

describe('readDeadRoutines — census integrity under a WIDE freeze (EI-20045691451471399)', () => {
  it('reports the TRUE overdue count, NOT the length of the capped exemplar list', async () => {
    // 12 overdue (twice the 6-exemplar cap) + 2 healthy, so the denominator is also exercised.
    for (let i = 0; i < 12; i++) {
      await insertRoutine({
        id: `frozen-${String(i).padStart(2, '0')}`, cfg: { cron: '*/30 * * * * *' },
        nextFireAt: new Date(Date.now() - (20 + i) * 60_000),
      });
    }
    await insertRoutine({ id: 'healthy-1', cfg: { cron: '*/30 * * * * *' }, nextFireAt: future() });
    await insertRoutine({ id: 'healthy-2', cfg: { cron: '*/30 * * * * *' }, nextFireAt: future() });

    const census = await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1');
    // ⚠ THE REGRESSION THIS GUARDS. The old code returned a bare `LIMIT 20` name list and the
    // panel set `deadRoutines = deadRoutineNames.length`, making the reported count a function
    // of the fetch cap. Measured in the wild 2026-08-10: the alarm broadcast "20 dead
    // routine(s)" while 101 of 151 routines were genuinely overdue, and the agent who read it
    // concluded "the DETECTOR is fine". If anyone re-derives the count from the list, THIS
    // assertion fails — count and names.length are deliberately different numbers here.
    expect(census.count).toBe(12);
    expect(census.names.length).toBeLessThan(census.count);
    expect(census.namesTruncated).toBe(true);
    // The denominator counts every in-scope durable routine, overdue or not.
    expect(census.totalInScope).toBe(14);
  });

  it('NAMES git-sync even when it is the LEAST overdue member (consequence beats overdue-seconds)', async () => {
    // git-sync is overdue by the SMALLEST margin, so ordering by overdue-seconds ranks it dead
    // last and the exemplar cap would drop it entirely — which is precisely how the filed
    // incident announced a fleet-wide commit outage under the name `pr-poll`.
    for (let i = 0; i < 10; i++) {
      await insertRoutine({
        id: `bystander-${i}`, cfg: { cron: '*/30 * * * * *' },
        nextFireAt: new Date(Date.now() - (30 + i) * 60_000),
      });
    }
    await insertRoutine({ id: 'git-sync', cfg: { cron: '*/30 * * * * *' }, nextFireAt: new Date(Date.now() - 11 * 60_000) });

    const census = await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1');
    expect(census.names[0]).toBe('git-sync');
    expect(census.criticalNames).toEqual(['git-sync']);
    expect(census.count).toBe(11);
  });

  it('reports a clean, unbounded zero when nothing is overdue', async () => {
    await insertRoutine({ id: 'cron-future', cfg: { cron: '*/30 * * * * *' }, nextFireAt: future() });
    const census = await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1');
    expect(census).toMatchObject({ count: 0, names: [], criticalNames: [], namesTruncated: false, censusTruncated: false });
  });

  it('reports overdue and active rows per routine name, not just the global census', async () => {
    await insertRoutine({ id: 'git-sync-dead-1', name: 'git-sync', cfg: { cron: '*/30 * * * * *' }, nextFireAt: overduePast() });
    await insertRoutine({ id: 'git-sync-dead-2', name: 'git-sync', cfg: { cron: '*/30 * * * * *' }, nextFireAt: overduePast() });
    await insertRoutine({ id: 'git-sync-healthy-1', name: 'git-sync', cfg: { cron: '*/30 * * * * *' }, nextFireAt: future() });
    await insertRoutine({ id: 'git-sync-healthy-2', name: 'git-sync', cfg: { cron: '*/30 * * * * *' }, nextFireAt: future() });

    const census = await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1');
    // WI-10002084 added the per-install leg. These fixtures all insert under install_slug
    // 'web', so the release install genuinely has no row here and the honest reading is
    // 'absent' (NOT 'live' — see the release-install describe below for why that distinction
    // is load-bearing). Kept as an exact toEqual on purpose: that exactness is what made THIS
    // assertion catch the new field in the first place, and what will catch the next one.
    expect(census.routineCoverage).toEqual({ 'git-sync': { overdue: 2, active: 4, homeInstall: 'absent' } });
  });
});

describe('resolveDeadRoutineOverdueMs — checkpoint-window-aware threshold against a real PG (WI-4310)', () => {
  it('widens when the (mocked) lock probe reports a checkpoint run active — never queries pipeline_events', async () => {
    lockProbe.mockReturnValue({ held: true, elapsedSec: 120 });
    const ms = await resolveDeadRoutineOverdueMs(rootSql, 'papercusp', Date.now());
    expect(ms).toBe(20 * 60_000);
  });

  it('widens within the grace window after a real green_checkpoint pipeline_event row', async () => {
    lockProbe.mockReturnValue({ held: false, elapsedSec: null });
    await rootSql`
      INSERT INTO harness_shared.pipeline_events (workspace_id, install_slug, kind, status, created_at)
      VALUES ('ws1', 'papercusp', 'green_checkpoint', 'not-green', now() - interval '2 minutes')`;
    const ms = await resolveDeadRoutineOverdueMs(rootSql, 'papercusp', Date.now());
    expect(ms).toBe(20 * 60_000);
  });

  it('stays at the base threshold once the most recent checkpoint event is past the grace window', async () => {
    lockProbe.mockReturnValue({ held: false, elapsedSec: null });
    await rootSql`
      INSERT INTO harness_shared.pipeline_events (workspace_id, install_slug, kind, status, created_at)
      VALUES ('ws1', 'papercusp', 'green_checkpoint', 'advanced', now() - interval '10 minutes')`;
    const ms = await resolveDeadRoutineOverdueMs(rootSql, 'papercusp', Date.now());
    expect(ms).toBe(10 * 60_000);
  });

  it('ignores a DIFFERENT install\'s checkpoint event (multi-tenant scoping)', async () => {
    lockProbe.mockReturnValue({ held: false, elapsedSec: null });
    await rootSql`
      INSERT INTO harness_shared.pipeline_events (workspace_id, install_slug, kind, status, created_at)
      VALUES ('ws2', 'some-other-hive', 'green_checkpoint', 'not-green', now() - interval '1 minute')`;
    const ms = await resolveDeadRoutineOverdueMs(rootSql, 'papercusp', Date.now());
    expect(ms).toBe(10 * 60_000);
  });

  it('ignores a non-checkpoint pipeline_event kind (e.g. git_sync)', async () => {
    lockProbe.mockReturnValue({ held: false, elapsedSec: null });
    await rootSql`
      INSERT INTO harness_shared.pipeline_events (workspace_id, install_slug, kind, status, created_at)
      VALUES ('ws1', 'papercusp', 'git_sync', 'synced', now() - interval '1 minute')`;
    const ms = await resolveDeadRoutineOverdueMs(rootSql, 'papercusp', Date.now());
    expect(ms).toBe(10 * 60_000);
  });

  it('stays at the base threshold (fail-soft, no throw) with no pipeline_events at all and no potSlug', async () => {
    lockProbe.mockReturnValue({ held: false, elapsedSec: null });
    const ms = await resolveDeadRoutineOverdueMs(rootSql, null, Date.now());
    expect(ms).toBe(10 * 60_000);
  });
});

/**
 * WI-10002084 — per-install coverage for the RELEASE install.
 *
 * `formatDeadRoutinesSummary` says "NOTHING in the shared tree is being committed". That is a
 * claim about ONE install — the one owning the canonical checkout — but it was licensed by a
 * ratio over every git-sync row in the workspace, and those rows are mostly library submodules
 * and toy pots (measured 2026-09-20: 67 git-sync rows across 67 installs, of which exactly one
 * is the shared tree's). These pin the census leg that makes the per-install question answerable.
 *
 * This lives in the integration suite because the whole leg is SQL — a `FILTER` that silently
 * matched nothing would report `'absent'` for every routine, which is deliberately non-refuting
 * and would therefore restore the old behaviour without failing a single unit test.
 */
describe('readDeadRoutines — release-install coverage (WI-10002084)', () => {
  const cron = { cron: '*/30 * * * * *' };

  it("reports 'overdue' when the release install's own row is among the overdue", async () => {
    await insertRoutine({ id: 'gs-home', name: 'git-sync', installSlug: 'home', cfg: cron, nextFireAt: overduePast() });
    await insertRoutine({ id: 'gs-toy', name: 'git-sync', installSlug: 'hello-world', cfg: cron, nextFireAt: overduePast() });
    const census = await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1', 'home');
    expect(census.routineCoverage['git-sync']).toMatchObject({ overdue: 2, active: 2, homeInstall: 'overdue' });
  });

  // The exact shape the alarm was misreporting: a strict majority of overdue rows that is
  // entirely sibling installs, while the shared tree's own git-sync is perfectly on schedule.
  it("reports 'live' when only sibling installs are overdue", async () => {
    await insertRoutine({ id: 'gs-home', name: 'git-sync', installSlug: 'home', cfg: cron, nextFireAt: future() });
    await insertRoutine({ id: 'gs-toy1', name: 'git-sync', installSlug: 'hello-world', cfg: cron, nextFireAt: overduePast() });
    await insertRoutine({ id: 'gs-toy2', name: 'git-sync', installSlug: 'spoon-knife', cfg: cron, nextFireAt: overduePast() });
    const census = await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1', 'home');
    expect(census.routineCoverage['git-sync']).toMatchObject({ overdue: 2, active: 3, homeInstall: 'live' });
  });

  // An UNMEASURED leg must stay distinguishable from a healthy one. If this collapsed to
  // 'live' it would refute — silently suppressing a real fleet-wide alarm.
  it("reports 'absent', not 'live', when the release install has no row for that routine", async () => {
    await insertRoutine({ id: 'gs-toy', name: 'git-sync', installSlug: 'hello-world', cfg: cron, nextFireAt: overduePast() });
    const census = await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1', 'home');
    expect(census.routineCoverage['git-sync'].homeInstall).toBe('absent');
  });

  // Guards a FILTER that ignored the GROUP BY: the home leg must be answered per routine NAME.
  // Here the home install is overdue on ONE routine and absent from the other, so a leak across
  // names shows up as both rows reading the same value.
  it('answers the home-install leg per routine name, not across names', async () => {
    await insertRoutine({ id: 'gs-home', name: 'git-sync', installSlug: 'home', cfg: cron, nextFireAt: overduePast() });
    await insertRoutine({ id: 'gc-toy', name: 'green-checkpoint', installSlug: 'hello-world', cfg: cron, nextFireAt: overduePast() });
    const census = await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1', 'home');
    expect(census.routineCoverage['git-sync'].homeInstall).toBe('overdue');
    expect(census.routineCoverage['green-checkpoint'].homeInstall).toBe('absent');
  });

  // A routine nobody is overdue on never reaches the alarm, so it must not appear at all —
  // otherwise a healthy home row would start emitting coverage rows the consumer has to filter.
  it('omits a routine with no overdue rows entirely', async () => {
    await insertRoutine({ id: 'gs-home', name: 'git-sync', installSlug: 'home', cfg: cron, nextFireAt: future() });
    const census = await readDeadRoutines(rootSql, OVERDUE_MS, 'ws1', 'home');
    expect(census.routineCoverage['git-sync']).toBeUndefined();
  });
});
