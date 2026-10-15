/**
 * The declared Mug wake door is permanently retired (P-068).
 * Exercise the real projected dispatcher, real retirement gates, and migrated
 * Postgres: declarations and every wake source must leave subscriptions and
 * launches unchanged. Live su wake/event behavior is covered by its own suites.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const WS = 'retired-declared-wake';
const h = vi.hoisted(() => ({ sql: null as postgres.Sql | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: async (_ws: string, fn: (tx: postgres.TransactionSql) => unknown) =>
    h.sql!.begin(async (tx) => fn(tx)),
}));
vi.mock('../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => WS,
  backgroundWorkspaceIds: () => [WS],
}));

const launch = vi.hoisted(() => vi.fn());
vi.mock('../blueprint/launch-blueprint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../blueprint/launch-blueprint')>()),
  fireLaunchBlueprint: launch,
}));

const { createOrgTestDb } = await import('../../test/_org-test-db');
const { _resetReactionsForTests } = await import('../events');
await import('../agent-tools/pot/wake');
await import('../agent-tools/pot/declare_wake');
const { lookupByMcpName, dispatchProjectedTool } = await import('@papercusp/agent-mcp');
const { PROJECTED_DEPS } = await import('../projected-tool-deps');

let org: Awaited<ReturnType<typeof createOrgTestDb>>;

async function dispatch(tool: string, args: Record<string, unknown>) {
  const projected = lookupByMcpName(tool);
  expect(projected, tool).toBeTruthy();
  const res = await dispatchProjectedTool(projected!, tool, args, {
    workspaceId: WS, harnessSlug: 'papercusp', role: 'operator',
    featureId: null, chunkId: null, runId: randomUUID(), spawnId: 'retired-wake-test',
    parentSpawnId: null, uiClientId: 'su-retired-wake-test', isSuperuser: true,
    gateBypass: { capability: true, quota: true, role: true },
    profile: 'engineer', transport: 'in_process',
    log: () => {}, progress: () => {}, emit: () => {},
    signal: new AbortController().signal,
    principal: { slug: 'system:retired-wake-test', workspaceId: WS, capabilities: new Set(['*']) },
    tx: h.sql,
  } as never, PROJECTED_DEPS);
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  const content = res.result?.content as Array<{ text: string }>;
  const parsed = JSON.parse(content[0]!.text);
  return parsed.data ?? parsed;
}

async function wakeRows() {
  return h.sql!`SELECT workspace_id, payload FROM harness_shared.pot_wake ORDER BY workspace_id`;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  h.sql = org.adminSql;
}, 120_000);

afterAll(async () => {
  _resetReactionsForTests();
  h.sql = null;
  await org?.cleanup();
});

describe('permanent Mug declared-wake retirement through the real dispatcher', () => {
  it.each([
    { events: [{ on: 'plans:start', note: 'retirement control' }] },
    { mode: 'none' },
    { inSeconds: 1 },
    { at: '2030-01-01T00:00:00Z', force: true },
  ])('refuses declaration %j without persisting wake subscriptions', async (args) => {
    const before = await wakeRows();
    const out = await dispatch('pot:declare-wake', { harness: 'papercusp', ...args });
    expect(out).toMatchObject({ ok: false, error: 'mug_kettle_retired' });
    expect(out.message).toContain('RETIRED, permanently');
    expect(await wakeRows()).toEqual(before);
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(['user', 'event', 'manual'] as const)(
    'refuses %s wake with and without force, before launching anything',
    async (source) => {
      const before = await wakeRows();
      for (const force of [false, true]) {
        const out = await dispatch('pot:wake', {
          harness: 'papercusp', source, force, trigger: 'plans:start',
        });
        expect(out).toMatchObject({ ok: false, error: 'mug_kettle_retired' });
      }
      expect(await wakeRows()).toEqual(before);
      expect(launch).not.toHaveBeenCalled();
    },
  );
});
