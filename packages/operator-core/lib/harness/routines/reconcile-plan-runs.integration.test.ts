/**
 * reconcileScheduledPlanRuns — settling a scheduled run's outcome/finished_at once its
 * work_items terminate, proven against a REAL migrated Postgres (testcontainer).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/reconcile-plan-runs.integration.test.ts
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (Phase 5 data; unblocks P-012/P-013).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));

// The functions under test take `sql` explicitly, but `routineStorageSlug` (pot-membership)
// resolves the instance plan's storage slug through the DEFAULT org pool. Unmocked, that
// lookup reached past this file's throwaway DB; once the test rail blocked real-PG access
// it read as `pot-lookup-unmeasured` and console.warn failed every case that settles an
// instance (red on clean trees since 2026-10-08, found by WI-6554700010009851). Point the
// default pool at the throwaway DB, as plan-run-action.integration.test.ts does.
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
import {
  reconcileScheduledPlanRuns,
  autoPauseOnFailureStreak,
  reconcileAndGovern,
  PLAN_RUN_PROMOTION_GRACE_MS,
} from './reconcile-plan-runs';
import { PLAN_RUN_ORPHAN_FAIL_MS } from '../../agent-tools/plans/runs';
import { writePlanIndexRows } from '../../agent-tools/plans/plan-index-rows';
import type { PlanIndexItem } from '../../agent-tools/plans/derive-index';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-recon';
const HARNESS = 'plan-run-reconcile-fixture';
let wiSeq = 0;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
});
afterAll(async () => {
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS}`;
  await sql`DELETE FROM harness_shared.harness_features_consolidated WHERE harness_slug = ${HARNESS} AND workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.harness_plans WHERE harness_slug = ${HARNESS} AND workspace_id = ${WS}`;
});

/** Seed a running scheduled plan_run; returns its id. */
async function seedRun(planSlug: string): Promise<number> {
  const now = Date.now();
  const rows = await sql<{ id: number }[]>`
    INSERT INTO harness_shared.plan_runs
      (harness_slug, plan_slug, plan_content_hash, session_id, launched_by, launched_at,
       status, title, updated_at, run_type, trigger, run_seq)
    VALUES (${HARNESS}, ${planSlug}, 'h', ${'sched:' + planSlug + now}, 'system:plan-run', ${now},
            'running', 'r', ${now}, 'scheduled', 'scheduled', 0)
    RETURNING id`;
  return Number(rows[0].id);
}

/** Seed a work_item for a run with the given status. */
async function seedWi(runId: number, status: string): Promise<void> {
  const now = Date.now();
  const fid = `PR-${runId}-${++wiSeq}`;
  await sql.unsafe(
    `INSERT INTO harness_shared.harness_features_consolidated
       (harness_slug, feature_id, title, status, attempts, item_kind, payload, needs_human_review, workspace_id, ts, created_ts, updated_ts, source_plan_slug)
     VALUES ($1,$2,$3,$4,0,'feature',$5::text::jsonb,FALSE,$6,$7,$7,$7,$8)`,
    [HARNESS, fid, 'wi', status, JSON.stringify({ plan_run: { runId } }), WS, now, 'tmpl'],
  );
}

async function runRow(id: number) {
  const r = await sql<{ status: string; outcome: string | null; finished_at: number | null }[]>`
    SELECT status, outcome, finished_at FROM harness_shared.plan_runs WHERE id = ${id}`;
  return r[0];
}

