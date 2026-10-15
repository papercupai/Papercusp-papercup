/**
 * stale-paused-routines.integration.test.ts — `readStalePausedRoutines` against a
 * real Postgres (EI-18718973731535914).
 *
 * Two root causes fixed at the SQL layer — invisible to a fake-sql unit test, since
 * the exclusion logic lives in the query itself, not in `computeStalePausedRoutines`:
 *
 *  1. NO WORKSPACE SCOPING: the original query had no `workspace_id` predicate at
 *     all, so it read stale-paused rows across EVERY tenant in the database — the
 *     same bare-filter multi-tenant trap `dev:pg_query`'s own advisory warns about.
 *  2. NO ACTIVE-SIBLING CHECK: an inactive row was reported as a "stale pause" purely
 *     because it existed, even when a healthy ACTIVE row for the very same
 *     (workspace, install_slug, name) was firing normally right alongside it — one
 *     orphaned/duplicate dead row could outvote 13 healthy ones (the exact repro:
 *     "green-checkpoint: ONE row active=false … sitting alongside 13 healthy active
 *     ones").
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const { readStalePausedRoutines } = await import('./compute');

let rootSql: postgres.Sql;
let db: OrgTestDb;

beforeAll(async () => {
  // The reader also resolves its acceptance-backlog subquery's plan schema,
  // even when this case seeds only a non-grading routine. Share the current
  // migration-keyed fixture rather than maintaining a private table subset.
  db = await createOrgTestDb();
  rootSql = db.adminSql;
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.routines, harness_shared.harness_plans CASCADE`;
});

async function insertRoutine(o: {
  id: string;
  name: string;
  installSlug: string;
  workspaceId: string;
  active: boolean;
  updatedAt?: Date;
  metadata?: Record<string, unknown> | null;
}, sql: postgres.Sql | postgres.TransactionSql = rootSql) {
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, updated_at, workspace_id, metadata)
    VALUES (${o.id}, ${o.installSlug}, ${o.name}, 'schedule', '{}'::jsonb, 'system:loop-wake',
            ${o.active}, ${o.updatedAt ?? new Date()}, ${o.workspaceId}, ${o.metadata ? JSON.stringify(o.metadata) : null}::text::jsonb)`;
}

const oldPause = () => new Date(Date.now() - 11.5 * 60 * 60_000); // 11.5h ago — past the 4h critical threshold

async function insertPlan(o: {
  slug: string;
  workspaceId: string;
  status: 'ready' | 'awaiting-acceptance';
  template?: string;
  archived?: boolean;
}) {
  await rootSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, status, template, archived)
    VALUES (${o.workspaceId}, 'papercusp', ${o.slug}, ${o.status},
            ${o.template ?? null}, ${o.archived ?? false})`;
}

describe('readStalePausedRoutines — canonical acceptance-backlog projection (WI-10006323)', () => {
  it('counts only current-workspace awaiting plans that are neither rubrics nor archived', async () => {
    const at = new Date();
    await insertRoutine({
      id: 'grading-paused', name: 'acceptance-grading-sweep', installSlug: 'papercusp',
      workspaceId: 'ws1', active: false, updatedAt: at,
      metadata: { pause: { pausedAtMs: at.getTime(), reason: 'attributed recent pause' } },
    });
    await insertPlan({ slug: 'other-workspace', workspaceId: 'ws-other', status: 'awaiting-acceptance' });
    await insertPlan({ slug: 'ready', workspaceId: 'ws1', status: 'ready' });
    await insertPlan({ slug: 'rubric', workspaceId: 'ws1', status: 'awaiting-acceptance', template: 'rubric' });
    await insertPlan({ slug: 'archived', workspaceId: 'ws1', status: 'awaiting-acceptance', archived: true });
    expect(await readStalePausedRoutines(rootSql, 'papercusp', 'ws1')).toEqual([]);

    await insertPlan({ slug: 'awaiting', workspaceId: 'ws1', status: 'awaiting-acceptance' });
    const rows = await readStalePausedRoutines(rootSql, 'papercusp', 'ws1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'acceptance-grading-sweep', backlogDepth: 1, reasonMissing: false });

    await rootSql`
      UPDATE harness_shared.harness_plans SET status = 'ready'
       WHERE workspace_id = 'ws1' AND harness_slug = 'papercusp' AND plan_slug = 'awaiting'`;
    expect(await readStalePausedRoutines(rootSql, 'papercusp', 'ws1')).toEqual([]);
  });

  it('does not attach an acceptance backlog to an unrelated paused routine', async () => {
    const at = new Date();
    await insertRoutine({
      id: 'scout-paused', name: 'scout-cycle', installSlug: 'papercusp',
      workspaceId: 'ws1', active: false, updatedAt: at,
      metadata: { pause: { pausedAtMs: at.getTime(), reason: 'attributed recent pause' } },
    });
    await insertPlan({ slug: 'awaiting', workspaceId: 'ws1', status: 'awaiting-acceptance' });
    expect(await readStalePausedRoutines(rootSql, 'papercusp', 'ws1')).toEqual([]);
  });
});

describe('readStalePausedRoutines — SQL-level scoping (EI-18718973731535914)', () => {
  it('excludes an inactive row belonging to a DIFFERENT workspace (no cross-tenant leak)', async () => {
    await insertRoutine({ id: 'other-ws-dead', name: 'scout-cycle', installSlug: 'some-hive', workspaceId: 'ws-other', active: false, updatedAt: oldPause() });
    const r = await readStalePausedRoutines(rootSql, 'papercusp', 'ws1');
    expect(r).toEqual([]);
  });

  it('reports an inactive row scoped to the CURRENT workspace', async () => {
    await insertRoutine({ id: 'this-ws-dead', name: 'scout-cycle', installSlug: 'papercusp', workspaceId: 'ws1', active: false, updatedAt: oldPause() });
    const r = await readStalePausedRoutines(rootSql, 'papercusp', 'ws1');
    expect(r.map((x) => x.name)).toEqual(['scout-cycle']);
  });

  it('excludes an inactive row when a HEALTHY ACTIVE sibling exists for the same (workspace, install, name) — the "13 healthy outvoted by 1 dead row" repro', async () => {
    await rootSql.begin(async (sql) => {
      // Reproduce the historical duplicate rows this control protects against.
      // Current uniqueness prevents seeding them normally; confine that legacy
      // shape to this transaction and restore both keys before committing.
      // An assertion failure rolls back the DDL as well as the seeded rows.
      await sql.unsafe(`
        ALTER TABLE harness_shared.routines DROP CONSTRAINT routines_install_slug_name_key;
        DROP INDEX harness_shared.routines_workspace_install_slug_name_key;
      `);
      await insertRoutine({ id: 'gc-orphan', name: 'green-checkpoint', installSlug: 'papercusp', workspaceId: 'ws1', active: false, updatedAt: oldPause() }, sql);
      await insertRoutine({ id: 'gc-live', name: 'green-checkpoint', installSlug: 'papercusp', workspaceId: 'ws1', active: true }, sql);
      // The reader uses the tag/unsafe API shared by a client and transaction.
      expect(await readStalePausedRoutines(sql as never, 'papercusp', 'ws1')).toEqual([]);
      await sql`DELETE FROM harness_shared.routines WHERE id = 'gc-orphan'`;
      await sql.unsafe(`
        ALTER TABLE harness_shared.routines
          ADD CONSTRAINT routines_install_slug_name_key UNIQUE (install_slug, name);
        CREATE UNIQUE INDEX routines_workspace_install_slug_name_key
          ON harness_shared.routines (workspace_id, install_slug, name);
      `);
    });
  });

  it('still reports an inactive row when NO active sibling exists for it (a genuine stale pause)', async () => {
    await insertRoutine({ id: 'rt-dead', name: 'release-trigger', installSlug: 'papercusp', workspaceId: 'ws1', active: false, updatedAt: oldPause() });
    const r = await readStalePausedRoutines(rootSql, 'papercusp', 'ws1');
    expect(r.map((x) => x.name)).toEqual(['release-trigger']);
    expect(r[0].critical).toBe(true);
  });

  it('a same-named active sibling on a DIFFERENT install does NOT suppress the dead row (siblings must match install_slug too)', async () => {
    await insertRoutine({ id: 'gc-dead-a', name: 'green-checkpoint', installSlug: 'install-a', workspaceId: 'ws1', active: false, updatedAt: oldPause() });
    await insertRoutine({ id: 'gc-live-b', name: 'green-checkpoint', installSlug: 'install-b', workspaceId: 'ws1', active: true });
    const r = await readStalePausedRoutines(rootSql, 'install-a', 'ws1');
    expect(r.map((x) => x.name)).toEqual(['green-checkpoint']);
    expect(r[0].critical).toBe(true);
  });
});

/**
 * EI-18137248342636257 — the decommissioned-age exemption must not silence an
 * ALWAYS-ON system routine whose pause was never re-affirmed.
 *
 * The measured repro (2026-08-23): twelve `cross-hive-outbox-drain` rows — a
 * BESPOKE_ACTIVE_SEEDS registry routine — sat dark 13.6d carrying the reason
 * "Owner directive 2026-08-09 (Avi, interactive): pause p2p work - machine churning.
 * Reversible; resume with active:true", every one with `reviewBy: null`, and the 7d
 * cutoff had silenced all twelve since day 7.
 *
 * These run through `readStalePausedRoutines` (not the pure compute) on purpose: the
 * fix spans BOTH halves — the exemption logic AND the reader that must actually
 * project `metadata.pause.reviewBy`. A pure-function test would pass with the reader
 * still dropping the field, leaving the fix inert against the real table.
 */
