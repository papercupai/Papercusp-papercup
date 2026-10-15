// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeCompanionSummary,
  type CompanionListSummary,
} from '@papercusp/facets';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { assertMigrationPassesPreApplyLints } from '../migration-preapply-lint';
import {
  NO_SESSION_HARNESS,
  advSessionsSummarySelection,
  buildAdvSessionsPredicate,
  normalizeAdvSessionsListArgs,
  readAdvSessionsPageFromStore,
  readAdvSessionsSummaryFromStore,
  type AdvSessionsListWireArgs,
} from './adv-sessions-list-query';

const ROWS = 15_050;
const workspaceId = 'p10-sessions-ws';
const foreignWorkspaceId = 'p10-sessions-foreign';
const deepPlan = 'p10-deep-plan';
const deepHarness = 'p10-deep-harness';
const deepId = 15_025;
const BASE_TS = 1_900_000_000_000;
const migration = fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/1422-adv-sessions-launch-harness-projection.sql', import.meta.url));
const migrationPath = () => existsSync(migration) ? migration : `${migration}.DRAFT`;
let db: FreshPgDb;
let sql: Sql;
let sessionFilenodeBeforeMigration: number;

const pageFor = async (args: AdvSessionsListWireArgs, cursor: string | null = null) => {
  const normalized = normalizeAdvSessionsListArgs({ ...args, cursor });
  return readAdvSessionsPageFromStore(sql, buildAdvSessionsPredicate(normalized));
};

const summaryFor = async (
  args: AdvSessionsListWireArgs,
): Promise<CompanionListSummary<{ active?: number }>> => {
  const normalized = normalizeAdvSessionsListArgs(args);
  const aggregate = await readAdvSessionsSummaryFromStore(
    sql,
    buildAdvSessionsPredicate(normalized),
  );
  return composeCompanionSummary(aggregate, {
    selection: advSessionsSummarySelection(normalized),
  });
};

beforeAll(async () => {
  db = await createFreshPgDb('adv-sessions-list-query');
  sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    )`);
  await sql.unsafe(`
    CREATE TABLE harness_shared.adv_sessions (
      id serial PRIMARY KEY,
      workspace_id text NOT NULL,
      plan_slug text,
      agent text,
      role text,
      feature text,
      mode text NOT NULL,
      terminal_bin text,
      pid integer,
      window_id text,
      omp_thread_id text,
      label text,
      cwd text,
      coord_owner_id text,
      session_id text,
      launch_spec jsonb,
      started_at timestamptz NOT NULL,
      first_seen_at timestamptz NOT NULL,
      ended_at timestamptz,
      exit_code integer,
      ended_by text,
      ended_signal text
    )`);
  await sql.unsafe(`
    CREATE INDEX adv_sessions_workspace_first_seen_idx
      ON harness_shared.adv_sessions (workspace_id, first_seen_at DESC, id DESC)`);
  await sql`
    INSERT INTO harness_shared.adv_sessions
      (id, workspace_id, mode, launch_spec, started_at, first_seen_at)
    VALUES
      (-3, 'p10-projection-backfill', 'console', NULL, now(), now()),
      (-2, 'p10-projection-backfill', 'console', '{"label":"preserved"}'::jsonb, now(), now()),
      (-1, 'p10-projection-backfill', 'console',
       '{"harnessSlug":"legacy-harness","label":"preserved"}'::jsonb, now(), now())`;
  const file = await sql`SELECT pg_relation_filenode('harness_shared.adv_sessions'::regclass) AS node`;
  sessionFilenodeBeforeMigration = file[0].node;
  await applyMigrationForTest(sql, migrationPath());
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug)
    VALUES
      (${workspaceId}, 'p10-bulk-harness', 'p10-bulk-plan'),
      (${workspaceId}, ${deepHarness}, ${deepPlan})`;
  await sql`
    INSERT INTO harness_shared.adv_sessions
      (workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
       window_id, omp_thread_id, label, cwd, coord_owner_id, session_id,
       launch_spec, started_at, first_seen_at, ended_at, exit_code, ended_by)
    SELECT ${workspaceId},
           CASE WHEN g = ${deepId} THEN ${deepPlan}
                WHEN g = 15040 THEN NULL
                ELSE 'p10-bulk-plan' END,
           'codex',
           CASE WHEN g % 2 = 0 THEN 'engineer' ELSE 'reviewer' END,
           NULL,
           'console',
           'bash',
           1000 + (g % 20000),
           NULL,
           'p10-thread-' || g,
           'session ' || g,
           '/tmp/p10',
           'p10-owner-' || g,
           NULL,
           CASE WHEN g = ${deepId} OR g = 15040 THEN NULL
                ELSE jsonb_build_object('harnessSlug', 'p10-bulk-harness') END,
           to_timestamp((${BASE_TS}::bigint - g) / 1000.0),
           to_timestamp((${BASE_TS}::bigint - g) / 1000.0),
           CASE WHEN g = ${deepId} OR g % 20 = 0 THEN NULL
                ELSE to_timestamp((${BASE_TS}::bigint - g + 3_600_000) / 1000.0) END,
           CASE WHEN g = ${deepId} OR g % 20 = 0 THEN NULL ELSE 0 END,
           CASE WHEN g = ${deepId} OR g % 20 = 0 THEN NULL ELSE 'self' END
      FROM generate_series(1, ${ROWS}) AS g`;

  // Excluded dead-on-arrival audit row and a cross-workspace row: neither may
  // leak into the workspace corpus or its facets.
  await sql`
    INSERT INTO harness_shared.adv_sessions
      (workspace_id, plan_slug, agent, mode, started_at, first_seen_at, ended_at)
    VALUES
      (${workspaceId}, 'p10-bulk-plan', 'omp', 'omp',
       to_timestamp((${BASE_TS}::bigint + 1000) / 1000.0),
       to_timestamp((${BASE_TS}::bigint + 1000) / 1000.0),
       to_timestamp((${BASE_TS}::bigint + 2000) / 1000.0)),
      (${foreignWorkspaceId}, ${deepPlan}, 'codex', 'console',
       to_timestamp((${BASE_TS}::bigint + 2000) / 1000.0),
       to_timestamp((${BASE_TS}::bigint + 2000) / 1000.0), NULL)`;
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
}, 300_000);