async function instancePlanRow(slug: string) {
  const rows = await sql<{ status: string; template_slug: string | null }[]>`
    SELECT status, template_slug
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
  return rows[0];
}

describe('reconcileScheduledPlanRuns', () => {
  it('leaves a run running while any work_item is non-terminal', async () => {
    const id = await seedRun('p-running');
    await seedWi(id, 'todo');
    await seedWi(id, 'passed');
    const res = await reconcileScheduledPlanRuns({ sql });
    expect(res.reconciled).toBe(0);
    expect((await runRow(id)).status).toBe('running');
  });

  it('settles success when all work_items passed', async () => {
    const id = await seedRun('p-success');
    await seedWi(id, 'passed');
    await seedWi(id, 'done');
    const res = await reconcileScheduledPlanRuns({ sql });
    expect(res.reconciled).toBe(1);
    const row = await runRow(id);
    expect(row.status).toBe('done');
    expect(row.outcome).toBe('success');
    expect(row.finished_at).not.toBeNull();
  });

  it('supersedes the active instance plan when its scheduled run settles', async () => {
    const id = await seedRun('p-instance');
    const instanceSlug = `p-instance@run-${id}`;
    await sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, status, template_slug)
      VALUES (${WS}, ${HARNESS}, ${instanceSlug}, 'active', 'p-instance')`;
    await sql`
      UPDATE harness_shared.plan_runs
         SET workspace_id = ${WS}, instance_plan_slug = ${instanceSlug}
       WHERE id = ${id}`;
    await reconcileScheduledPlanRuns({ sql });

    expect(await instancePlanRow(instanceSlug)).toEqual({ status: 'superseded', template_slug: 'p-instance' });
    expect((await runRow(id)).status).toBe('done');
  });

  /**
   * WI-10005040 — retiring the instance used to flip ONLY harness_plans.status, so the
   * instance's never-promoted plan_items stayed `todo` on a superseded plan forever
   * (28 phantom-open items on 10 instances, +~3 per fire). The retirement must close
   * the items in the `items` jsonb AND the derived `plan_items` index, together.
   */
  it('closes the instance plan_items (jsonb + index) when it retires the plan', async () => {
    const id = await seedRun('p-phantom');
    const instanceSlug = `p-phantom@run-${id}`;
    const item = (id: string, status: string, text: string): PlanIndexItem => ({
      id,
      status,
      text,
      importance: 'normal',
      blockedBy: [],
      decisionRefs: [],
      phase: null,
    });
    const items = [
      item('P-001', 'todo', 'never promoted'),
      item('P-002', 'done', 'completed by a work-item'),
      item('P-003', 'wip', 'never promoted either'),
    ];
    const content = [
      '---',
      'status: active',
      '---',
      '# Instance',
      '',
      '- **P-001** `todo` never promoted',
      '- **P-002** `done` completed by a work-item',
      '- **P-003** `wip` never promoted either',
      '',
    ].join('\n');
    await sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, status, template_slug, content, content_hash, items)
      VALUES (${WS}, ${HARNESS}, ${instanceSlug}, 'active', 'p-phantom', ${content}, 'h',
              ${JSON.stringify(items)}::text::jsonb)`;
    await writePlanIndexRows(
      sql as unknown as Parameters<typeof writePlanIndexRows>[0],
      { workspaceId: WS, harnessSlug: HARNESS, planSlug: instanceSlug },
      { items, decisions: [] },
    );
    await sql`
      UPDATE harness_shared.plan_runs
         SET workspace_id = ${WS}, instance_plan_slug = ${instanceSlug}, launched_at = 0
       WHERE id = ${id}`;

    await reconcileScheduledPlanRuns({ sql });

    expect(await instancePlanRow(instanceSlug)).toEqual({ status: 'superseded', template_slug: 'p-phantom' });
    const [plan] = await sql<{ items: Array<{ id: string; status: string }>; content: string }[]>`
      SELECT items, content FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${instanceSlug}`;
    expect(plan.items.map((i) => [i.id, i.status])).toEqual([
      ['P-001', 'dropped'],
      ['P-002', 'done'],
      ['P-003', 'dropped'],
    ]);
    expect(plan.content).toMatch(/^status: superseded$/m);
    // The derived index — what plans:items / the open-item counters actually read.
    const indexed = await sql<{ item_id: string; status: string }[]>`
      SELECT item_id, status FROM harness_shared.plan_items
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${instanceSlug}
       ORDER BY seq`;
    expect(indexed.map((r) => [r.item_id, r.status])).toEqual([
      ['P-001', 'dropped'],
      ['P-002', 'done'],
      ['P-003', 'dropped'],
    ]);
  });

  it('settles partial when some passed and some failed', async () => {
    const id = await seedRun('p-partial');
    await seedWi(id, 'passed');
    await seedWi(id, 'failed');
    await reconcileScheduledPlanRuns({ sql });
    expect((await runRow(id)).outcome).toBe('partial');
  });

  it('settles failed (status=failed) when all failed', async () => {
    const id = await seedRun('p-failed');
    await seedWi(id, 'failed');
    await seedWi(id, 'dropped');
    await reconcileScheduledPlanRuns({ sql });
    const row = await runRow(id);
    expect(row.outcome).toBe('failed');
    expect(row.status).toBe('failed');
  });

  it('settles a no-work (prose) run as success immediately', async () => {
    const id = await seedRun('p-nowork');
    const res = await reconcileScheduledPlanRuns({ sql });
    expect(res.reconciled).toBe(1);
    expect((await runRow(id)).outcome).toBe('success');
  });

  /*
   * WI-10004731 — a fire that threw after its seed transaction left a run with
   * zero work-items whose instance still has OPEN items. That is "promotion
   * never completed", not a prose plan; it was being settled done/success, so
   * every refused plan-cleanup sweep fire (2026-09-07, 09-14, 10-01) read as a
   * healthy run.
   */
  describe('zero work-items on an instance with open items (WI-10004731)', () => {
    async function seedUnpromoted(slug: string, ageMs: number): Promise<number> {
      const id = await seedRun(slug);
      const instanceSlug = `${slug}@run-${id}`;
      await sql`
        INSERT INTO harness_shared.harness_plans
          (workspace_id, harness_slug, plan_slug, status, template_slug, items)
        VALUES (${WS}, ${HARNESS}, ${instanceSlug}, 'active', ${slug},
                ${JSON.stringify([{ id: 'P-001', status: 'todo' }, { id: 'P-002', status: 'done' }])}::text::jsonb)`;
      await sql`
        UPDATE harness_shared.plan_runs
           SET workspace_id = ${WS}, instance_plan_slug = ${instanceSlug}, launched_at = ${Date.now() - ageMs}
         WHERE id = ${id}`;
      return id;
    }

    it('settles it FAILED with a reason once the grace window has passed', async () => {
      const id = await seedUnpromoted('p-unpromoted', PLAN_RUN_PROMOTION_GRACE_MS + 60_000);
      const res = await reconcileScheduledPlanRuns({ sql });
      expect(res.settled).toEqual([expect.objectContaining({ runId: id, outcome: 'failed' })]);
      const row = await runRow(id);
      expect(row.status).toBe('failed');
      expect(row.outcome).toBe('failed');
      const [summary] = await sql<{ note: string | null }[]>`
        SELECT note FROM harness_shared.plan_runs WHERE id = ${id}`;
      expect(summary.note).toMatch(/promotion never completed/);
    });

    it('leaves it running inside the grace window, so an in-flight promotion is never raced', async () => {
      const id = await seedUnpromoted('p-promoting', 5_000);
      const res = await reconcileScheduledPlanRuns({ sql });
      expect(res.reconciled).toBe(0);
      expect((await runRow(id)).status).toBe('running');
    });

    it('still settles success when every instance item is already terminal (nothing to promote)', async () => {
      const id = await seedRun('p-all-done');
      const instanceSlug = `p-all-done@run-${id}`;
      await sql`
        INSERT INTO harness_shared.harness_plans
          (workspace_id, harness_slug, plan_slug, status, template_slug, items)
        VALUES (${WS}, ${HARNESS}, ${instanceSlug}, 'active', 'p-all-done',
                ${JSON.stringify([{ id: 'P-001', status: 'done' }])}::text::jsonb)`;
      await sql`
        UPDATE harness_shared.plan_runs
           SET workspace_id = ${WS}, instance_plan_slug = ${instanceSlug}, launched_at = 0
         WHERE id = ${id}`;
      await reconcileScheduledPlanRuns({ sql });
      expect((await runRow(id)).outcome).toBe('success');
    });
  });
});

/** Seed an ARMED template (schedule_active=true). */
async function seedArmedTemplate(planSlug: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, schedule, schedule_active)
    VALUES (${WS}, ${HARNESS}, ${planSlug}, 'T', 'active', '#T', 'h',
            ${JSON.stringify({ kind: 'cron', cron: '0 9 * * *' })}::text::jsonb, true)`;
}
/** Seed a settled scheduled run with an outcome at an explicit launched_at (ordering). */
async function seedSettledRun(planSlug: string, outcome: 'success' | 'partial' | 'failed', at: number): Promise<void> {
  await sql`
    INSERT INTO harness_shared.plan_runs
      (harness_slug, plan_slug, plan_content_hash, session_id, launched_by, launched_at,
       status, title, updated_at, run_type, trigger, run_seq, outcome, finished_at)
    VALUES (${HARNESS}, ${planSlug}, 'h', ${'s-' + planSlug + '-' + at}, 'system:plan-run', ${at},
            ${outcome === 'failed' ? 'failed' : 'done'}, 'r', ${at}, 'scheduled', 'scheduled', 0, ${outcome}, ${at})`;
}
async function templateArmed(planSlug: string): Promise<boolean> {
  const r = await sql<{ schedule_active: boolean }[]>`
    SELECT schedule_active FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${planSlug}`;
  return r[0]?.schedule_active ?? false;
}