describe('readStalePausedRoutines — always-on routines outrun the decommissioned cutoff (EI-18137248342636257)', () => {
  const DAYS = 24 * 60 * 60_000;
  const longDeadPause = () => new Date(Date.now() - 13.6 * DAYS); // past the 7d decommissioned cutoff
  // A BESPOKE_ACTIVE_SEEDS registry name; 'scout-cycle' below is deliberately NOT one.
  const ALWAYS_ON = 'cross-hive-outbox-drain';
  const attributedPause = (at: Date, reviewBy?: string) => ({
    pause: {
      pausedAtMs: at.getTime(),
      reason: 'Owner directive 2026-08-09 (Avi, interactive): pause p2p work - machine churning. Reversible; resume with active:true.',
      ...(reviewBy ? { reviewBy } : {}),
    },
  });

  it('REGRESSION: an always-on routine dark 13.6d with an attributed, never-re-affirmed pause is STILL reported', async () => {
    const at = longDeadPause();
    await insertRoutine({ id: 'drain-dark', name: ALWAYS_ON, installSlug: 'papercusp', workspaceId: 'ws1', active: false, updatedAt: at, metadata: attributedPause(at) });
    const r = await readStalePausedRoutines(rootSql, 'papercusp', 'ws1');
    expect(r.map((x) => x.name)).toEqual([ALWAYS_ON]);
    expect(r[0].alwaysOnUnreaffirmed).toBe(true);
    // The discriminator is re-affirmation, NOT attribution: this pause has a full reason.
    expect(r[0].reasonMissing).toBe(false);
  });

  it('a FUTURE reviewBy re-affirms the pause, so the routine ages out as before', async () => {
    const at = longDeadPause();
    const reviewBy = new Date(Date.now() + 30 * DAYS).toISOString();
    await insertRoutine({ id: 'drain-reaffirmed', name: ALWAYS_ON, installSlug: 'papercusp', workspaceId: 'ws1', active: false, updatedAt: at, metadata: attributedPause(at, reviewBy) });
    const r = await readStalePausedRoutines(rootSql, 'papercusp', 'ws1');
    expect(r).toEqual([]);
  });

  it('FAILS CLOSED: an EXPIRED reviewBy is not a re-affirmation — the routine is reported again', async () => {
    const at = longDeadPause();
    const reviewBy = new Date(Date.now() - 1 * DAYS).toISOString();
    await insertRoutine({ id: 'drain-expired', name: ALWAYS_ON, installSlug: 'papercusp', workspaceId: 'ws1', active: false, updatedAt: at, metadata: attributedPause(at, reviewBy) });
    const r = await readStalePausedRoutines(rootSql, 'papercusp', 'ws1');
    expect(r.map((x) => x.name)).toEqual([ALWAYS_ON]);
    expect(r[0].alwaysOnUnreaffirmed).toBe(true);
  });

  it('FAILS CLOSED: an unparseable reviewBy is not a re-affirmation', async () => {
    const at = longDeadPause();
    await insertRoutine({ id: 'drain-garbage', name: ALWAYS_ON, installSlug: 'papercusp', workspaceId: 'ws1', active: false, updatedAt: at, metadata: attributedPause(at, 'soon-ish') });
    const r = await readStalePausedRoutines(rootSql, 'papercusp', 'ws1');
    expect(r.map((x) => x.name)).toEqual([ALWAYS_ON]);
    expect(r[0].alwaysOnUnreaffirmed).toBe(true);
  });

  it('CALIBRATION CONTROL: a NON-registry routine, identical age and attribution, still ages out (EI-18718973731535914 preserved)', async () => {
    // The widening must stay bounded to the ~28 registry names. If this row starts
    // being reported, the exemption has been broken open and the retired-routine
    // false-alarm class (`hive-wake`) is back.
    const at = longDeadPause();
    await insertRoutine({ id: 'retired-dark', name: 'scout-cycle', installSlug: 'papercusp', workspaceId: 'ws1', active: false, updatedAt: at, metadata: attributedPause(at) });
    const r = await readStalePausedRoutines(rootSql, 'papercusp', 'ws1');
    expect(r).toEqual([]);
  });

  it('alwaysOnUnreaffirmed marks only rows that SURVIVED the cutoff, not every always-on row', async () => {
    // 3d old: past the 24h GENERAL threshold so it is reported anyway, but short of the
    // 7d cutoff, so it never needed the escape hatch — the flag exists to explain a
    // 13-day-old report, not to mark every always-on row.
    const at = new Date(Date.now() - 3 * DAYS);
    await insertRoutine({ id: 'drain-recent', name: ALWAYS_ON, installSlug: 'papercusp', workspaceId: 'ws1', active: false, updatedAt: at, metadata: attributedPause(at) });
    const r = await readStalePausedRoutines(rootSql, 'papercusp', 'ws1');
    expect(r.map((x) => x.name)).toEqual([ALWAYS_ON]);
    expect(r[0].alwaysOnUnreaffirmed).toBe(false);
  });
});
