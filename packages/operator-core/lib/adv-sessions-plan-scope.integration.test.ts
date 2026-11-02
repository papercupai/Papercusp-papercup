import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: h.sql }),
}));

import { listPlanSessions } from './adv-sessions';
import { resolveNamedQueryV2 } from './sync-resolver';

let db: FreshPgDb;
const WS = 'native-plan-scope';
const PLAN = 'same-plan-slug';

async function session(owner: string, harness: string | null, plan: string | null = PLAN, workspace = WS) {
  await db.sql`
    INSERT INTO harness_shared.adv_sessions
      (workspace_id, coord_owner_id, plan_slug, launch_spec, started_at)
    VALUES (${workspace}, ${owner}, ${plan},
      ${db.sql.json(harness === null ? {} : { harnessSlug: harness })}, now())`;
}

async function claim(owner: string, harness: string, workspace = WS) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, source_plan_slug, terminal_owner)
    VALUES (${workspace}, ${harness}, ${PLAN}, ${owner})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('plan-session-scope');
  h.sql = db.sql;
  // Only the two read relations are needed; this is a private database, never
  // the shared baseline or the signed-in workspace.
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.adv_sessions (
      workspace_id text NOT NULL, coord_owner_id text, plan_slug text,
      launch_spec jsonb, session_id text, omp_thread_id text, agent text,
      mode text NOT NULL DEFAULT 'console', role text, label text,
      started_at timestamptz NOT NULL, ended_at timestamptz
    );
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL, harness_slug text NOT NULL,
      source_plan_slug text, terminal_owner text, taken_by text
    )`).simple();
}, 90_000);

afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.adv_sessions, harness_shared.work_items`;
  await session('alpha-launch', 'alpha');
  await session('beta-launch', 'beta');
  await session('unknown-launch', null);
  await session('other-workspace-launch', 'alpha', PLAN, 'elsewhere');
  await session('alpha-worker', null, null);
  await claim('alpha-worker', 'alpha');
  await session('beta-worker', null, null);
  await claim('beta-worker', 'beta');
  await session('other-workspace-claim', null, null);
  await claim('other-workspace-claim', 'alpha', 'elsewhere');
});

describe('canonical plan-session scope', () => {
  it('qualifies launch bindings and claim supplements by harness and workspace', async () => {
    const rows = await listPlanSessions(PLAN, { workspaceId: WS, harnessSlug: 'alpha' });
    expect(rows.map(row => row.coordOwnerId).sort()).toEqual(['alpha-launch', 'alpha-worker']);
    expect(rows.find(row => row.coordOwnerId === 'alpha-worker')?.via).toBe('claim');
  });

  it('keeps the identically named plan in the other harness independently addressable', async () => {
    const rows = await listPlanSessions(PLAN, { workspaceId: WS, harnessSlug: 'beta' });
    expect(rows.map(row => row.coordOwnerId).sort()).toEqual(['beta-launch', 'beta-worker']);
  });

  it('threads the qualified identity through the existing named-query boundary', async () => {
    const rows = await resolveNamedQueryV2('planSessions.list', {
      planSlug: PLAN, workspaceId: WS, harnessSlug: 'alpha',
    });
    expect(Array.isArray(rows)).toBe(true);
    expect((rows as Array<{ coordOwnerId: string }>).map(row => row.coordOwnerId).sort())
      .toEqual(['alpha-launch', 'alpha-worker']);
  });

  it('retains the explicit all-harness read while fencing its claim leg to the workspace', async () => {
    const rows = await listPlanSessions(PLAN, { workspaceId: WS });
    expect(rows.map(row => row.coordOwnerId).sort()).toEqual([
      'alpha-launch', 'alpha-worker', 'beta-launch', 'beta-worker', 'unknown-launch',
    ]);
  });

  it('surfaces an unavailable source instead of reporting an empty plan', async () => {
    await db.sql`ALTER TABLE harness_shared.adv_sessions RENAME TO unavailable_plan_sessions`;
    try {
      await expect(resolveNamedQueryV2('planSessions.list', {
        planSlug: PLAN, workspaceId: WS, harnessSlug: 'alpha',
      })).rejects.toThrow();
    } finally {
      await db.sql`ALTER TABLE harness_shared.unavailable_plan_sessions RENAME TO adv_sessions`;
    }
  });
});