describe('autoPauseOnFailureStreak (P-012, D-011)', () => {
  const T0 = 1_780_000_000_000;
  it('disarms after K consecutive failed runs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedArmedTemplate('p-streak');
    await seedSettledRun('p-streak', 'failed', T0 + 1);
    await seedSettledRun('p-streak', 'failed', T0 + 2);
    await seedSettledRun('p-streak', 'failed', T0 + 3);
    const r = await autoPauseOnFailureStreak({ sql, harnessSlug: HARNESS, planSlug: 'p-streak', k: 3 });
    expect(r.paused).toBe(true);
    expect(await templateArmed('p-streak')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('auto-paused'));
    warn.mockRestore();
  });

  it('does NOT disarm with fewer than K failures', async () => {
    await seedArmedTemplate('p-two');
    await seedSettledRun('p-two', 'failed', T0 + 1);
    await seedSettledRun('p-two', 'failed', T0 + 2);
    const r = await autoPauseOnFailureStreak({ sql, harnessSlug: HARNESS, planSlug: 'p-two', k: 3 });
    expect(r.paused).toBe(false);
    expect(await templateArmed('p-two')).toBe(true);
  });

  it('does NOT disarm when the streak is broken by a recent success', async () => {
    await seedArmedTemplate('p-broken');
    await seedSettledRun('p-broken', 'failed', T0 + 1);
    await seedSettledRun('p-broken', 'failed', T0 + 2);
    await seedSettledRun('p-broken', 'success', T0 + 3); // most recent succeeded
    const r = await autoPauseOnFailureStreak({ sql, harnessSlug: HARNESS, planSlug: 'p-broken', k: 3 });
    expect(r.paused).toBe(false);
    expect(await templateArmed('p-broken')).toBe(true);
  });

  it('is a no-op on an already-disarmed template', async () => {
    // no seedArmedTemplate → schedule_active defaults false (and no row)
    const r = await autoPauseOnFailureStreak({ sql, harnessSlug: HARNESS, planSlug: 'p-absent', k: 3 });
    expect(r.paused).toBe(false);
  });
});