describe('advSessions list + summary real-PG P-010 contract', () => {
  it('passes the production migration safety checks before arming or applying', () => {
    expect(() => assertMigrationPassesPreApplyLints({
      filename: basename(migration),
      sqlText: readFileSync(migrationPath(), 'utf8'),
      sqlDir: dirname(migration),
    })).not.toThrow();
  });

  it('backfills existing launch JSON and permits migration replay without changing it', async () => {
    const before = await sql`
      SELECT id, launch_spec, launch_harness_projection
      FROM harness_shared.adv_sessions
      WHERE workspace_id = 'p10-projection-backfill' ORDER BY id`;
    expect(before).toEqual([
      { id: -3, launch_spec: null, launch_harness_projection: null },
      { id: -2, launch_spec: { label: 'preserved' }, launch_harness_projection: null },
      { id: -1, launch_spec: { harnessSlug: 'legacy-harness', label: 'preserved' }, launch_harness_projection: 'legacy-harness' },
    ]);
    await applyMigrationForTest(sql, migrationPath());
    const after = await sql`
      SELECT id, launch_spec, launch_harness_projection
      FROM harness_shared.adv_sessions
      WHERE workspace_id = 'p10-projection-backfill' ORDER BY id`;
    expect(after).toEqual(before);
    const file = await sql`SELECT pg_relation_filenode('harness_shared.adv_sessions'::regclass) AS node`;
    expect(file[0].node).toBe(sessionFilenodeBeforeMigration);
    const pending = await sql`SELECT count(*)::int AS count FROM harness_shared.adv_sessions
      WHERE workspace_id = 'p10-projection-backfill' AND launch_harness_projection IS NULL`;
    expect(pending[0].count).toBe(0);
  });

  it('keeps pending rows exact and repairs direct projection writes', async () => {
    const before = await summaryFor({ workspaceId });
    await sql.unsafe('ALTER TABLE harness_shared.adv_sessions DISABLE TRIGGER adv_sessions_project_launch_harness');
    try {
      await sql`UPDATE harness_shared.adv_sessions SET launch_harness_projection = NULL WHERE id = 1`;
      expect(await summaryFor({ workspaceId })).toEqual(before);
    } finally {
      await sql.unsafe('ALTER TABLE harness_shared.adv_sessions ENABLE TRIGGER adv_sessions_project_launch_harness');
      // A direct write cannot poison the maintained scalar. The trigger always
      // derives it from launch_spec, including this partial-backfill repair.
      await sql`UPDATE harness_shared.adv_sessions SET launch_harness_projection = '"wrong-harness"'::jsonb WHERE id = 1`;
    }
    const projection = await sql`SELECT launch_harness_projection FROM harness_shared.adv_sessions WHERE id = 1`;
    expect(projection[0].launch_harness_projection).toBe('p10-bulk-harness');
    expect(await summaryFor({ workspaceId })).toEqual(before);
  });

  it('keeps launch harness exact across large payload updates and removal', async () => {
    const id = 1;
    const before = await summaryFor({ workspaceId });
    const original = await sql`SELECT launch_spec FROM harness_shared.adv_sessions WHERE id = ${id}`;
    try {
      await sql`UPDATE harness_shared.adv_sessions
        SET launch_spec = jsonb_build_object('harnessSlug', 'large-payload-harness', 'identityHistory', repeat('payload-', 100_000))
        WHERE id = ${id}`;
      const projection = await sql`SELECT launch_harness_projection FROM harness_shared.adv_sessions WHERE id = ${id}`;
      expect(projection[0].launch_harness_projection).toBe('large-payload-harness');
      expect(await summaryFor({ workspaceId, harnessSlugs: ['large-payload-harness'] }))
        .toMatchObject({ total: before.total, matched: 1 });
      await sql`UPDATE harness_shared.adv_sessions SET launch_spec = NULL WHERE id = ${id}`;
      const cleared = await sql`SELECT launch_harness_projection,
        launch_harness_projection IS NULL AS pending FROM harness_shared.adv_sessions WHERE id = ${id}`;
      expect(cleared[0].launch_harness_projection).toBeNull();
      expect(cleared[0].pending).toBe(false);
      const fallback = await pageFor({ workspaceId, planSlugs: ['p10-bulk-plan'], limit: 25 });
      expect(fallback.rows.find((row) => row.id === id)?.harnessSlug).toBe('p10-bulk-harness');
    } finally {
      await sql`UPDATE harness_shared.adv_sessions SET launch_spec = ${original[0].launch_spec}::jsonb WHERE id = ${id}`;
    }
  });

  it('finds a plan/harness match beyond the old page-200 ceiling with exact facets', async () => {
    const args: AdvSessionsListWireArgs = {
      workspaceId,
      harnessSlugs: [deepHarness],
      planSlugs: [deepPlan],
      limit: 25,
    };
    const started = performance.now();
    const [page, summary] = await Promise.all([pageFor(args), summaryFor(args)]);

    expect(page.rows.map((row) => row.id)).toEqual([deepId]);
    expect(summary).toMatchObject({ total: ROWS, matched: 1 });
    expect(summary.facets.find((facet) => facet.key === 'plan')?.values).toContainEqual(
      expect.objectContaining({
        value: deepPlan,
        count: 1,
        meta: { active: 1 },
      }),
    );
    expect(summary.facets.find((facet) => facet.key === 'harness')?.values).toContainEqual(
      expect.objectContaining({ value: deepHarness, count: 1 }),
    );
    expect(Buffer.byteLength(JSON.stringify(page.rows))).toBeLessThan(100_000);
    expect(performance.now() - started).toBeLessThan(6_000);
  });

  it('preserves an exact zero match and the selected empty harness option', async () => {
    const args: AdvSessionsListWireArgs = {
      workspaceId,
      harnessSlugs: ['p10-missing-harness'],
      limit: 25,
    };
    const [page, summary] = await Promise.all([pageFor(args), summaryFor(args)]);

    expect(page).toMatchObject({ rows: [], nextCursor: null, hasMore: false });
    expect(summary).toMatchObject({ total: ROWS, matched: 0 });
    expect(summary.facets.find((facet) => facet.key === 'harness')?.values).toContainEqual(
      expect.objectContaining({ value: 'p10-missing-harness', count: 0 }),
    );
    expect(summary.facets.find((facet) => facet.key === 'harness')?.values).toContainEqual(
      expect.objectContaining({ value: NO_SESSION_HARNESS, count: 1 }),
    );
  });

  it('keyset-pages more than 15,000 births without skips when started_at mutates mid-walk', async () => {
    const args: AdvSessionsListWireArgs = { workspaceId, limit: 211 };
    const ids: number[] = [];
    let cursor: string | null = null;
    let pageNo = 0;
    for (;;) {
      const page = await pageFor(args, cursor);
      ids.push(...page.rows.map((row) => row.id));
      cursor = page.nextCursor;
      if (pageNo === 0) {
        await sql`
          UPDATE harness_shared.adv_sessions
             SET started_at = to_timestamp((${BASE_TS}::bigint + 50_000) / 1000.0)
           WHERE workspace_id = ${workspaceId} AND id = 14_000`;
        await sql`
          INSERT INTO harness_shared.adv_sessions
            (workspace_id, plan_slug, agent, mode, omp_thread_id, launch_spec,
             started_at, first_seen_at)
          VALUES (${workspaceId}, 'p10-bulk-plan', 'codex', 'console',
                  'p10-newer-after-cursor',
                  jsonb_build_object('harnessSlug', 'p10-bulk-harness'),
                  to_timestamp((${BASE_TS}::bigint + 60_000) / 1000.0),
                  to_timestamp((${BASE_TS}::bigint + 60_000) / 1000.0))`;
      }
      pageNo += 1;
      if (!cursor) break;
      expect(pageNo).toBeLessThan(100);
    }

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(ROWS);
    expect(ids).toContain(14_000);
    expect(ids).not.toContain(ROWS + 3); // two excluded fixtures preceded the new row
  }, 60_000);
});
