import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { InnerCall } from '../_compound-dispatch';
import { createSavedRecipeAdapter, type SavedRecipeAuthority } from './saved-recipe-adapter';

const metadata: SavedRecipeAuthority = {
  version: 1,
  revision: 'a'.repeat(64),
  refs: {
    workspaces: [],
    fleets: [],
    plans: [],
    harnesses: ['papercusp'],
    items: [],
    resources: [],
  },
  requiresContext: true,
  runnable: true,
};

const proof: SavedRecipeAuthority = {
  version: 1,
  revision: 'a'.repeat(64),
  context: { harness: 'papercusp' },
};

const recipe = {
  id: 'triage-stale-work-items',
  title: 'Triage stale work items',
  script: 'return { ok: true };',
  authority: metadata,
};

const getEnvelope = {
  ok: true,
  results: [{ ok: true, id: recipe.id, recipe }],
  counts: { requested: 1, succeeded: 1, failed: 0 },
};

describe('saved-recipe adapter', () => {
  it('P001-INVENTORY: retains source and generation qualifications for the frozen family population', () => {
    const inventory = JSON.parse(readFileSync(new URL('../../../../../docs/evidence/unified-learning-inventory-20261106.json', import.meta.url), 'utf8'));
    expect(inventory.families.map((row: { family: string }) => row.family).sort()).toEqual([
      'composition', 'native-operation', 'result-recovery', 'search-reformulation', 'shell', 'sql', 'workaround-funnel',
    ]);
    expect(inventory.baseline).toMatchObject({ status: 'UNKNOWN', counts: null, interval: '[since,until)' });
    expect(Date.parse(inventory.baseline.since)).toBeLessThan(Date.parse(inventory.baseline.until));
    for (const row of inventory.families) {
      expect(readFileSync(new URL(`../../../../../${row.source}`, import.meta.url), 'utf8').length).toBeGreaterThan(0);
      expect(row.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(row.clients.length).toBeGreaterThan(0);
      const runtime = inventory.runtimes[row.runtime];
      expect(runtime).toBeDefined();
      if (row.coverage === 'measured') {
        expect(row.executionSourceRef).toBeTruthy();
        expect(runtime.identity).toBe('known');
        expect(runtime.build).toBeTruthy();
        expect(runtime.evidenceRef).toBeTruthy();
      } else {
        expect(row.coverage).toBe('UNKNOWN');
        expect(row.reason.length).toBeGreaterThan(0);
      }
    }
    expect(inventory.families.find((row: { family: string }) => row.family === 'native-operation')).toMatchObject({
      clients: ['claude', 'codex', 'omp'], coverage: 'UNKNOWN', executionSourceRef: null,
    });
  });

  // Freeze compatibility at the existing recipe boundary. These are authored
  // fixtures, not evidence that any native provider or live census is complete.
  it.each([
    ['composition', "return tools.workItems.get({ id: 'WI-100', harness: 'papercusp' });"],
    ['shell', "return tools.capability.bash({ command: 'rg --files src', cwd: '/repo' });"],
    ['sql', "return tools.capability.sql({ query: 'SELECT id FROM jobs WHERE id = $1', params: [1] });"],
  ])('preserves a legacy %s recipe and its source metadata without making that metadata execution authority', async (family, script) => {
    const legacy = {
      ...recipe,
      script,
      source: { family, boundary: 'private-source', ref: 'source:legacy-1' },
      review: { edition: 2, decisionRef: 'decision:legacy-2' },
      author: { principal: 'historical-admin', capabilities: ['*'] },
    };
    const envelope = { ...getEnvelope, results: [{ ok: true, id: recipe.id, recipe: legacy }] };
    const seen: unknown[] = [];
    const call: InnerCall = async (name, args) => {
      if (name === 'recipes:get') return envelope;
      if (name !== 'recipes:run') throw new Error(`unexpected dispatch: ${name}`);
      seen.push(args);
      // The canonical run remains free to refuse the CURRENT caller even when
      // the historical author could execute the script.
      return { ok: false, error: 'capability_denied', executed: false };
    };
    const adapter = createSavedRecipeAdapter(call);
    const inspected = await adapter.inspect({ id: recipe.id });
    expect(inspected.ok && inspected.recipe).toBe(legacy);
    expect(inspected.ok && inspected.continuation.authority).toBe(metadata);

    expect(await adapter.run({ recipe: { id: recipe.id, authority: proof } })).toEqual({
      ok: false, error: 'capability_denied', executed: false,
    });
    expect(seen).toEqual([{ id: recipe.id, authority: proof }]);
    expect(JSON.stringify(seen)).not.toContain('historical-admin');
    expect(JSON.stringify(seen)).not.toContain('private-source');
  });

  it('selects the requested result by identity when legacy batch results are reordered', async () => {
    const other = { ...recipe, id: 'other', authority: { ...metadata, revision: 'b'.repeat(64) } };
    const call = vi.fn<InnerCall>().mockResolvedValue({
      ok: true,
      results: [{ ok: true, id: other.id, recipe: other }, ...getEnvelope.results],
    });
    const inspected = await createSavedRecipeAdapter(call).inspect({ id: recipe.id });
    expect(inspected).toMatchObject({ ok: true, continuation: { id: recipe.id, revision: metadata.revision } });
    expect(inspected.ok && inspected.recipe).toBe(recipe);
  });

  it('never borrows another recipe revision when the requested result is absent', async () => {
    const call = vi.fn<InnerCall>().mockResolvedValue({
      ok: true, results: [{ ok: true, id: 'other', recipe }],
    });
    await expect(createSavedRecipeAdapter(call).run({ recipe: { id: recipe.id } }))
      .rejects.toThrow(`recipes:get omitted result for ${recipe.id}`);
    expect(call.mock.calls.map(([name]) => name)).toEqual(['recipes:get']);
  });

  it('does not replay a legacy recipe without a current authority revision', async () => {
    const call = vi.fn<InnerCall>().mockResolvedValue({
      ok: true, results: [{ ok: true, id: recipe.id, recipe: { ...recipe, authority: undefined } }],
    });
    await expect(createSavedRecipeAdapter(call).run({ recipe: { id: recipe.id } }))
      .rejects.toThrow(`recipes:get returned no revision for ${recipe.id}`);
    expect(call.mock.calls.map(([name]) => name)).toEqual(['recipes:get']);
  });

  it('delegates search losslessly so the exact recipes:search continuation survives', async () => {
    const searchEnvelope = {
      ok: true,
      query: 'triage stale work',
      recipes: [{ id: recipe.id, runArgs: { id: recipe.id, authority: proof } }],
    };
    const call = vi.fn<InnerCall>().mockResolvedValue(searchEnvelope);
    const adapter = createSavedRecipeAdapter(call);

    const result = await adapter.search({
      query: 'triage stale work',
      limit: 3,
      context: { harness: 'papercusp' },
    });

    expect(result).toBe(searchEnvelope);
    expect(call).toHaveBeenCalledWith('recipes:search', {
      query: 'triage stale work',
      limit: 3,
      context: { harness: 'papercusp' },
    });
  });

  it('inspects through recipes:get and returns its exact current authority metadata', async () => {
    const call = vi.fn<InnerCall>().mockResolvedValue(getEnvelope);
    const adapter = createSavedRecipeAdapter(call);

    const result = await adapter.inspect({ id: recipe.id });

    expect(result).toMatchObject({
      ok: true,
      continuation: { id: recipe.id, revision: 'a'.repeat(64) },
    });
    expect(result.ok && result.continuation.authority).toBe(metadata);
    expect(call).toHaveBeenCalledWith('recipes:get', { id: recipe.id });
  });

  it('replays through recipes:run with the caller-supplied search proof unchanged', async () => {
    const runEnvelope = {
      ok: true,
      results: [{ ok: true, id: recipe.id, result: { summary: { triaged: 4 } } }],
      counts: { requested: 1, succeeded: 1, failed: 0 },
    };
    const call = vi.fn<InnerCall>().mockResolvedValueOnce(getEnvelope).mockResolvedValueOnce(runEnvelope);
    const adapter = createSavedRecipeAdapter(call);

    const result = await adapter.run({
      recipe: { id: recipe.id, revision: 'a'.repeat(64), authority: proof },
      timeoutSec: 20,
      dryRun: true,
    });

    expect(result).toBe(runEnvelope);
    expect(call).toHaveBeenNthCalledWith(1, 'recipes:get', { id: recipe.id });
    expect(call).toHaveBeenNthCalledWith(2, 'recipes:run', {
      id: recipe.id,
      authority: proof,
      timeoutSec: 20,
      dryRun: true,
    });
    const runArgs = call.mock.calls[1]?.[1] as { authority: unknown };
    expect(runArgs.authority).toBe(proof);
  });

  it('uses current recipes:get metadata when no search proof was supplied', async () => {
    const call = vi
      .fn<InnerCall>()
      .mockResolvedValueOnce(getEnvelope)
      .mockResolvedValueOnce({ ok: true, results: [], counts: {} });
    const adapter = createSavedRecipeAdapter(call);

    await adapter.run({ recipe: { id: recipe.id } });

    const runArgs = call.mock.calls[1]?.[1] as { authority: unknown };
    expect(runArgs.authority).toBe(metadata);
  });

  it('fails a stale revision before recipes:run can dispatch', async () => {
    const call = vi.fn<InnerCall>().mockResolvedValue(getEnvelope);
    const adapter = createSavedRecipeAdapter(call);

    const result = await adapter.run({
      recipe: { id: recipe.id, revision: 'b'.repeat(64), authority: proof },
    });

    expect(result).toMatchObject({
      ok: false,
      phase: 'preflight',
      executed: false,
      error: { code: 'recipe_authority_stale', path: 'recipe.revision' },
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('fails a stale authority proof before recipes:run can dispatch', async () => {
    const staleProof: SavedRecipeAuthority = {
      version: 1,
      revision: 'b'.repeat(64),
      context: { harness: 'papercusp' },
    };
    const call = vi.fn<InnerCall>().mockResolvedValue(getEnvelope);
    const adapter = createSavedRecipeAdapter(call);

    const result = await adapter.run({ recipe: { id: recipe.id, authority: staleProof } });

    expect(result).toMatchObject({
      ok: false,
      phase: 'preflight',
      executed: false,
      error: { code: 'recipe_authority_stale', path: 'recipe.authority.revision' },
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('forwards bindings only after inspecting and pinning the current recipe revision', async () => {
    const runEnvelope = {
      ok: true,
      results: [{ ok: true, id: recipe.id, result: { summary: { ageDays: 30 } } }],
      counts: { requested: 1, succeeded: 1, failed: 0 },
    };
    const call = vi.fn<InnerCall>().mockResolvedValueOnce(getEnvelope).mockResolvedValueOnce(runEnvelope);
    const adapter = createSavedRecipeAdapter(call);

    const result = await adapter.run({
      recipe: { id: recipe.id },
      bindings: { values: { ageDays: 30 } },
    });

    expect(result).toBe(runEnvelope);
    expect(call).toHaveBeenNthCalledWith(1, 'recipes:get', { id: recipe.id });
    expect(call).toHaveBeenNthCalledWith(2, 'recipes:run', {
      id: recipe.id,
      authority: metadata,
      bindings: { values: { ageDays: 30 } },
    });
  });

  it('maps a missing saved recipe to the public preflight failure shape', async () => {
    const call = vi.fn<InnerCall>().mockResolvedValue({
      ok: true,
      results: [{ ok: false, id: 'gone', error: 'not_found' }],
      counts: { requested: 1, succeeded: 0, failed: 1 },
    });
    const adapter = createSavedRecipeAdapter(call);

    const result = await adapter.inspect({ id: 'gone' });

    expect(result).toMatchObject({
      ok: false,
      phase: 'preflight',
      executed: false,
      error: { code: 'recipe_not_found', path: 'recipe.id' },
    });
  });
});