/**
 * RECURRENCE GUARD — orphan reclamation must ride the TICK, not only the `plans:runs` read.
 *
 * The damage this prevents (measured 2026-08-16): `sweepPlanRuns` implements running→failed
 * for an orphaned run, but its only caller was the `plans:runs` UI read. An orphan therefore
 * survived until a human opened the Runs tab — and because `runScheduledPlanFire` refuses to
 * mint while ANY run of the template is `running` (concurrency='skip'), that one row silently
 * disabled the whole schedule. It happened to `blender-steward-heartbeat-2026-08-11`, the
 * recovery heartbeat for a dead Blender GOAL steward: nobody was around to execute the run,
 * so nobody was around to read the tab either, and the recovery stayed dead ~21h while the
 * routine kept ticking and minting nothing.
 *
 * These tests drive ONLY reconcileAndGovern (the tick path). If someone unwires the sweep
 * again, the first test fails instead of a schedule going quietly dark.
 */
describe('reconcileAndGovern — orphaned-run reclamation on the tick', () => {
  /** Age a run's updated_at so it is past the orphan threshold. */
  async function ageRun(id: number, byMs: number): Promise<void> {
    await sql`UPDATE harness_shared.plan_runs
                 SET updated_at = ${Date.now() - byMs}
               WHERE id = ${id}`;
  }

  it('reclaims a run stuck running past the threshold WITHOUT any plans:runs read', async () => {
    const id = await seedRun('p-orphan');
    // Non-terminal work_item: reconcile alone can never settle this run, which is exactly
    // the state an abandoned run is left in.
    await seedWi(id, 'todo');
    await ageRun(id, PLAN_RUN_ORPHAN_FAIL_MS + 60_000);

    const res = await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    expect(res.orphaned).toBe(1);
    expect((await runRow(id)).status).toBe('failed');
  });

  it('clears the concurrency=skip precondition, so the template can fire again', async () => {
    const id = await seedRun('p-wedged');
    await seedWi(id, 'todo');
    await ageRun(id, PLAN_RUN_ORPHAN_FAIL_MS + 60_000);

    await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    // This is the query runScheduledPlanFire uses to decide whether to skip the fire.
    const stillRunning = await sql<{ id: number }[]>`
      SELECT id FROM harness_shared.plan_runs
       WHERE harness_slug = ${HARNESS} AND plan_slug = 'p-wedged' AND status = 'running'`;
    expect(stillRunning).toHaveLength(0);
  });

  it('does NOT reclaim a fresh running run — a live run must survive the tick', async () => {
    const id = await seedRun('p-live');
    await seedWi(id, 'todo');
    // updated_at = now (seedRun), i.e. well inside the threshold.

    const res = await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    expect(res.orphaned).toBe(0);
    expect((await runRow(id)).status).toBe('running');
  });

  it('prefers a real reconcile outcome over force-failing: terminal items settle as success', async () => {
    const id = await seedRun('p-finished');
    await seedWi(id, 'done');
    // Old enough that a sweep-first ordering would have force-failed it with a NULL outcome.
    await ageRun(id, PLAN_RUN_ORPHAN_FAIL_MS + 60_000);

    const res = await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    const row = await runRow(id);
    expect(row.status).toBe('done');
    expect(row.outcome).toBe('success');
    expect(res.orphaned).toBe(0);
  });
});

