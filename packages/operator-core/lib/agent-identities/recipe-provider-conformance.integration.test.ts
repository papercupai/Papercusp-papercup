/** Real persisted recipes -> production lookup/dispatcher -> canonical inspector.
 * Only the database connection and telemetry deps are substituted; no saved
 * recipe adapter, lookup handler, parser or conformance result is mocked.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { lookupByMcpName } from '@papercusp/agent-mcp';
import type { ProjectedTool } from '@papercusp/tooldef';

const state = vi.hoisted(() => ({ db: null as OrgTestDb | null }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<object>()), getOrgPg: () => ({ sql: state.db!.adminSql }),
  withWorkspace: (workspaceId: string, fn: (tx: unknown) => unknown) => state.db!.appSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return fn(tx);
  }),
}));
vi.mock('../projected-tool-deps', () => ({ PROJECTED_DEPS: {} }));

import { createOrgTestDb } from '../../test/_org-test-db';
import { getRecipe, upsertRecipe } from '../code-recipes-store';
import { recipeRevision } from '../recipe-authority';
import '../agent-tools/recipes/get';
import { inspectIdentityRecipeProvider } from './recipe-provider-conformance';

const outputSchema = { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'] };
const target: ProjectedTool = { pluginName: 'fixture', description: 'read status', effect: 'read',
  expose: { mcp: { name: 'portable-fixture:status' } }, capabilities: ['status:read'],
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  fn: vi.fn(async () => ({ content: [], structuredContent: { ready: true } })),
};
function context(): UnifiedToolContext {
  return {
    workspaceId: 'ws-recipe-proof', harnessSlug: 'papercusp', role: 'operator',
    principal: { slug: 'recipe-wearer', workspaceId: 'ws-recipe-proof', capabilities: new Set(['*']) },
    signal: new AbortController().signal, runId: 'run-recipe-proof', spawnId: 'spawn-recipe-proof',
    parentSpawnId: null, featureId: null, chunkId: null, uiClientId: null,
    isSuperuser: true, gateBypass: { capability: true, quota: true },
    profile: 'engineer', transport: 'in_process', tx: state.db!.appSql as UnifiedToolContext['tx'],
    log: () => {}, progress: () => {}, emit: () => {},
  };
}
async function fixture(id: string, script = 'return { ready: true };') {
  const row = await upsertRecipe(state.db!.adminSql, {
    id, title: 'Recipe fixture', description: 'canonical persisted conformance proof', script,
    toolsUsed: [], potSlug: null,
  });
  return {
    recipe: { id, revision: recipeRevision(row.script, row.updatedAt, row) }, context: context(),
    contract: { inputSchema: {}, outputSchema }, outputSchema,
    declaredNeeds: ['agent_tools:read', 'status:read'], capabilityCeiling: new Set(['*']),
  };
}

describe('identity recipe admission with production saved-recipe lookup (real PG)', () => {
  beforeAll(async () => { state.db = await createOrgTestDb(); }, 120_000);
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { await state.db?.cleanup(); }, 30_000);

  it('reads the exact persisted revision with real wearer authority and does not execute it', async () => {
    const input = await fixture('portable-recipe-read');
    const metadataTool = lookupByMcpName('recipes:get');
    if (!metadataTool) throw new Error('production recipes:get tool is not registered');
    // Observe the real handler after dispatch gates; leave its implementation
    // and the dispatcher intact instead of intercepting a facade re-export.
    const metadataRead = vi.spyOn(metadataTool, 'fn');
    const result = await inspectIdentityRecipeProvider(input, { tools: [target] });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true,
      recipe: input.recipe, inspectionPin: { recipeRevision: input.recipe.revision } });
    expect(metadataRead).toHaveBeenCalledTimes(1);
    const observed = metadataRead.mock.calls[0]![1] as UnifiedToolContext;
    expect(observed.principal?.slug).toBe('recipe-wearer');
    expect([...observed.principal!.capabilities].sort()).toEqual(['agent_tools:read', 'status:read']);
    expect(observed.gateBypass).toBeUndefined();
    expect(observed.isSuperuser).toBe(false);
    expect(observed.runId).toBe(input.context.runId);
    const persisted = await getRecipe(state.db!.adminSql, input.recipe.id);
    expect(persisted).toMatchObject({ runCount: 0, successCount: 0, lastRunAt: null });
    expect(target.fn).not.toHaveBeenCalled();
  });

  it('refuses a source revision changed in the canonical store', async () => {
    const input = await fixture('portable-recipe-stale');
    const original = await inspectIdentityRecipeProvider(input, { tools: [target] });
    expect(original.ok).toBe(true);
    await fixture(input.recipe.id, 'return { ready: false };');
    expect(await inspectIdentityRecipeProvider(input, { tools: [target] }))
      .toEqual({ ok: false, code: 'inspection-failed' });
  });

  it('does not inherit the installer bypass when metadata reading is not granted', async () => {
    const input = await fixture('portable-recipe-grant');
    await expect(inspectIdentityRecipeProvider({ ...input, declaredNeeds: ['status:read'] }, { tools: [target] }))
      .rejects.toThrow(/missing_capability/);
    expect((await getRecipe(state.db!.adminSql, input.recipe.id))?.runCount).toBe(0);
  });

  it('keeps a long saved recipe intact when the wearer transport requests trimmed results', async () => {
    const input = await fixture('portable-recipe-long', '/*' + 'x'.repeat(8000) + '*/\nreturn { ready: true };');
    input.context.contextTier = 'trimmed';
    const result = await inspectIdentityRecipeProvider(input, { tools: [target] });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, recipe: input.recipe });
  });
});
