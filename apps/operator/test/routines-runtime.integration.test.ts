/**
 * EI-2 regression coverage — db-org's `upsertRoutine` + its `upsertGitSyncRoutine` wrapper
 * must INSERT `harness_shared.routines.workspace_id` (the column is NOT NULL with no default
 * and no fill trigger — there is no `app.workspace_id` GUC trigger). Before the fix both
 * threw a NOT NULL violation on insert and were latent only because nothing called them.
 *
 * Throwaway testcontainer DB with the real routines DDL (workspace_id NOT NULL). The test
 * `sql` runs `prepare:false`, matching the production org pool (getOrgPg) so the jsonb bind
 * (`${JSON.stringify}::text::jsonb`, the client-agnostic form per
 * agent-insights/postgres-js-jsonb-binding) is exercised the way production runs it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { upsertRoutine } from '@papercusp/db-org';
import { computeNextFireAt } from '@papercusp/operator-core/lib/harness/routines/cron';
import {
  upsertGitSyncRoutine,
  getGitSyncRoutine,
  GIT_SYNC_TARGET,
  GIT_SYNC_ROUTINE_NAME,
  DEFAULT_GIT_SYNC_CRON,
} from '@papercusp/operator-core/lib/harness/git-sync/git-sync-routine';

const WS = 'ws_routines_test';
let adminUri: string;
let dbName: string;
let sql: postgres.Sql;

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `rrt_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  // prepare:false mirrors the production org pool (getOrgPg) — the binding env that matters.
  sql = postgres(u.toString(), { max: 4, prepare: false, onnotice: () => {} });

  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  // Real routines DDL — workspace_id is NOT NULL with NO default and NO fill trigger.
  await sql.unsafe(`
    CREATE TABLE harness_shared.routines (
      id               text PRIMARY KEY,
      install_slug     text NOT NULL,
      name             text NOT NULL,
      trigger_kind     text NOT NULL,
      trigger_config   jsonb NOT NULL,
      target_role      text NOT NULL,
      payload_template jsonb,
      concurrency      text NOT NULL DEFAULT 'queue',
      catchup          text NOT NULL DEFAULT 'skip-old',
      active           boolean NOT NULL DEFAULT true,
      last_fired_at    timestamptz,
      next_fire_at     timestamptz,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      metadata         jsonb,
      workspace_id     text NOT NULL,
      -- migration 323 (B-LOOP-1): the loop recurrence kind. upsertRoutine's INSERT references
      -- both, so the fixture must carry them (else every upsert throws "column does not exist").
      reschedule_interval_sec integer,
      target_owner_id  text,
      UNIQUE (install_slug, name),
      -- F-E1 migration 305: the composite unique the per-workspace ON CONFLICT can target.
      UNIQUE (workspace_id, install_slug, name)
    )
  `);
}, 60_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await admin.end({ timeout: 5 });
  }
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.routines`;
});

describe('upsertRoutine (EI-2: workspace_id is inserted)', () => {
  it('inserts a cron routine with workspace_id (NOT NULL satisfied)', async () => {
    const row = await upsertRoutine(
      sql,
      {
        workspaceId: WS,
        installSlug: 'demo',
        name: 'nightly',
        triggerKind: 'cron',
        triggerConfig: { cron: '0 0 9 * * *' },
        targetRole: 'system:blueprint-run',
        active: true,
      },
      computeNextFireAt,
    );
    expect(row.id).toBe('rt_demo_nightly');
    expect(row.workspaceId).toBe(WS);
    expect(row.targetRole).toBe('system:blueprint-run');
    expect(row.nextFireAt).not.toBeNull(); // a valid cron computed a due time

    // Read back via the table: workspace_id landed + trigger_config is a real jsonb OBJECT.
    const [db] = await sql<{ workspace_id: string; tc_type: string; cron: string }[]>`
      SELECT workspace_id, jsonb_typeof(trigger_config) AS tc_type, trigger_config->>'cron' AS cron
        FROM harness_shared.routines WHERE id = 'rt_demo_nightly'`;
    expect(db.workspace_id).toBe(WS);
    expect(db.tc_type).toBe('object'); // not double-encoded into a jsonb string scalar
    expect(db.cron).toBe('0 0 9 * * *');
  });

  it('is idempotent on (install_slug, name) — re-upsert retimes, not duplicates', async () => {
    await upsertRoutine(
      sql,
      { workspaceId: WS, installSlug: 'demo', name: 'nightly', triggerKind: 'cron', triggerConfig: { cron: '0 0 9 * * *' }, targetRole: 'system:blueprint-run' },
      computeNextFireAt,
    );
    await upsertRoutine(
      sql,
      { workspaceId: WS, installSlug: 'demo', name: 'nightly', triggerKind: 'cron', triggerConfig: { cron: '0 0 18 * * *' }, targetRole: 'system:blueprint-run' },
      computeNextFireAt,
    );
    const rows = await sql<{ cron: string }[]>`
      SELECT trigger_config->>'cron' AS cron FROM harness_shared.routines WHERE install_slug = 'demo'`;
    expect(rows).toHaveLength(1); // upserted, not duplicated
    expect(rows[0].cron).toBe('0 0 18 * * *'); // retimed
  });
});

describe('upsertGitSyncRoutine (EI-2: the git-sync seed no longer throws)', () => {
  it('seeds a system:git-sync routine with workspace_id, inactive by default', async () => {
    const row = await upsertGitSyncRoutine(sql, { workspaceId: WS, installSlug: 'demo' });
    expect(row.name).toBe(GIT_SYNC_ROUTINE_NAME);
    expect(row.targetRole).toBe(GIT_SYNC_TARGET);
    expect(row.workspaceId).toBe(WS);
    expect(row.active).toBe(false); // seeded INACTIVE; go-live flips it

    const read = await getGitSyncRoutine(sql, 'demo');
    expect(read?.workspaceId).toBe(WS);
    expect(read?.triggerConfig.cron).toBe(DEFAULT_GIT_SYNC_CRON); // trigger_config is a usable object
    expect(read?.triggerConfig.push).toBe(true);
  });
});
