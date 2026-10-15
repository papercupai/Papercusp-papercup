/**
 * set-priority.integration.test.ts — the plans:set-priority MCP tool handler,
 * against a real Postgres. Calls tool.handler(args, ctx) directly (the standard
 * way these handlers are unit/integration tested) with withWorkspace bound to the
 * testcontainer.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - the handler UPDATEs harness_plans.op_priority for the (workspace, harness,
 *    plan) row — a number sets the dispatch rank, null clears it;
 *  - it is SCOPED to args.slug — sibling plans are untouched;
 *  - the JSON result echoes slug/harness/priority.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, withWorkspace: async (_ws: string, fn: (tx: postgres.Sql) => unknown) => fn(h.sql) };
});
// WI-5825: the handler keys its UPDATE off resolvePlanScope — the SAME authority the
// plan readers use — so pin THAT, not the ambient activeWorkspaceId(). The pinned
// workspace is deliberately NOT 'default': the seeded rows below live in a real-shaped
// tenant, so a regression to the 'default' literal (gen 1) or to the ambient workspace
// (gen 2) matches zero rows and reds these tests instead of silently no-opping.
const SEED_WS = 'ws-integration';
vi.mock('./source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source')>();
  return {
    ...actual,
    resolvePlanScope: async (opts: { harnessSlug?: string } = {}) => ({
      workspaceId: SEED_WS,
      harnessSlug: opts.harnessSlug?.trim() || 'web',
    }),
  };
});
// If the handler ever reads the ambient workspace again, it gets a wrong answer.
vi.mock('../../workspace-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workspace-registry')>();
  return { ...actual, activeWorkspaceId: () => 'ambient-WRONG-workspace' };
});

const setPriorityTool = (await import('./set-priority')).default;
const call = (slug: string, priority: number | null, harness = 'web') =>
  setPriorityTool.handler({ slug, priority, harness } as never, {} as never);

let rootSql: postgres.Sql;
const prioOf = async (plan: string, harness = 'web', ws = SEED_WS) =>
  (await rootSql<{ op_priority: number | null }[]>`SELECT op_priority FROM harness_shared.harness_plans WHERE workspace_id=${ws} AND harness_slug=${harness} AND plan_slug=${plan}`)[0]?.op_priority;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `sp_${randomBytes(5).toString('hex')}`;
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
  // FAITHFUL columns the handler touches (mig 122): op_priority integer, op_updated_at timestamptz.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL,
      op_priority integer, op_updated_at timestamptz,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.harness_plans CASCADE`;
  // Seed two plans in harness 'web' under the RESOLVED (non-'default') tenant.
  await rootSql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, op_priority) VALUES
    (${SEED_WS}, 'web', 'p1', NULL), (${SEED_WS}, 'web', 'p2', 99)`;
  // A same-named plan in the WRONG tenant: proof the UPDATE is workspace-scoped and
  // cannot bleed across tenants (and that it picked the right one).
  await rootSql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, op_priority) VALUES
    ('ambient-WRONG-workspace', 'web', 'p1', 42)`;
});

describe('plans:set-priority handler (PG)', () => {
  it('sets the op_priority for the named plan and echoes it', async () => {
    const res = (await call('p1', 5)) as {
      data: { counts: { ok: number; failed: number }; results: Array<Record<string, unknown>> };
    };
    expect(await prioOf('p1')).toBe(5);
    expect(res.data.counts).toEqual({ ok: 1, failed: 0 });
    expect(res.data.results[0]).toMatchObject({ ok: true, slug: 'p1', harnessSlug: 'web', priority: 5 });
  });

  it('a null priority CLEARS the rank', async () => {
    await call('p2', null);
    expect(await prioOf('p2')).toBeNull();
  });

  it('is scoped to args.slug — a sibling plan is untouched', async () => {
    await call('p1', 7);
    expect(await prioOf('p1')).toBe(7);
    expect(await prioOf('p2')).toBe(99); // p2 unchanged
  });

  it('WI-5825: writes the RESOLVED tenant only — a same-named plan in another workspace is untouched', async () => {
    await call('p1', 11);
    expect(await prioOf('p1')).toBe(11);
    // The identically-named row in the ambient/wrong tenant must not move. Before
    // the fix the handler keyed off activeWorkspaceId(), so THIS is the row it
    // would have hit while the caller's real plan stayed unchanged.
    expect(await prioOf('p1', 'web', 'ambient-WRONG-workspace')).toBe(42);
  });

  it('WI-5825: a slug that exists only in ANOTHER tenant reports plan_not_found, never a silent ok', async () => {
    await rootSql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, op_priority)
      VALUES ('some-other-ws', 'web', 'elsewhere-only', NULL)`;
    const res = (await call('elsewhere-only', 3)) as {
      data: { counts: { ok: number; failed: number }; results: Array<Record<string, unknown>> };
    };
    expect(res.data.counts).toEqual({ ok: 0, failed: 1 });
    expect(res.data.results[0]).toMatchObject({ ok: false, error: 'plan_not_found' });
    expect(await prioOf('elsewhere-only', 'web', 'some-other-ws')).toBeNull();
  });
});
