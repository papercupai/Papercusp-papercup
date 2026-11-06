/**
 * code-recipes-store.integration.test.ts — the agent-authored reusable code:run
 * recipe CRUD (`harness_shared.code_recipes` + `harness_shared.code_recipe_runs`,
 * migration 349) against real Postgres.
 *
 * Mirrors saved-prompts-store.integration.test.ts: the module is transport-
 * agnostic (every fn TAKES the `sql` handle), so we pass the org-fixture's admin
 * (RLS-bypass) client directly — no db-org mock. Validates: upsert insert→update-
 * in-place by id, run_count/success_count/last_run_at increment via recordRecipeRun
 * (incl. the side-table row), embedding write (has_embedding) + COALESCE-preserve,
 * global listing, get, and usage-scoped run history.
 *
 * Part of code-recipes-2026-06-21 Phase 1 (P-002, integration tier).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  upsertRecipe,
  recordRecipeRun,
  reviseRecipeSource,
  getRecipe,
  findActiveRecipeByStructuralFingerprint,
  listRecipes,
  mergeRecipes,
  sweepRecipes,
} from './code-recipes-store';
import { pinPackageInput } from '@papercusp/orchestrator/blueprint';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { blueprintPackageProvisioners } from './blueprint/compile-packages';
import { resolveProseProfileSelection } from './search/prose-vector-dims';
import { normalizeExecutionTrace, readableOperationEvidence, type NormalizedExecutionTrace, type OperationAdapterEvidence } from './orchestration-trace';

const { createOrgTestDb } = await import('../test/_org-test-db');
const here = dirname(fileURLToPath(import.meta.url));
const contractMigration = join(
  here,
  '..',
  '..',
  '..',
  'libs',
  'papercusp',
  'libs',
  'db',
  'sql',
  '897-code-recipe-contract.sql',
);
/** A throwaway 768-dim embedding (the store only round-trips presence, not value). */
const fakeEmbedding = (seed = 0.1): number[] => Array.from({ length: 768 }, () => seed);
const profiledEmbedding = (embedding: number[]) => ({
  embedding,
  embeddingMode: 'gemma' as const,
  embeddingProfile: resolveProseProfileSelection('gemma', EMBEDDER_DIM_SPECS.gemma)!,
});