/**
 * WI-6554700010010446 — the orphan sweep's verdict is provisional. It fails a run that made
 * no progress for 30 min so concurrency='skip' can fire again, but it never saw the work
 * finish, and it leaves the run's work-items open (each is a real request; a recoverable
 * dispatch failure keeps one queued for its target while the trigger retries). Before this,
 * reconcile only read `running` runs, so a late completion never reached the ledger: the run
 * stayed failed with a NULL outcome forever.
 */
describe('reconcileAndGovern — an orphan verdict is provisional', () => {
  async function orphan(planSlug: string, wiStatus: string | null): Promise<number> {
    const id = await seedRun(planSlug);
    if (wiStatus) await seedWi(id, wiStatus);
    await sql`UPDATE harness_shared.plan_runs
                 SET updated_at = ${Date.now() - PLAN_RUN_ORPHAN_FAIL_MS - 60_000}
               WHERE id = ${id}`;
    return id;
  }

  async function wiStatuses(runId: number): Promise<string[]> {
    const rows = await sql<{ status: string }[]>`
      SELECT status FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${HARNESS} AND payload -> 'plan_run' ->> 'runId' = ${String(runId)}`;
    return rows.map((r) => r.status);
  }

  async function note(runId: number): Promise<string | null> {
    const [r] = await sql<{ note: string | null }[]>`SELECT note FROM harness_shared.plan_runs WHERE id = ${runId}`;
    return r.note;
  }

  it('fails the run with a NULL outcome and a provisional note, and leaves its work-items open', async () => {
    const id = await orphan('p-prov', 'todo');

    const res = await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    expect(res.orphaned).toBe(1);
    expect(await runRow(id)).toMatchObject({ status: 'failed', outcome: null, finished_at: null });
    expect(await note(id)).toMatch(/provisional/);
    expect(await wiStatuses(id)).toEqual(['todo']);
  });

  it('records the real outcome once the work-items terminate after the sweep', async () => {
    const id = await orphan('p-late', 'todo');
    await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    await sql`UPDATE harness_shared.harness_features_consolidated SET status = 'done'
               WHERE harness_slug = ${HARNESS} AND payload -> 'plan_run' ->> 'runId' = ${String(id)}`;
    const res = await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    expect(res.reconciled).toBe(1);
    expect(res.orphaned).toBe(0);
    const row = await runRow(id);
    expect(row).toMatchObject({ status: 'done', outcome: 'success' });
    expect(row.finished_at).not.toBeNull();
    expect(await note(id)).toMatch(/orphan verdict superseded/);
  });

  it('records partial when a late completion is mixed', async () => {
    const id = await orphan('p-late-mixed', 'todo');
    await seedWi(id, 'todo');
    await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    const fids = await sql<{ feature_id: string }[]>`
      SELECT feature_id FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${HARNESS} AND payload -> 'plan_run' ->> 'runId' = ${String(id)}
       ORDER BY feature_id`;
    await sql`UPDATE harness_shared.harness_features_consolidated SET status = 'done' WHERE harness_slug = ${HARNESS} AND feature_id = ${fids[0].feature_id}`;
    await sql`UPDATE harness_shared.harness_features_consolidated SET status = 'dropped' WHERE harness_slug = ${HARNESS} AND feature_id = ${fids[1].feature_id}`;
    await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    expect(await runRow(id)).toMatchObject({ status: 'done', outcome: 'partial' });
  });

  it('keeps the orphan verdict while any work-item is still open', async () => {
    const id = await orphan('p-still-open', 'todo');
    await seedWi(id, 'done');
    await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    const res = await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    expect(res.reconciled).toBe(0);
    expect(await runRow(id)).toMatchObject({ status: 'failed', outcome: null });
  });

  it('keeps the verdict of an orphan with no work-items (no new evidence)', async () => {
    const id = await seedRun('p-orphan-empty');
    await sql`UPDATE harness_shared.plan_runs SET status = 'failed', outcome = NULL WHERE id = ${id}`;

    const res = await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    expect(res.reconciled).toBe(0);
    expect(await runRow(id)).toMatchObject({ status: 'failed', outcome: null });
  });

  it('never re-settles a failed run that already carries an outcome', async () => {
    const id = await seedRun('p-settled-failed');
    await seedWi(id, 'done');
    await sql`UPDATE harness_shared.plan_runs SET status = 'failed', outcome = 'failed' WHERE id = ${id}`;

    const res = await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    expect(res.reconciled).toBe(0);
    expect(await runRow(id)).toMatchObject({ status: 'failed', outcome: 'failed' });
  });
});

