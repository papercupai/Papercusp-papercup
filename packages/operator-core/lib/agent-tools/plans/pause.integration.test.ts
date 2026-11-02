/**
 * pause.integration.test.ts — the plans:pause MCP tool handler, against a real
 * Postgres (tool.handler called directly; withWorkspace bound to the testcontainer).
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - pause flips op_status to 'paused' ONLY for a plan ON the axis — the
 *    `AND op_status IN ('started','paused')` guard means a never-started plan
 *    (null op_status) matches 0 rows and returns { notStarted: true } WITHOUT
 *    writing 'paused';
 *  - it does NOT re-enter the retired axis from the 'done' EXIT (WI-38301);
 *  - it is scoped to args.slug.
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
// plan readers use — so pin THAT, not the ambient activeWorkspaceId(). Deliberately NOT
// 'default': a regression to the 'default' literal (gen 1) or to the ambient workspace
// (gen 2) matches zero rows, which for THIS tool used to look like the benign
// notStarted:true branch. These tests now catch that.
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
vi.mock('../../workspace-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workspace-registry')>();
  return { ...actual, activeWorkspaceId: () => 'ambient-WRONG-workspace' };
});

const pauseTool = (await import('./pause')).default;
// The bulk-refactored tools return a structured `{ data: { ok, results, counts } }`
// envelope (../_bulk bulkContent), NOT the legacy MCP `{ content:[{text}] }` shape —
// the dispatch layer renders the content; the raw handler hands back `{ data }`.
const call = (slug: string, harness = 'web') => pauseTool.handler({ slug, harness } as never, {} as never) as Promise<{ data: { results: Record<string, unknown>[] } }>;
const statusOf = async (plan: string, ws = SEED_WS) =>
  (await rootSql<{ op_status: string | null }[]>`SELECT op_status FROM harness_shared.harness_plans WHERE workspace_id=${ws} AND plan_slug=${plan}`)[0]?.op_status;

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `pp_${randomBytes(5).toString('hex')}`;
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
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL,
      op_status text, op_updated_at timestamptz, execution_start_revision_seq integer,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.harness_plans CASCADE`;
  await rootSql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, op_status) VALUES
    (${SEED_WS}, 'web', 'started-plan', 'started'),
    (${SEED_WS}, 'web', 'never-started', NULL),
    (${SEED_WS}, 'web', 'retired-plan', 'done'),
    (${SEED_WS}, 'web', 'sibling', 'started')`;
  // Same-named row in the ambient/wrong tenant — the row a gen-2 regression would hit.
  await rootSql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, op_status) VALUES
    ('ambient-WRONG-workspace', 'web', 'started-plan', 'started')`;
});

describe('plans:pause handler (PG)', () => {
  it('revokes modern start proof while keeping the retired op_status null', async () => {
    await rootSql`UPDATE harness_shared.harness_plans SET execution_start_revision_seq=1
      WHERE workspace_id=${SEED_WS} AND plan_slug='never-started'`;
    const res = await call('never-started');
    expect(res.data.results[0]).toMatchObject({ ok: true });
    expect(res.data.results[0]).not.toHaveProperty('notStarted');
    const [row] = await rootSql`SELECT op_status,execution_start_revision_seq FROM harness_shared.harness_plans
      WHERE workspace_id=${SEED_WS} AND plan_slug='never-started'`;
    expect(row).toMatchObject({ op_status: null, execution_start_revision_seq: null });
  });

  it('pauses a STARTED plan', async () => {
    const res = await call('started-plan');
    expect(res.data.results[0]).toMatchObject({ slug: 'started-plan', status: 'paused' });
    expect(await statusOf('started-plan')).toBe('paused');
  });

  it('a never-started plan (null op_status) returns notStarted and is NOT written', async () => {
    const res = await call('never-started');
    expect(res.data.results[0]).toMatchObject({ notStarted: true });
    expect(await statusOf('never-started')).toBeNull(); // still null — the on-axis guard held
  });

  // WI-38301 / D-055. The guard used to be `op_status IS NOT NULL`, and 'done' —
  // the value clearStartedForTerminalPlan writes to take a plan OFF the retired
  // axis — is not null. So pause moved a retired plan 'done' → 'paused', i.e. back
  // onto a value `reservedPlanLaneExclusionSql` RESERVES, with no way off: the only
  // re-entry verb (plans:start) is gated by P-047, so those items were reserved
  // permanently for a dispatcher that cannot run. The failure is silent in both
  // directions — the write "succeeds" and the items simply stop being claimable.
  it('does NOT re-enter the axis from the done EXIT — a retired plan stays done', async () => {
    const res = await call('retired-plan');
    expect(res.data.results[0]).toMatchObject({ notStarted: true });
    expect(await statusOf('retired-plan')).toBe('done'); // NOT 'paused'
  });

  it('is scoped to args.slug — a sibling started plan is untouched', async () => {
    await call('started-plan');
    expect(await statusOf('sibling')).toBe('started'); // unchanged
  });

  it('WI-5825: pauses the RESOLVED tenant only — a same-named plan in another workspace is untouched', async () => {
    await call('started-plan');
    expect(await statusOf('started-plan')).toBe('paused');
    // Before the fix this handler keyed off activeWorkspaceId(), so THIS is the row
    // it would have paused while the caller's real plan stayed started.
    expect(await statusOf('started-plan', 'ambient-WRONG-workspace')).toBe('started');
  });

  it('WI-5825: a slug with no row in this scope reports plan_not_found — NOT the benign notStarted', async () => {
    const res = await call('no-such-plan');
    // The distinction that used to be lost: a mis-scoped write matched 0 rows and was
    // reported as "you never started this plan", which reads as normal behavior.
    expect(res.data.results[0]).toMatchObject({ ok: false, error: 'plan_not_found' });
    expect(res.data.results[0]).not.toHaveProperty('notStarted');
  });
});
