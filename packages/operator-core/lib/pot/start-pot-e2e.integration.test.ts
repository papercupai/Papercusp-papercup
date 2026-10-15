/**
 * Current Pot startup contract, against a fully migrated org database and the
 * real dispatcher. P-068/D-098 permanently retired the Mug actuator; start must
 * keep its plan gates, and boot must discard legacy Pot wake projections.
 *
 * The surviving approval/promotion path is covered by start-guard.test.ts and
 * start-auto-flip.integration.test.ts. This suite exercises the actual refused
 * dispatch and the persisted restart boundary without mocking retirement or
 * plan validation.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { PAPERCUSP_WORKSPACE_ID } from '../harness/papercusp-workspace';
import { runWithWorkspace } from '../workspace-als';

// Operator-home plan reads/writes resolve to this tenant, not the legacy
// default workspace. Bind the request ALS to the same scope as the fixture.
const WS = PAPERCUSP_WORKSPACE_ID;
const HARNESS = 'papercusp';
const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  appSql: undefined as unknown as postgres.Sql,
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: (ws: string, fn: (tx: postgres.TransactionSql) => unknown) =>
    h.appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      return fn(tx);
    }),
}));
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS, backgroundWorkspaceIds: () => [WS] };
});

// Only the outward launch boundary is mocked. Every gate and dispatch stays real.
const fireLaunchBlueprint = vi.fn(async () => ({ blueprintId: 'coding', role: 'operator' }));
vi.mock('../blueprint/launch-blueprint', async () => {
  const actual = await vi.importActual<typeof import('../blueprint/launch-blueprint')>(
    '../blueprint/launch-blueprint',
  );
  return { ...actual, fireLaunchBlueprint: (...a: unknown[]) => fireLaunchBlueprint(...(a as [])) };
});

const {
  _resetReactionsForTests,
  listReactionRules,
  registerReactionRule,
  matchReactions,
} = await import('../events');
await import('../agent-tools/plans/start');
await import('../agent-tools/pot/wake');
const { armDefaultPotWakeSubscriptions } = await import('./wake-defaults');
const {
  readPotWakeState,
  registerPotWakeRules,
  setPotEventSubscriptions,
} = await import('./wake');
const { lookupByMcpName, dispatchProjectedTool } = await import('@papercusp/agent-mcp');
const { PROJECTED_DEPS } = await import('../projected-tool-deps');

let db: OrgTestDb;
let priorRules: ReturnType<typeof listReactionRules> = [];

function ctx(): Record<string, unknown> {
  return {
    workspaceId: WS,
    harnessSlug: HARNESS,
    role: 'operator',
    featureId: null,
    chunkId: null,
    runId: randomUUID(),
    spawnId: 'e2e-test',
    parentSpawnId: null,
    uiClientId: 'su-e2e-test',
    isSuperuser: true,
    profile: 'engineer',
    transport: 'in_process',
    log: () => {},
    progress: () => {},
    emit: () => {},
    signal: new AbortController().signal,
    principal: { slug: 'system:e2e-test', workspaceId: WS, capabilities: new Set(['*']) },
    tx: h.sql,
  };
}

async function dispatch(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const projected = lookupByMcpName(tool);
  expect(projected, `tool ${tool} must be registered`).toBeTruthy();
  const res = await runWithWorkspace(WS, () =>
    dispatchProjectedTool(projected!, tool, args, ctx() as never, PROJECTED_DEPS));
  expect(res.ok, `${tool} dispatch failed: ${JSON.stringify(res.error ?? null)}`).toBe(true);
  const text = (res.result?.content as Array<{ text: string }>)[0]?.text;
  const parsed = text ? JSON.parse(text) : {};
  if (Array.isArray(parsed.results) && parsed.counts !== undefined) return parsed.results[0] ?? {};
  return parsed;
}

const potRules = () => listReactionRules().filter((r) => r.id.startsWith(`pot-wake:${WS}#`));

beforeAll(async () => {
  priorRules = listReactionRules();
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  h.appSql = db.appSql;
  const { resolvePlanScope } = await import('../agent-tools/plans/source');
  await expect(resolvePlanScope({ harnessSlug: HARNESS })).resolves.toEqual({
    workspaceId: WS, harnessSlug: HARNESS,
  });
  await db.adminSql`
    INSERT INTO harness_shared.projects
      (id, name, status, slug, workspace_id, created_ts, updated_ts)
    VALUES (${HARNESS}, ${HARNESS}, 'active', ${HARNESS}, ${WS}, ${Date.now()}, ${Date.now()})`;
  await db.adminSql`
    INSERT INTO harness_shared.harness_registry (workspace_id, payload)
    VALUES (${WS}, ${JSON.stringify({
      projects: [{ slug: HARNESS, path: '/tmp/papercusp', harness_kind: 'hive' }],
    })}::text::jsonb)`;
}, 120_000);

afterAll(async () => {
  _resetReactionsForTests();
  priorRules.forEach(registerReactionRule);
  await db?.cleanup();
});

describe('permanently retired Pot startup boundary', () => {
  it('plans:start reports the real missing-audit refusal before operational writes or promotion', async () => {
    // This is the old suite's exact incomplete plan shape. It is not a valid
    // activation fixture, so asserting "started" hid the actual gate refusal.
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, content)
      VALUES (${WS}, ${HARNESS}, 'plan-a', 'plan-a', 'ready', '# plan-a')`;
    const out = await dispatch('plans:start', { slug: 'plan-a', harness: HARNESS });
    expect(out).toMatchObject({ ok: false, error: 'conversation_audit_required' });
    expect(out.message).toContain("plans:audit");
    const rows = await db.adminSql`
      SELECT op_status, content FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = 'plan-a'`;
    expect(rows[0]).toMatchObject({ op_status: null, content: '# plan-a' });
    const promoted = await db.adminSql`
      SELECT feature_id FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${WS} AND source_plan_slug = 'plan-a'`;
    expect(promoted).toHaveLength(0);
    expect(fireLaunchBlueprint).not.toHaveBeenCalled();
  });

  it('default arming leaves no persisted subscriptions or live Mug rules in either mode', async () => {
    const before = await readPotWakeState(WS);
    for (const mode of ['replace', 'ensure'] as const) {
      await expect(armDefaultPotWakeSubscriptions(WS, { mode })).resolves.toEqual({ rules: 0, added: 0 });
      expect(await readPotWakeState(WS)).toEqual(before);
      expect(potRules()).toHaveLength(0);
    }
    expect(fireLaunchBlueprint).not.toHaveBeenCalled();
  });

  it.each(['event', 'manual', 'user'] as const)('forced %s wakes still refuse permanently without a launch or wake-state write', async (source) => {
    const before = await readPotWakeState(WS);
    const out = await dispatch('pot:wake', { harness: HARNESS, source, force: true });
    expect(out).toMatchObject({ ok: false, error: 'mug_kettle_retired' });
    expect(out.message).toContain('permanently');
    expect(fireLaunchBlueprint).not.toHaveBeenCalled();
    expect(await readPotWakeState(WS)).toEqual(before);
  });

  it('boot removes stale persisted Mug projections while retaining unrelated su reactions', async () => {
    const subscriptions = [{ on: 'plans:start', note: 'legacy persisted subscription' }];
    await setPotEventSubscriptions(WS, subscriptions);
    expect(potRules()).toHaveLength(1); // reproduce a worker loaded before retirement
    expect((await readPotWakeState(WS)).subscriptions).toEqual(subscriptions);

    const suRule = { id: 'su-startup-control', on: 'loop:checkpoint', fire: 'loop:status' };
    registerReactionRule(suRule);
    await expect(registerPotWakeRules(WS)).resolves.toBe(0);
    expect(potRules()).toHaveLength(0);
    expect(listReactionRules()).toContainEqual(suRule);
    expect(matchReactions({
      tool: 'loop:checkpoint', args: {}, result: { ok: true, data: {} }, ctx: ctx() as never,
    })).toContainEqual(expect.objectContaining({ ruleId: suRule.id, fire: 'loop:status' }));

    // A real restart wipes only memory. Persisted legacy rows must remain
    // non-executable on every re-projection, without disturbing other rules.
    _resetReactionsForTests();
    registerReactionRule(suRule);
    await expect(registerPotWakeRules(WS)).resolves.toBe(0);
    expect(potRules()).toHaveLength(0);
    expect(listReactionRules()).toContainEqual(suRule);
    expect((await readPotWakeState(WS)).subscriptions).toEqual(subscriptions);
    expect(fireLaunchBlueprint).not.toHaveBeenCalled();
  });
});
