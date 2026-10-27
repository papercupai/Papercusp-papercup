/** Recipe inspection -> existing conformance journal/bindings, using real PG. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ProjectedTool } from '@papercusp/tooldef';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { bindCapabilityProviderToPot, defineCapabilityClass, getPotCapabilityProviderBinding,
  recordProviderConformance, validateProviderInterface } from '../capability-class-registry-store';
import { inspectIdentityRecipeClassProvider } from './recipe-provider-conformance';
import type { SavedRecipeAdapter } from '../agent-tools/orchestration/saved-recipe-adapter';

let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('recipeclass');
  await db.sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
  for (const migration of ['1140-capability-class-registry', '1141-enforce-capability-class-passing-bindings',
    '1161-capability-class-embedding-profile', '1233-capability-provider-execution-kind']) {
    await applyMigrationForTest(db.sql, fileURLToPath(new URL(
      '../../../../libs/papercusp/libs/db/sql/' + migration + '.sql', import.meta.url)));
  }
}, 120_000);
afterAll(async () => { await db?.cleanup(); });

const outputSchema = { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'] };
async function fixture(workspaceId: string, allow = true) {
  const { capabilityClass } = await defineCapabilityClass(db.sql, { workspaceId,
    id: 'context.status', version: '1.0.0', title: 'Status', description: 'Recipe context proof',
    interfaceVerbs: { read: { inputSchema: {}, outputSchema } } });
  const target: ProjectedTool = { pluginName: 'status-plugin', description: 'read status', effect: 'read',
    expose: { mcp: { name: 'status:read' } }, capabilities: ['status:read'], inputSchema: {},
    fn: vi.fn() };
  const revision = 'a'.repeat(64);
  const recipeId = workspaceId + '-recipe';
  const recipes: SavedRecipeAdapter = { inspect: vi.fn(async () => ({ ok: true as const,
    recipe: { id: recipeId, script: 'return tools.status.read({});' },
    continuation: { id: recipeId, revision, authority: { version: 1 as const, revision,
      refs: { workspaces: [], fleets: [], plans: [], harnesses: [], items: [], resources: [] },
      requiresContext: false, runnable: true } } })), run: vi.fn(), search: vi.fn() };
  const context: UnifiedToolContext = { workspaceId, harnessSlug: 'papercusp', role: 'operator',
    principal: { slug: 'wearer', workspaceId, capabilities: new Set(['*']) },
    signal: new AbortController().signal, runId: 'run', spawnId: 'spawn', parentSpawnId: null,
    featureId: null, chunkId: null, uiClientId: null, profile: 'engineer', transport: 'in_process',
    tx: db.sql as UnifiedToolContext['tx'], log: () => {}, progress: () => {}, emit: () => {} };
  const report = await inspectIdentityRecipeClassProvider({ capabilityClass,
    providerPackage: 'context-recipes', providerVersion: '1.0.0', registryRevision: 'registry-recipe-1',
    recipes: { read: { recipe: { id: recipeId, revision }, outputSchema } },
    declaredNeeds: allow ? ['status:read'] : [], capabilityCeiling: new Set(['*']), context }, { tools: [target], recipes });
  const input = { workspaceId, classId: capabilityClass.id, classVersion: capabilityClass.version,
    providerPackage: report.providerPackage, providerVersion: report.providerVersion,
    verbBindings: { read: recipeId }, report, performedBy: 'wearer' };
  return { input, capabilityClass, target, recipes };
}

describe('recipe provider conformance persistence (real PG)', () => {
  it('persists exact inspection pins and selects an explicitly bound recipe while tool reads keep their default', async () => {
    const { input, target, recipes } = await fixture('recipe-registry-pass');
    const recorded = await recordProviderConformance(db.sql, input);
    expect(recorded.binding).toMatchObject({ providerKind: 'recipe', latencyClass: 'sync',
      conformanceRunId: recorded.runId, recipeInspections: input.report.recipes });
    const [row] = await db.sql`SELECT provider_kind, latency_class, report
      FROM harness_shared.capability_class_conformance_runs WHERE id = ${recorded.runId}`;
    expect(row).toMatchObject({ provider_kind: 'recipe', latency_class: 'sync', report: input.report });
    await bindCapabilityProviderToPot(db.sql, { ...input, potSlug: 'target-pot', providerKind: 'recipe' });
    expect(await getPotCapabilityProviderBinding(db.sql, { ...input, potSlug: 'target-pot' })).toBeNull();
    expect(await getPotCapabilityProviderBinding(db.sql, { ...input, potSlug: 'target-pot', providerKinds: ['recipe'] }))
      .toMatchObject({ providerKind: 'recipe', conformanceRunId: recorded.runId, recipeInspections: input.report.recipes });
    // A later failed inspection is retained as evidence, never as a new active
    // binding. The already selected exact passing run remains unchanged.
    const denied = await fixture(input.workspaceId, false);
    const failed = await recordProviderConformance(db.sql, denied.input);
    expect(failed.binding).toBeNull();
    expect(await getPotCapabilityProviderBinding(db.sql, { ...input, potSlug: 'target-pot', providerKinds: ['recipe'] }))
      .toMatchObject({ conformanceRunId: recorded.runId, recipeInspections: input.report.recipes });
    expect(await db.sql`SELECT report FROM harness_shared.capability_class_conformance_runs
      WHERE id = ${recorded.runId}`).toEqual([{ report: input.report }]);
    expect(target.fn).not.toHaveBeenCalled();
    expect(recipes.run).not.toHaveBeenCalled();
  });

  it('records a failed inspection without creating an eligible binding', async () => {
    const { input } = await fixture('recipe-registry-denied', false);
    expect(input.report.ok).toBe(false);
    const recorded = await recordProviderConformance(db.sql, input);
    expect(recorded.binding).toBeNull();
    expect(await db.sql`SELECT provider_kind, structural_passed FROM harness_shared.capability_class_conformance_runs
      WHERE id = ${recorded.runId}`).toEqual([{ provider_kind: 'recipe', structural_passed: false }]);
    expect(await db.sql`SELECT * FROM harness_shared.capability_class_provider_bindings
      WHERE workspace_id = ${input.workspaceId}`).toHaveLength(0);
  });

  it('refuses corrupt or mismatched passing evidence before writing a run', async () => {
    const { input } = await fixture('recipe-registry-corrupt');
    for (const corrupt of [
      (v: typeof input) => { v.verbBindings.read = 'another-recipe'; },
      (v: typeof input) => { delete v.report.recipes.read; },
      (v: typeof input) => { v.report.recipes.read!.inspectionPin.recipeRevision = 'b'.repeat(64); },
      (v: typeof input) => { v.report.recipes.read!.outputSchema = { type: 'string' }; },
      (v: typeof input) => { v.report.checks.push(v.report.checks[0]!); },
    ]) {
      const changed = structuredClone(input);
      corrupt(changed);
      await expect(recordProviderConformance(db.sql, changed)).rejects.toThrow(/recipe conformance/);
    }
    expect(await db.sql`SELECT * FROM harness_shared.capability_class_conformance_runs
      WHERE workspace_id = ${input.workspaceId}`).toHaveLength(0);
  });

  it('preserves the existing tool report writer and returned defaults', async () => {
    const { input, capabilityClass } = await fixture('recipe-registry-tool');
    const verbBindings = { read: 'status:read' };
    const report = validateProviderInterface({ capabilityClass, providerPackage: 'status-plugin',
      providerVersion: '1.0.0', registryRevision: 'registry-tool-1', verbBindings,
      lookup: () => ({ name: 'status:read', pluginName: 'status-plugin', providerVersion: '1.0.0', inputSchema: {}, outputSchema }) });
    const recorded = await recordProviderConformance(db.sql, { ...input, providerPackage: 'status-plugin', verbBindings, report });
    expect(recorded.binding).toMatchObject({ providerKind: 'tool', latencyClass: 'sync', verbBindings });
    expect(recorded.binding).not.toHaveProperty('recipeInspections');
  });
});