describe('code_recipes store (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    // Migration 897 is armed. Re-apply its idempotent DDL in this isolated
    // database so store coverage remains bound to the production migration.
    await db.adminSql.unsafe(readFileSync(contractMigration, 'utf8')).simple();
    // The org fixture has already applied the full migration chain, including
    // 1154 before migration 1327 renamed personal_documents and left a compat
    // view. Replaying 1154 against that head-schema view fails with ALTER TABLE.
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('P-006 create-only registration cannot replace an existing executable recipe', async () => {
    const input = { id: 'p006-create-only', title: 'Pinned recipe', description: 'fixture',
      script: 'return 1', potSlug: 'p006-harness', createOnly: true };
    await upsertRecipe(db.adminSql, input);
    await expect(upsertRecipe(db.adminSql, { ...input, script: 'return 2' })).rejects.toThrow(/refused to overwrite/);
    expect((await getRecipe(db.adminSql, input.id))?.script).toBe('return 1');
    await upsertRecipe(db.adminSql, { ...input, createOnly: false, script: 'return 3' });
    expect((await getRecipe(db.adminSql, input.id))?.script).toBe('return 3');
  });

  it('P-026 registers a pinned recipe bundle through the existing store and never clobbers it', async () => {
    const provision = blueprintPackageProvisioners(db.adminSql).recipe;
    const input = {
      packageKind: 'recipe' as const,
      ref: 'p026-bundled-recipe',
      revision: '1.0.0',
      files: [{ path: 'recipe.json', bytes: '{"id":"p026-bundled-recipe"}' }],
      value: {
        id: 'p026-bundled-recipe', title: 'Bundled recipe', description: 'fixture',
        script: 'return 26', toolsUsed: ['state:read'], tags: ['identity'],
      },
    };
    const pin = pinPackageInput(input);
    const scope = { workspaceId: 'p026-workspace', harnessSlug: 'p026-harness' };
    await provision(pin, scope);
    await expect(getRecipe(db.adminSql, input.value.id)).resolves.toMatchObject({
      title: 'Bundled recipe', script: 'return 26', toolsUsed: ['state:read'], tags: ['identity'],
      authorRole: 'blueprint-bundle', createdBy: `blueprint-package:${pin.contentHash}`,
    });
    await expect(provision(pin, scope)).resolves.toBeUndefined();

    const changed = pinPackageInput({ ...input, value: { ...input.value, script: 'return 27' } });
    await expect(provision(changed, scope)).rejects.toThrow(/explicit migration is required/);
    expect((await getRecipe(db.adminSql, input.value.id))?.script).toBe('return 26');
  });

  it('upserts a recipe and reads it back (getRecipe + listRecipes)', async () => {
    const ws = 'ws-cr-basic';
    const row = await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'triage-stale-items',
      title: 'Triage stale items',
      description: 'list then act per stale work-item',
      script: '// triage\nreturn await tools.work_items.list({});',
      authorRole: 'cup',
      toolsUsed: ['work_items:list'],
      ...profiledEmbedding(fakeEmbedding()),
      tags: ['triage'],
      createdBy: 'owner-1',
    });
    expect(row.id).toBe('triage-stale-items');
    expect(row.title).toBe('Triage stale items');
    expect(row.toolsUsed).toEqual(['work_items:list']);
    expect(row.runCount).toBe(0);
    expect(row.successCount).toBe(0);
    expect(row.lastRunAt).toBeNull();
    expect(row.status).toBe('active');
    expect(row.hasEmbedding).toBe(true);
    const [storedIdentity] = await db.adminSql<Array<{
      embedding_mode: string | null;
      embedding_profile: string | null;
    }>>`
      SELECT embedding_mode, embedding_profile
        FROM harness_shared.code_recipes
       WHERE id = 'triage-stale-items'`;
    expect(storedIdentity).toEqual({
      embedding_mode: 'gemma',
      embedding_profile: EMBEDDER_DIM_SPECS.gemma.profileId,
    });
    expect(row.createdBy).toBe('owner-1');
    expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false);

    const got = await getRecipe(db.adminSql, 'triage-stale-items');
    expect(got?.title).toBe('Triage stale items');
    const list = await listRecipes(db.adminSql, { includeTrivial: true });
    expect(list.some((r) => r.id === 'triage-stale-items')).toBe(true);
  });

  it('upsert updates title/description/script/tools in place by id (no duplicate)', async () => {
    const first = await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'note',
      title: 'Note',
      description: 'first',
      script: 'return 1;',
    });
    const second = await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'note',
      title: 'Note v2',
      description: 'second',
      script: 'return 2;',
      toolsUsed: ['coord:send'],
    });
    expect(second.id).toBe(first.id);
    expect(second.title).toBe('Note v2');
    expect(second.description).toBe('second');
    expect(second.script).toBe('return 2;');
    expect(second.toolsUsed).toEqual(['coord:send']);
    const list = await listRecipes(db.adminSql, { includeTrivial: true });
    expect(list.filter((r) => r.id === 'note')).toHaveLength(1);
  });

  it('revises recipe source with compare-and-swap without recording a run or moving counters', async () => {
    const initial = await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'source-revision',
      title: 'Source revision',
      description: 'correct stored source without replaying it',
      script: 'return await tools.state.read({ cell: "old" });',
      toolsUsed: ['state:read'],
    });
    await recordRecipeRun(db.adminSql, {
      recipeId: initial.id,
      workspaceId: 'ws-revise',
      potSlug: null,
      success: true,
    });
    await recordRecipeRun(db.adminSql, {
      recipeId: initial.id,
      workspaceId: 'ws-revise',
      potSlug: null,
      success: true,
    });
    const before = await getRecipe(db.adminSql, initial.id);
    expect(before).toMatchObject({ runCount: 2, successCount: 2 });

    const result = await reviseRecipeSource(db.adminSql, {
      id: initial.id,
      title: 'Source revision v2',
      description: 'Corrected source and catalog description in one CAS revision.',
      script: 'return await tools.state.read({ cell: "new" });',
      toolsUsed: ['state:read'],
      expectedUpdatedAt: before!.updatedAt,
    });
    expect(result.status).toBe('updated');
    if (result.status !== 'updated') throw new Error(`unexpected revision result: ${result.status}`);
    expect(result.row).toMatchObject({
      title: 'Source revision v2',
      description: 'Corrected source and catalog description in one CAS revision.',
      script: 'return await tools.state.read({ cell: "new" });',
      runCount: 2,
      successCount: 2,
    });

    const stale = await reviseRecipeSource(db.adminSql, {
      id: initial.id,
      script: 'return "stale overwrite";',
      toolsUsed: [],
      expectedUpdatedAt: before!.updatedAt,
    });
    expect(stale.status).toBe('conflict');
    await expect(getRecipe(db.adminSql, initial.id)).resolves.toMatchObject({
      title: 'Source revision v2',
      description: 'Corrected source and catalog description in one CAS revision.',
      script: 'return await tools.state.read({ cell: "new" });',
      runCount: 2,
      successCount: 2,
    });

    const runRows = await db.adminSql<{ count: string }[]>`
      SELECT count(*)::text AS count
        FROM harness_shared.code_recipe_runs
       WHERE recipe_id = ${initial.id}`;
    expect(parseInt(runRows[0].count, 10)).toBe(2);
  });

  it('revises a runtime-input contract atomically with the source under the same compare-and-swap', async () => {
    const initial = await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'contract-revision',
      title: 'Contract revision',
      description: 'bind an invocation-scoped work item id',
      script: 'return await tools.state.read({ cell: "old" });',
    });
    await recordRecipeRun(db.adminSql, {
      recipeId: initial.id,
      workspaceId: 'ws-contract-revise',
      potSlug: null,
      success: true,
    });
    const before = await getRecipe(db.adminSql, initial.id);
    const bindingSchema = {
      version: 1 as const,
      properties: {
        issueId: {
          type: 'string' as const,
          required: true,
          description: 'Scorecard work-item id for this invocation.',
          lifetime: { kind: 'invocation-ephemeral' as const },
        },
      },
      additionalProperties: false as const,
    };
    const capabilityManifest = {
      version: 1 as const,
      representation: 'recipe-script' as const,
      topology: { premises: ['host:same' as const] as ['host:same'] },
      requirements: [{ capability: 'tools:state:read' as const }],
      lifecycle: { allowed: ['foreground' as const], default: 'foreground' as const },
      replay: { class: 'read-only' as const },
      content: { emits: ['text' as const] },
    };
    const script = 'return await tools.state.read({ cell: inputs.issueId });';

    const revised = await reviseRecipeSource(db.adminSql, {
      id: initial.id,
      script,
      toolsUsed: ['state:read'],
      contract: { bindingSchema, capabilityManifest },
      expectedUpdatedAt: before!.updatedAt,
    });
    expect(revised.status).toBe('updated');
    if (revised.status !== 'updated') throw new Error(`unexpected revision result: ${revised.status}`);
    expect(revised.row).toMatchObject({
      script,
      bindingSchema,
      capabilityManifest,
      runCount: 1,
      successCount: 1,
    });

    const stale = await reviseRecipeSource(db.adminSql, {
      id: initial.id,
      script: 'return "stale contract overwrite";',
      toolsUsed: [],
      contract: { bindingSchema: null, capabilityManifest: null },
      expectedUpdatedAt: before!.updatedAt,
    });
    expect(stale.status).toBe('conflict');
    await expect(getRecipe(db.adminSql, initial.id)).resolves.toMatchObject({
      script,
      bindingSchema,
      capabilityManifest,
      runCount: 1,
      successCount: 1,
    });
  });

  it('round-trips the exact versioned recipe contract and clears it when a later revision omits it', async () => {
    const bindingSchema = {
      version: 1 as const,
      properties: {
        plan: { type: 'string' as const, required: true, lifetime: { kind: 'stable' as const } },
      },
      additionalProperties: false as const,
    };
    const capabilityManifest = {
      version: 1 as const,
      representation: 'recipe-script' as const,
      topology: { premises: ['host:same' as const] as ['host:same'] },
      requirements: [{ capability: 'tools:plans:get' as const }],
      lifecycle: { allowed: ['foreground' as const], default: 'foreground' as const },
      replay: { class: 'read-only' as const },
      content: { emits: ['text' as const] },
    };
    const row = await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'typed-contract',
      title: 'Typed contract',
      description: 'reads a plan selected at runtime',
      script: 'return await tools.plans.get({ slug: inputs.plan });',
      bindingSchema,
      capabilityManifest,
    });
    expect(row.bindingSchema).toEqual(bindingSchema);
    expect(row.capabilityManifest).toEqual(capabilityManifest);
    await expect(getRecipe(db.adminSql, row.id)).resolves.toMatchObject({
      bindingSchema,
      capabilityManifest,
    });

    const listed = (await listRecipes(db.adminSql, { includeTrivial: true })).find((item) => item.id === row.id);
    expect(listed).not.toHaveProperty('bindingSchema');
    expect(listed).not.toHaveProperty('capabilityManifest');

    const legacyRevision = await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: row.id,
      title: row.title,
      description: row.description,
      script: 'return await tools.plans.list({});',
    });
    expect(legacyRevision.bindingSchema).toBeNull();
    expect(legacyRevision.capabilityManifest).toBeNull();
  });

  it('refuses a binding schema without the manifest that defines its admission contract', async () => {
    await expect(
      upsertRecipe(db.adminSql, {
        potSlug: null,
        id: 'invalid-contract',
        title: 'Invalid contract',
        description: 'must fail before SQL',
        script: 'return 1;',
        bindingSchema: { version: 1, properties: {}, additionalProperties: false },
      }),
    ).rejects.toThrow('bindingSchema requires capabilityManifest');
  });

  it('upsert PRESERVES an existing embedding when re-run without one', async () => {
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'emb',
      title: 'Emb',
      description: 'has embedding',
      script: 'return 1;',
      ...profiledEmbedding(fakeEmbedding(0.2)),
    });
    // re-upsert with embedding omitted (embedder unavailable) — must not wipe it
    const after = await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'emb',
      title: 'Emb',
      description: 'still has embedding',
      script: 'return 2;',
      embedding: null,
    });
    expect(after.hasEmbedding).toBe(true);
  });

  it('P003-COSTS: keeps measured zero, missing units and invocation identity distinct without storing extra input', async () => {
    const recipe = await upsertRecipe(db.adminSql, { id: 'p003-measured-run', potSlug: null,
      title: 'Measured run', description: 'Raw units fixture', script: 'return 1;' });
    const runEvidence = { version: 1 as const, invocationId: 'dispatch:recorded', attempt: 2, executed: true,
      sourceBytes: 13, intermediateBytes: null, elapsedBeforeRecordMs: 0 };
    await recordRecipeRun(db.adminSql, {
      recipeId: recipe.id, workspaceId: 'ws-p003-costs', potSlug: null,
      countTowardRecipe: false, runEvidence: { ...runEvidence, rawScript: 'must not persist' } as typeof runEvidence,
    });
    const rows = await db.adminSql`SELECT execution_trace FROM harness_shared.code_recipe_runs
      WHERE workspace_id = 'ws-p003-costs'`;
    expect(rows[0].execution_trace).toEqual({ runEvidence });
    for (const intermediateBytes of [-1, NaN, Infinity]) {
      await expect(recordRecipeRun(db.adminSql, { recipeId: recipe.id, workspaceId: 'ws-p003-costs',
        potSlug: null, runEvidence: { ...runEvidence, intermediateBytes } })).rejects.toThrow('invalid_recipe_run_evidence');
    }
    expect(await db.adminSql`SELECT id FROM harness_shared.code_recipe_runs WHERE workspace_id = 'ws-p003-costs'`).toHaveLength(1);
  });

  it('recordRecipeRun increments run_count/success_count/last_run_at + writes a run row', async () => {
    const ws = 'ws-cr-runs';
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'runner',
      title: 'Runner',
      description: 'd',
      script: 'return 1;',
    });

    await recordRecipeRun(db.adminSql, {
      recipeId: 'runner',
      workspaceId: ws,
      potSlug: 'alpha',
      agentOwner: 'agent-a',
      agentRole: 'cup',
      success: true,
      reused: false,
    });
    await recordRecipeRun(db.adminSql, {
      recipeId: 'runner',
      workspaceId: ws,
      potSlug: 'alpha',
      agentOwner: 'agent-b',
      agentRole: 'su',
      success: false,
    });

    const row = await getRecipe(db.adminSql, 'runner');
    expect(row?.runCount).toBe(2);
    expect(row?.successCount).toBe(1); // only the success bumps it
    expect(row?.lastRunAt).not.toBeNull();

    const runRows = await db.adminSql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM harness_shared.code_recipe_runs
       WHERE recipe_id = 'runner' AND workspace_id = ${ws}`;
    expect(parseInt(runRows[0].count, 10)).toBe(2);
  });

  it('records a trace-only execution and can preserve recipe counters for preview/failure evidence', async () => {
    const ws = 'ws-cr-traces';
    const executionTrace = {
      schemaVersion: 1 as const,
      backend: 'server' as const,
      requirements: { tools: [], capabilities: [], premises: ['host:same'] as ['host:same'] },
      toolGraph: { staticCalls: [], runtimeCalls: [] },
      stableBindings: [],
      ephemeralValues: [],
      redactedSecretPaths: [],
      portability: { host: 'same' as const, replayability: 'deterministic' as const, ephemeralKinds: [] },
      structuralFingerprint: 'c'.repeat(64),
    };

    await recordRecipeRun(db.adminSql, {
      recipeId: null,
      workspaceId: ws,
      potSlug: 'alpha',
      success: false,
      executionTrace,
      countTowardRecipe: false,
    });

    await upsertRecipe(db.adminSql, {
      id: 'previewed',
      title: 'Previewed',
      description: 'd',
      script: 'return 1;',
      potSlug: null,
    });
    await recordRecipeRun(db.adminSql, {
      recipeId: 'previewed',
      workspaceId: ws,
      potSlug: 'alpha',
      success: true,
      reused: true,
      executionTrace,
      countTowardRecipe: false,
    });

    const traceRows = await db.adminSql<
      Array<{
        recipe_id: string | null;
        execution_trace: typeof executionTrace;
        structural_fingerprint: string;
      }>
    >`
      SELECT recipe_id, execution_trace, structural_fingerprint
        FROM harness_shared.code_recipe_runs
       WHERE workspace_id = ${ws}
       ORDER BY id`;
    expect(traceRows).toHaveLength(2);
    expect(traceRows[0]).toEqual({
      recipe_id: null,
      execution_trace: executionTrace,
      structural_fingerprint: executionTrace.structuralFingerprint,
    });
    expect(traceRows[1].recipe_id).toBe('previewed');
    expect(await getRecipe(db.adminSql, 'previewed')).toMatchObject({ runCount: 0, successCount: 0, lastRunAt: null });
  });

  it('P002: round-trips scoped operation contracts in the existing run store and rechecks revoked/expired evidence', async () => {
    const workspaceId = 'ws-cr-operation-contract';
    const operations: OperationAdapterEvidence[] = (['composition', 'shell', 'sql'] as const).map((family, index) => ({
      operationId: `invocation:${index}`, family, adapterVersion: `${family}:adapter-v1`,
      semanticIdentity: { version: `${family}:intent-v1`, fingerprint: String(index + 1).repeat(64),
        workspaceId, sourceBoundary: 'private-source:1', epoch: 'key-epoch:1' },
      source: { ref: `source:${index}`, authorityRef: `acl:${index}`, observedAt: '2026-11-05T00:00:00Z',
        expiresAt: '2026-11-07T00:00:00Z', providerCallId: `call:${index}` },
      outcome: { status: 'success', final: true, receiptRef: `result:${index}` }, replayClass: 'read-only',
      bindingSchema: { version: 1, additionalProperties: false,
        properties: { tenant: { type: 'resource-ref', lifetime: { kind: 'resolved-ref', refKind: 'resource', resolution: 'each-run' } } } },
      decisionRefs: ['review:original-edition'],
    }));
    const trace = await normalizeExecutionTrace({ script: 'return 1;', tools: [], operations,
      dependencies: [{ fromOperationId: 'invocation:0', toOperationId: 'invocation:1', kind: 'data', evidenceRef: 'binding-receipt:1' }] });
    await recordRecipeRun(db.adminSql, { workspaceId, potSlug: 'alpha', executionTrace: trace, success: true });
    const rows = await db.adminSql<{ execution_trace: NormalizedExecutionTrace; structural_fingerprint: string }[]>`
      SELECT execution_trace, structural_fingerprint FROM harness_shared.code_recipe_runs WHERE workspace_id = ${workspaceId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].execution_trace).toEqual(trace);
    expect(rows[0].structural_fingerprint).toBe(trace.structuralFingerprint);
    const readable = (now: string, canRead: (source: OperationAdapterEvidence['source']) => boolean, workspace = workspaceId) =>
      readableOperationEvidence(rows[0].execution_trace, { workspaceId: workspace, now: Date.parse(now), canRead });
    expect(readable('2026-11-06T00:00:00Z', () => true)).toHaveLength(3);
    expect(readable('2026-11-06T00:00:00Z', source => source.authorityRef !== 'acl:1').map(row => row.family)).toEqual(['composition', 'sql']);
    expect(readable('2026-11-06T00:00:00Z', () => false)).toEqual([]);
    expect(readable('2026-11-07T00:00:00Z', () => true)).toEqual([]);
    expect(readable('2026-11-06T00:00:00Z', () => true, 'another-workspace')).toEqual([]);
    // Revocation removes eligibility, while retained audit/decision history survives.
    expect(rows[0].execution_trace.operations?.map(row => row.decisionRefs)).toEqual(operations.map(row => row.decisionRefs));
  });

  it('finds the most established active recipe for an exact structural fingerprint', async () => {
    const ws = 'ws-cr-fingerprint';
    const executionTrace = {
      schemaVersion: 1 as const,
      backend: 'server' as const,
      requirements: { tools: [], capabilities: [], premises: ['host:same'] as ['host:same'] },
      toolGraph: { staticCalls: [], runtimeCalls: [] },
      stableBindings: [],
      ephemeralValues: [],
      redactedSecretPaths: [],
      portability: { host: 'same' as const, replayability: 'deterministic' as const, ephemeralKinds: [] },
      structuralFingerprint: 'd'.repeat(64),
    };

    await upsertRecipe(db.adminSql, {
      id: 'fingerprint-low',
      title: 'Low',
      description: 'd',
      script: 's',
      potSlug: null,
    });
    await upsertRecipe(db.adminSql, {
      id: 'fingerprint-hot',
      title: 'Hot',
      description: 'd',
      script: 's',
      potSlug: null,
    });
    await upsertRecipe(db.adminSql, {
      id: 'fingerprint-retired',
      title: 'Retired',
      description: 'd',
      script: 's',
      potSlug: null,
    });
    await recordRecipeRun(db.adminSql, { recipeId: 'fingerprint-low', workspaceId: ws, potSlug: null, executionTrace });
    await recordRecipeRun(db.adminSql, { recipeId: 'fingerprint-hot', workspaceId: ws, potSlug: null, executionTrace });
    await recordRecipeRun(db.adminSql, { recipeId: 'fingerprint-hot', workspaceId: ws, potSlug: null, executionTrace });
    await recordRecipeRun(db.adminSql, {
      recipeId: 'fingerprint-retired',
      workspaceId: ws,
      potSlug: null,
      executionTrace,
    });
    await db.adminSql`UPDATE harness_shared.code_recipes SET status = 'retired' WHERE id = 'fingerprint-retired'`;
    await recordRecipeRun(db.adminSql, {
      recipeId: null,
      workspaceId: ws,
      potSlug: null,
      executionTrace,
      countTowardRecipe: false,
    });

    await expect(
      findActiveRecipeByStructuralFingerprint(db.adminSql, executionTrace.structuralFingerprint),
    ).resolves.toMatchObject({ id: 'fingerprint-hot', runCount: 2, status: 'active' });
    await expect(findActiveRecipeByStructuralFingerprint(db.adminSql, 'e'.repeat(64))).resolves.toBeNull();
  });

  it('listRecipes returns the global recipe corpus', async () => {
    await upsertRecipe(db.adminSql, { id: 'h1', title: 'H1', description: 'd', script: 's', potSlug: null });
    await upsertRecipe(db.adminSql, { id: 'h2', title: 'H2', description: 'd', script: 's', potSlug: null });
    await upsertRecipe(db.adminSql, { id: 'g1', title: 'G1', description: 'd', script: 's', potSlug: null });

    const ids = new Set((await listRecipes(db.adminSql, { includeTrivial: true })).map((r) => r.id));
    expect(ids.has('h1')).toBe(true);
    expect(ids.has('h2')).toBe(true);
    expect(ids.has('g1')).toBe(true);
  });

  it('is global — recipes are visible by id regardless of run workspace', async () => {
    await upsertRecipe(db.adminSql, { id: 'p', title: 'A', description: 'd', script: 's', potSlug: null });
    await upsertRecipe(db.adminSql, { id: 'p2', title: 'B', description: 'd', script: 's', potSlug: null });
    expect((await getRecipe(db.adminSql, 'p'))?.title).toBe('A');
    expect((await getRecipe(db.adminSql, 'p2'))?.title).toBe('B');
  });

  it('listRecipes HIDES low-value recipes by default; includeTrivial returns them (P-004)', async () => {
    // multi-tool, authored title → reuse-worthy (shown by default)
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'multi-tool-worthy',
      title: 'Triage and block stale items',
      description: 'd',
      script: 's',
      toolsUsed: ['work_items:list', 'work_items:set_state'],
    });
    // 1-tool wrapper → low-value (hidden by default)
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'one-tool-wrapper',
      title: 'Just list plans',
      description: 'd',
      script: 's',
      toolsUsed: ['plans:list'],
    });
    // auto-derived fallback title ("recipe: …") on a multi-tool script → low-value
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'auto-titled',
      title: 'recipe: plans:add-item + plans:set-status',
      description: 'd',
      script: 's',
      toolsUsed: ['plans:add-item', 'plans:set-status'],
    });

    const def = new Set((await listRecipes(db.adminSql)).map((r) => r.id));
    expect(def.has('multi-tool-worthy')).toBe(true);
    expect(def.has('one-tool-wrapper')).toBe(false); // hidden: ≤1 tool
    expect(def.has('auto-titled')).toBe(false); // hidden: auto-derived title

    const all = new Set((await listRecipes(db.adminSql, { includeTrivial: true })).map((r) => r.id));
    expect(all.has('multi-tool-worthy')).toBe(true);
    expect(all.has('one-tool-wrapper')).toBe(true);
    expect(all.has('auto-titled')).toBe(true);
  });

  // ── mergeRecipes (Phase 4, P-010 / D-015) ───────────────────────────────────
  describe('mergeRecipes', () => {
    it('folds duplicates into the survivor: status=merged, merged_into set, counts summed', async () => {
      const ws = 'ws-cr-merge';
      // Survivor with some usage.
      await upsertRecipe(db.adminSql, {
        id: 'survivor',
        title: 'Survivor',
        description: 'd',
        script: 's',
        potSlug: null,
      });
      // Two near-duplicates with their own usage.
      await upsertRecipe(db.adminSql, { id: 'dup-1', title: 'Dup 1', description: 'd', script: 's', potSlug: null });
      await upsertRecipe(db.adminSql, { id: 'dup-2', title: 'Dup 2', description: 'd', script: 's', potSlug: null });
      // Survivor: 2 runs / 2 success; dup-1: 3 runs / 2 success; dup-2: 1 run / 0 success.
      for (let i = 0; i < 2; i++)
        await recordRecipeRun(db.adminSql, { recipeId: 'survivor', workspaceId: ws, potSlug: 'alpha', success: true });
      await recordRecipeRun(db.adminSql, { recipeId: 'dup-1', workspaceId: ws, potSlug: 'alpha', success: true });
      await recordRecipeRun(db.adminSql, { recipeId: 'dup-1', workspaceId: ws, potSlug: 'alpha', success: true });
      await recordRecipeRun(db.adminSql, { recipeId: 'dup-1', workspaceId: ws, potSlug: 'alpha', success: false });
      await recordRecipeRun(db.adminSql, { recipeId: 'dup-2', workspaceId: ws, potSlug: 'alpha', success: false });

      const { survivor, mergedIds } = await mergeRecipes(db.adminSql, {
        survivorId: 'survivor',
        duplicateIds: ['dup-1', 'dup-2'],
      });

      // Survivor's counts = its own + both duplicates'. runs: 2+3+1=6, success: 2+2+0=4.
      expect(mergedIds.sort()).toEqual(['dup-1', 'dup-2']);
      expect(survivor.id).toBe('survivor');
      expect(survivor.status).toBe('active'); // survivor stays active
      expect(survivor.runCount).toBe(6);
      expect(survivor.successCount).toBe(4);

      // Duplicates are merged + point at the survivor.
      const d1 = await getRecipe(db.adminSql, 'dup-1');
      const d2 = await getRecipe(db.adminSql, 'dup-2');
      expect(d1?.status).toBe('merged');
      expect(d1?.mergedInto).toBe('survivor');
      expect(d2?.status).toBe('merged');
      expect(d2?.mergedInto).toBe('survivor');
    });

    it('never merges a recipe into itself + skips absent ids', async () => {
      const ws = 'ws-cr-merge-self';
      await upsertRecipe(db.adminSql, { id: 'keep', title: 'Keep', description: 'd', script: 's', potSlug: null });
      await upsertRecipe(db.adminSql, { id: 'real-dup', title: 'Dup', description: 'd', script: 's', potSlug: null });
      await recordRecipeRun(db.adminSql, { recipeId: 'keep', workspaceId: ws, potSlug: null, success: true });
      await recordRecipeRun(db.adminSql, { recipeId: 'real-dup', workspaceId: ws, potSlug: null, success: true });

      const { survivor, mergedIds } = await mergeRecipes(db.adminSql, {
        survivorId: 'keep',
        duplicateIds: ['keep', 'real-dup', 'missing'],
      });

      expect(mergedIds).toEqual(['real-dup']);
      // counts: keep 1 + real-dup 1 = 2 (the missing id + self contribute nothing)
      expect(survivor.runCount).toBe(2);
      // The survivor was NOT marked merged (self-merge guarded).
      expect(survivor.status).toBe('active');
      expect((await getRecipe(db.adminSql, 'keep'))?.mergedInto).toBeNull();
    });

    it('is idempotent — re-merging the same duplicate into the same survivor is a true no-op', async () => {
      const ws = 'ws-cr-merge-idem';
      await upsertRecipe(db.adminSql, { id: 's', title: 'S', description: 'd', script: 's', potSlug: null });
      await upsertRecipe(db.adminSql, { id: 'd', title: 'D', description: 'd', script: 's', potSlug: null });
      await recordRecipeRun(db.adminSql, { recipeId: 'd', workspaceId: ws, potSlug: null, success: true });

      const first = await mergeRecipes(db.adminSql, { survivorId: 's', duplicateIds: ['d'] });
      expect(first.mergedIds).toEqual(['d']);
      expect(first.survivor.runCount).toBe(1); // s(0) + d(1)

      // Replay: 'd' is already merged INTO 's', so it is skipped — counters are
      // NOT re-folded (no double-count) and it stays merged→s.
      const second = await mergeRecipes(db.adminSql, { survivorId: 's', duplicateIds: ['d'] });
      expect(second.mergedIds).toEqual([]); // nothing re-merged
      expect(second.survivor.runCount).toBe(1); // unchanged — the replay added nothing
      expect((await getRecipe(db.adminSql, 'd'))?.status).toBe('merged');
      expect((await getRecipe(db.adminSql, 'd'))?.mergedInto).toBe('s');
    });
  });

  // ── sweepRecipes (Phase 4, P-010) ───────────────────────────────────────────
  describe('sweepRecipes', () => {
    /** Make a recipe + force its last_run_at + run_count to simulate age/usage. */
    async function seedAged(
      ws: string,
      id: string,
      opts: { potSlug?: string | null; runCount: number; daysAgo: number | null; status?: string },
    ) {
      await upsertRecipe(db.adminSql, {
        potSlug: null,
        id,
        title: id,
        description: 'd',
        script: 's',
      });
      const status = opts.status ?? 'active';
      if (opts.daysAgo == null) {
        await db.adminSql`
          UPDATE harness_shared.code_recipes
             SET run_count = ${opts.runCount}, last_run_at = NULL, status = ${status}
           WHERE id = ${id}`;
      } else {
        await db.adminSql`
          UPDATE harness_shared.code_recipes
             SET run_count   = ${opts.runCount},
                 last_run_at = now() - make_interval(days => ${opts.daysAgo}),
                 status      = ${status}
           WHERE id = ${id}`;
      }
    }

    it('retires a stale 0/1-run recipe but NOT a hot one or a recently-run one', async () => {
      const ws = 'ws-cr-sweep';
      await seedAged(ws, 'stale-oneoff', { runCount: 1, daysAgo: 45 }); // SWEEP: stale + one-off
      await seedAged(ws, 'stale-zero', { runCount: 0, daysAgo: 60 }); // SWEEP: stale, never-rerun (but ran once long ago)
      await seedAged(ws, 'hot', { runCount: 12, daysAgo: 90 }); // KEEP: hot (over the cap) even though old
      await seedAged(ws, 'recent', { runCount: 1, daysAgo: 2 }); // KEEP: recent

      const { swept, dryRun } = await sweepRecipes(db.adminSql, { staleDays: 30, maxRunCount: 1 });
      expect(dryRun).toBe(false);
      expect(swept.map((r) => r.id).sort()).toEqual(['stale-oneoff', 'stale-zero']);
      for (const r of swept) expect(r.status).toBe('retired');

      expect((await getRecipe(db.adminSql, 'stale-oneoff'))?.status).toBe('retired');
      expect((await getRecipe(db.adminSql, 'stale-zero'))?.status).toBe('retired');
      expect((await getRecipe(db.adminSql, 'hot'))?.status).toBe('active');
      expect((await getRecipe(db.adminSql, 'recent'))?.status).toBe('active');
    });

    it('NEVER touches a promoted or merged recipe even when stale + one-off', async () => {
      const ws = 'ws-cr-sweep-protected';
      await seedAged(ws, 'promoted', { runCount: 1, daysAgo: 99, status: 'promoted' });
      await seedAged(ws, 'already-merged', { runCount: 1, daysAgo: 99, status: 'merged' });
      await seedAged(ws, 'plain-stale', { runCount: 1, daysAgo: 99, status: 'active' });

      const { swept } = await sweepRecipes(db.adminSql, { staleDays: 30, maxRunCount: 1 });
      expect(swept.map((r) => r.id)).toEqual(['plain-stale']); // only the active one
      expect((await getRecipe(db.adminSql, 'promoted'))?.status).toBe('promoted');
      expect((await getRecipe(db.adminSql, 'already-merged'))?.status).toBe('merged');
    });

    it('does NOT sweep a never-run recipe (NULL last_run_at has no staleness clock)', async () => {
      const ws = 'ws-cr-sweep-null';
      await seedAged(ws, 'never-run', { runCount: 0, daysAgo: null });
      const { swept } = await sweepRecipes(db.adminSql, { staleDays: 30, maxRunCount: 1 });
      expect(swept).toHaveLength(0);
      expect((await getRecipe(db.adminSql, 'never-run'))?.status).toBe('active');
    });

    it('dryRun changes NOTHING — returns the candidates, leaves status active', async () => {
      const ws = 'ws-cr-sweep-dry';
      await seedAged(ws, 'cand', { runCount: 1, daysAgo: 50 });

      const preview = await sweepRecipes(db.adminSql, { staleDays: 30, maxRunCount: 1, dryRun: true });
      expect(preview.dryRun).toBe(true);
      expect(preview.swept.map((r) => r.id)).toEqual(['cand']);
      // The candidate row in the preview reflects its CURRENT (still active) status.
      expect(preview.swept[0].status).toBe('active');
      // Nothing was mutated.
      expect((await getRecipe(db.adminSql, 'cand'))?.status).toBe('active');

      // A real run then actually retires it.
      const real = await sweepRecipes(db.adminSql, { staleDays: 30, maxRunCount: 1, dryRun: false });
      expect(real.swept.map((r) => r.id)).toEqual(['cand']);
      expect((await getRecipe(db.adminSql, 'cand'))?.status).toBe('retired');
    });

    it('sweeps globally across hives', async () => {
      const ws = 'ws-cr-sweep-hive';
      await seedAged(ws, 'alpha-stale', { potSlug: 'alpha', runCount: 1, daysAgo: 50 });
      await seedAged(ws, 'beta-stale', { potSlug: 'beta', runCount: 1, daysAgo: 50 });

      const { swept } = await sweepRecipes(db.adminSql, { staleDays: 30, maxRunCount: 1 });
      expect(swept.map((r) => r.id).sort()).toEqual(['alpha-stale', 'beta-stale']);
    });

    // ── targeted retire by id ────────────────────────────────────────────────
    // The heuristic selects purely by age + run-count, so it cannot express
    // "retire THIS known-broken recipe": reaching one recent recipe means
    // widening staleDays until the whole long tail qualifies with it.
    it('ids retires exactly the named recipes at ANY age/run-count, and nothing else', async () => {
      const ws = 'ws-cr-sweep-targeted';
      // Both of these are invisible to the heuristic: hot (12 runs) and recent (1 day).
      await seedAged(ws, 'broken-hot', { runCount: 12, daysAgo: 1 });
      await seedAged(ws, 'broken-recent', { runCount: 2, daysAgo: 0 });
      // A textbook heuristic candidate that was NOT named — targeting must not widen.
      await seedAged(ws, 'unnamed-stale-oneoff', { runCount: 1, daysAgo: 90 });

      const { swept, skipped, dryRun } = await sweepRecipes(db.adminSql, {
        ids: ['broken-hot', 'broken-recent'],
      });
      expect(dryRun).toBe(false);
      expect(swept.map((r) => r.id).sort()).toEqual(['broken-hot', 'broken-recent']);
      expect(skipped).toEqual([]);

      expect((await getRecipe(db.adminSql, 'broken-hot'))?.status).toBe('retired');
      expect((await getRecipe(db.adminSql, 'broken-recent'))?.status).toBe('retired');
      // The unnamed stale one-off the HEURISTIC would have taken is untouched:
      // targeting scopes the sweep, it does not merely re-rank it.
      expect((await getRecipe(db.adminSql, 'unnamed-stale-oneoff'))?.status).toBe('active');
    });

    it('ids keeps the safety rails and REPORTS every id it did not retire', async () => {
      const ws = 'ws-cr-sweep-targeted-rails';
      await seedAged(ws, 't-merged', { runCount: 1, daysAgo: 5, status: 'merged' });
      await seedAged(ws, 't-graduated', { runCount: 1, daysAgo: 5 });
      await db.adminSql`
        UPDATE harness_shared.code_recipes
           SET promoted_tool = 'some:verb'
         WHERE id = 't-graduated'`;
      await seedAged(ws, 't-ok', { runCount: 1, daysAgo: 5 });

      const { swept, skipped } = await sweepRecipes(db.adminSql, {
        ids: ['t-merged', 't-graduated', 't-ok', 't-typo-never-existed'],
      });

      expect(swept.map((r) => r.id)).toEqual(['t-ok']);
      // A short `swept` list is otherwise indistinguishable from a typo'd id, so
      // each miss must come back with a reason rather than being dropped.
      expect((skipped ?? []).map((s) => [s.id, s.reason]).sort()).toEqual([
        ['t-graduated', 'promoted'],
        ['t-merged', 'not_active'],
        ['t-typo-never-existed', 'not_found'],
      ]);
      expect((await getRecipe(db.adminSql, 't-merged'))?.status).toBe('merged');
      expect((await getRecipe(db.adminSql, 't-graduated'))?.status).toBe('active');
    });

    it('ids + dryRun previews the targets and mutates nothing', async () => {
      const ws = 'ws-cr-sweep-targeted-dry';
      await seedAged(ws, 't-dry', { runCount: 30, daysAgo: 0 });

      const preview = await sweepRecipes(db.adminSql, { ids: ['t-dry'], dryRun: true });
      expect(preview.dryRun).toBe(true);
      expect(preview.swept.map((r) => r.id)).toEqual(['t-dry']);
      expect(preview.swept[0].status).toBe('active');
      expect((await getRecipe(db.adminSql, 't-dry'))?.status).toBe('active');

      const real = await sweepRecipes(db.adminSql, { ids: ['t-dry'], dryRun: false });
      expect(real.swept.map((r) => r.id)).toEqual(['t-dry']);
      expect((await getRecipe(db.adminSql, 't-dry'))?.status).toBe('retired');
    });
  });
});