/**
 * WI-6554700010009851 — a settled run's instance plan must be retired WHOEVER settled the
 * run. The status-only settlers (the orphan sweep, `sweepPlanRuns` on the read path, a
 * manual archive) never retired it, and the retire guard only matched `active`, so an
 * instance cloned with its template's `ready`/`draft` frontmatter was skipped even by the
 * settlers that did try. Measured 2026-10-13: 18 live instances under settled runs.
 */
describe('reconcileAndGovern — settled-run instance convergence', () => {
  async function attachInstance(runId: number, template: string, status: string): Promise<string> {
    const instanceSlug = `${template}@run-${runId}`;
    const items: PlanIndexItem[] = [
      { id: 'P-001', status: 'todo', text: 'never promoted', importance: 'normal', blockedBy: [], decisionRefs: [], phase: null },
    ];
    const content = ['---', `status: ${status}`, '---', '# Instance', '', '- **P-001** `todo` never promoted', ''].join('\n');
    await sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, status, template_slug, content, content_hash, items)
      VALUES (${WS}, ${HARNESS}, ${instanceSlug}, ${status}, ${template}, ${content}, 'h',
              ${JSON.stringify(items)}::text::jsonb)`;
    await writePlanIndexRows(
      sql as unknown as Parameters<typeof writePlanIndexRows>[0],
      { workspaceId: WS, harnessSlug: HARNESS, planSlug: instanceSlug },
      { items, decisions: [] },
    );
    await sql`
      UPDATE harness_shared.plan_runs
         SET workspace_id = ${WS}, instance_plan_slug = ${instanceSlug}
       WHERE id = ${runId}`;
    return instanceSlug;
  }

  async function settleRun(id: number, status: string, outcome: string | null): Promise<void> {
    await sql`UPDATE harness_shared.plan_runs SET status = ${status}, outcome = ${outcome} WHERE id = ${id}`;
  }

  async function instanceState(slug: string) {
    const [plan] = await sql<{ status: string; items: Array<{ id: string; status: string }>; content: string }[]>`
      SELECT status, items, content FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
    const indexed = await sql<{ status: string }[]>`
      SELECT status FROM harness_shared.plan_items
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
    return {
      status: plan.status,
      itemStatuses: plan.items.map((i) => i.status),
      indexStatuses: indexed.map((r) => r.status),
      frontmatterSuperseded: /^status: superseded$/m.test(plan.content),
    };
  }

  it('retires an orphan-failed run instance once its work-items terminate — not before', async () => {
    const id = await seedRun('p-orphan-instance');
    const slug = await attachInstance(id, 'p-orphan-instance', 'active');
    await seedWi(id, 'todo');
    await sql`UPDATE harness_shared.plan_runs SET updated_at = ${Date.now() - PLAN_RUN_ORPHAN_FAIL_MS - 60_000} WHERE id = ${id}`;

    const first = await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    // The orphan sweep failed the run, but its work-item is still open: a late executor
    // may yet complete it, so the instance must stay live for that reflection to land.
    expect(first.orphaned).toBe(1);
    expect((await runRow(id)).status).toBe('failed');
    expect(first.instancesRetired).toBe(0);
    expect((await instanceState(slug)).status).toBe('active');

    await sql`UPDATE harness_shared.harness_features_consolidated SET status = 'dropped'
               WHERE harness_slug = ${HARNESS} AND payload -> 'plan_run' ->> 'runId' = ${String(id)}`;
    const second = await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    // Reconcile re-settles the orphan with its real outcome (WI-6554700010010446) and retires
    // the instance inline, so the convergence sweep behind it finds nothing left to do.
    expect(second.reconciled).toBe(1);
    expect(second.instancesRetired).toBe(0);
    expect(await runRow(id)).toMatchObject({ status: 'failed', outcome: 'failed' });
    expect(await instanceState(slug)).toEqual({
      status: 'superseded',
      itemStatuses: ['dropped'],
      indexStatuses: ['dropped'],
      frontmatterSuperseded: true,
    });
  });

  it.each(['ready', 'draft', 'awaiting-acceptance'])(
    "retires a '%s' instance under a settled run (the retire guard is not active-only)",
    async (instanceStatus) => {
      const template = `p-${instanceStatus}-instance`;
      const id = await seedRun(template);
      const slug = await attachInstance(id, template, instanceStatus);
      await seedWi(id, 'done');
      await settleRun(id, 'done', 'success');

      const res = await reconcileAndGovern({ sql, harnessSlug: HARNESS });

      expect(res.instancesRetired).toBe(1);
      expect(await instanceState(slug)).toEqual({
        status: 'superseded',
        itemStatuses: ['dropped'],
        indexStatuses: ['dropped'],
        frontmatterSuperseded: true,
      });
    },
  );

  it('retires the instance of an archived run with no work-items (a status-only manual settle)', async () => {
    const id = await seedRun('p-archived-instance');
    const slug = await attachInstance(id, 'p-archived-instance', 'active');
    await settleRun(id, 'archived', null);

    const res = await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    expect(res.instancesRetired).toBe(1);
    expect((await instanceState(slug)).status).toBe('superseded');
  });

  it('leaves a still-running run instance alone', async () => {
    const id = await seedRun('p-live-instance');
    const slug = await attachInstance(id, 'p-live-instance', 'active');
    await seedWi(id, 'todo');

    const res = await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    expect(res.instancesRetired).toBe(0);
    expect((await runRow(id)).status).toBe('running');
    expect((await instanceState(slug)).status).toBe('active');
  });

  it('is idempotent: a second tick retires nothing more', async () => {
    const id = await seedRun('p-idempotent-instance');
    await attachInstance(id, 'p-idempotent-instance', 'ready');
    await settleRun(id, 'failed', 'failed');

    expect((await reconcileAndGovern({ sql, harnessSlug: HARNESS })).instancesRetired).toBe(1);
    expect((await reconcileAndGovern({ sql, harnessSlug: HARNESS })).instancesRetired).toBe(0);
  });
});
