import { describe, expect, it, vi } from 'vitest';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import { z } from 'zod';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ToolResult } from '@papercusp/tooldef';
import { DEFAULT_OUTPUT_SUMMARY_BUDGET_CHARS } from '../../output-envelope';
import { FOREGROUND_TIMEOUT_CEILING_MS } from '../capability/foreground-transport-cap';
import orchestrateRunTool, {
  runOrchestration,
  runServerScriptAdapter,
  serverScriptRunArgsSchema,
  type ServerScriptRunDeps,
} from './run';
import type { SavedRecipeAdapter } from './saved-recipe-adapter';
import { inspectOrchestration } from './inspect';

function codeResult(payload: Record<string, unknown>, media: ToolResult['content'] = []): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }, ...media],
  } as ToolResult;
}

function envelope(result: ToolResult) {
  const text = result.content.find((item) => item.type === 'text');
  if (!text || !('text' in text)) throw new Error('missing text envelope');
  return JSON.parse(text.text);
}

describe('orchestrate:run server-script adapter', () => {
  it('checks an inspect pin before executing a fresh script', async () => {
    const ctx = {} as UnifiedToolContext;
    const source = 'return "pinned";';
    const inspected = await inspectOrchestration({ script: { source } }, ctx);
    const data = (inspected as ToolResult & { data?: Record<string, unknown> }).data as {
      normalized: { durability: { pin: { sourceSha256: string; bindingsSha256: string } } };
    };
    const pin = data.normalized.durability.pin;
    const runCode = vi.fn<ServerScriptRunDeps['runCode']>().mockResolvedValue(codeResult({
      ok: true, summary: 'pinned', plannedMutations: [],
    }));
    const matching = await runServerScriptAdapter({ script: { source }, inspectionPin: pin }, ctx, { runCode });
    expect(envelope(matching)).toMatchObject({ state: 'complete', summary: 'pinned' });
    expect(runCode).toHaveBeenCalledTimes(1);

    runCode.mockClear();
    const changed = await runServerScriptAdapter({
      script: { source: source + ' ' }, inspectionPin: pin,
    }, ctx, { runCode });
    expect(envelope(changed)).toMatchObject({
      state: 'error', error: { code: 'inspection_pin_stale' },
      metrics: { phase: 'preflight', executed: false },
    });
    expect(runCode).not.toHaveBeenCalled();
  });
  it('uses the read-only facade capability while preserving the write-effect outer contract', () => {
    const projected = listAllProjectedTools().find((tool) => tool.expose.mcp?.name === 'orchestrate:run');
    expect(projected).toBeDefined();
    expect(projected?.capabilities).toEqual(['agent_tools:read']);
    expect(projected?.capabilities).not.toContain('capability:bash');
    expect(projected?.effect).toBe('write');
  });

  it('registers the unified public shape and returns a typed client-mode rejection', async () => {
    expect(orchestrateRunTool.name).toBe('orchestrate:run');
    expect(
      serverScriptRunArgsSchema.parse({
        script: { source: 'return "ok";' },
        execution: { mode: 'server', lifecycle: 'foreground' },
        capture: { mode: 'auto' },
      }),
    ).toMatchObject({ script: { source: 'return "ok";' } });
    expect(serverScriptRunArgsSchema.parse({ recipe: { id: 'saved' } })).toMatchObject({
      recipe: { id: 'saved' },
    });
    expect(serverScriptRunArgsSchema.safeParse({
      script: { source: 'return "durable";' },
      execution: { lifecycle: 'background', durability: 'durable' },
      timeoutSec: 120,
    }).success).toBe(true);
    expect(serverScriptRunArgsSchema.safeParse({
      script: { source: 'return "foreground";' },
      timeoutSec: 120,
    }).success).toBe(false);
    expect(serverScriptRunArgsSchema.safeParse({
      script: { source: 'return "foreground";' },
      timeoutSec: 60,
    }).success).toBe(false);
    expect(serverScriptRunArgsSchema.safeParse({
      durableControl: { workflowId: 'orchestrate-durable:ws:run', action: 'cancel' },
    }).success).toBe(true);

    const runCode = vi.fn<ServerScriptRunDeps['runCode']>();
    const result = await runOrchestration(
      { script: { source: 'return "ok";' }, execution: { mode: 'client' } },
      {} as UnifiedToolContext,
      { server: { runCode } },
    );
    expect(runCode).not.toHaveBeenCalled();
    expect(envelope(result)).toMatchObject({
      state: 'error',
      error: { code: 'execution_mode_unavailable' },
      metrics: { phase: 'preflight', executed: false },
    });
  });

  it('publishes the foreground timeout ceiling while preserving the durable timeout range', () => {
    type JsonSchema = {
      anyOf?: Array<{
        properties?: {
          execution?: { properties?: { durability?: { const?: unknown } } };
          timeoutSec?: { maximum?: number };
        };
        required?: string[];
      }>;
    };
    const schema = z.toJSONSchema(serverScriptRunArgsSchema, { io: 'input' }) as JsonSchema;
    const foreground = schema.anyOf?.find((branch) =>
      branch.properties?.timeoutSec?.maximum === FOREGROUND_TIMEOUT_CEILING_MS / 1000,
    );
    const durable = schema.anyOf?.find((branch) =>
      branch.properties?.timeoutSec?.maximum === 3_600,
    );

    expect(foreground).toBeDefined();
    expect(durable).toBeDefined();
    expect(durable?.required).toContain('execution');
    expect(durable?.properties?.execution?.properties?.durability).toMatchObject({ const: 'durable' });
  });

  it('delegates to code:run and emits the P-006 envelope without copying its payload', async () => {
    const runCode = vi.fn<ServerScriptRunDeps['runCode']>().mockResolvedValue(
      codeResult({
        ok: true,
        summary: { count: 2, kept: true },
        dispatchCount: 2,
        intermediateBytes: 9_000,
        plannedMutations: [],
      }),
    );
    const metadata = vi.fn();
    const result = await runServerScriptAdapter(
      {
        script: { source: 'return { count: 2, kept: true };', title: 'script title' },
        capture: { mode: 'never', title: 'capture title' },
        execution: { mode: 'auto' },
        timeoutSec: FOREGROUND_TIMEOUT_CEILING_MS / 1000,
      },
      { metadata } as unknown as UnifiedToolContext,
      { runCode },
    );

    expect(runCode).toHaveBeenCalledWith(
      {
        script: 'return { count: 2, kept: true };',
        title: 'capture title',
        timeoutSec: FOREGROUND_TIMEOUT_CEILING_MS / 1000,
      },
      expect.any(Object),
      'never',
    );
    expect(envelope(result)).toMatchObject({
      schemaVersion: 'papercusp.output-envelope/v1',
      summary: '{"count":2,"kept":true}',
      summaryProvenance: 'authored',
      content: [],
      state: 'complete',
      metrics: {
        backend: 'server',
        toolCalls: 3,
        intermediateBytes: 9_000,
        requestedTimeoutSec: FOREGROUND_TIMEOUT_CEILING_MS / 1000,
        requestedExecutionMode: 'auto',
        executionMode: 'server',
        executionModeDeprecated: true,
        captureMode: 'never',
      },
    });
    expect(envelope(result)).not.toHaveProperty('logs');
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({ backend: 'server' }));
  });

  it('keeps runtime safety evidence authoritative over contradictory script-authored claims', async () => {
    const result = await runServerScriptAdapter(
      { script: { source: `return { authorityUnchanged: true, midTurnInjectionUnchanged: true };` } },
      {} as UnifiedToolContext,
      {
        runCode: async () => codeResult({
          ok: true,
          summary: { authorityUnchanged: true, midTurnInjectionUnchanged: true },
          dispatchCount: 1,
          plannedMutations: [],
          runtimeObservations: {
            authorizationObservationCount: 1,
            authorityWideningDetected: true,
            midTurnPromptInjectionObservability: 'not-observable',
          },
        }),
      },
    );

    expect(envelope(result)).toMatchObject({
      summary: '{"authorityUnchanged":true,"midTurnInjectionUnchanged":true}',
      metrics: {
        authorizationObservationCount: 1,
        authorityWideningDetected: true,
        midTurnPromptInjectionObservability: 'not-observable',
      },
    });
  });

  it('returns store/load state as an accounted replay-state content item', async () => {
    const result = await runServerScriptAdapter(
      {
        script: {
          source: `store('cursor', load('cursor') + 1); return 'advanced';`,
          bindingSchema: {
            version: 1,
            properties: {
              cursor: { type: 'number', required: true, lifetime: { kind: 'stable' } },
              filters: { type: 'json', required: true, lifetime: { kind: 'stable' } },
            },
            additionalProperties: false,
          },
        },
        bindings: { values: { cursor: 2, filters: ['open'] } },
      },
      {} as UnifiedToolContext,
      {
        runCode: async () =>
          codeResult({
            ok: true,
            summary: 'advanced',
            state: { cursor: 3, filters: ['open'] },
            plannedMutations: [],
          }),
      },
    );

    expect(envelope(result)).toMatchObject({
      summary: 'advanced',
      content: [
        { kind: 'replay-state', values: { cursor: 3, filters: ['open'] } },
      ],
      accounting: { contentBytes: expect.any(Number) },
    });
    expect(envelope(result).accounting.contentBytes).toBeGreaterThan(0);
  });

  it('preserves explicitly returned image/audio blocks outside the JSON envelope', async () => {
    const image = {
      type: 'image' as const,
      data: 'aGVsbG8=',
      mimeType: 'image/png',
      _meta: { output_hint: 'preview' },
    };
    const result = await runServerScriptAdapter({ script: { source: 'return media;' } }, {} as UnifiedToolContext, {
      runCode: async () => codeResult({ ok: true, summary: 'rendered' }, [image]),
    });

    expect(envelope(result).summary).toBe('rendered');
    expect(result.content[1]).toEqual(image);
  });

  it('rejects background lifecycle before invoking code:run', async () => {
    const runCode = vi.fn<ServerScriptRunDeps['runCode']>();
    const result = await runServerScriptAdapter(
      {
        script: { source: 'return "no";' },
        execution: { lifecycle: 'background' },
      },
      {} as UnifiedToolContext,
      { runCode },
    );

    expect(runCode).not.toHaveBeenCalled();
    expect(envelope(result)).toMatchObject({
      state: 'error',
      error: { code: 'lifecycle_unavailable' },
      metrics: { phase: 'preflight', executed: false },
    });
  });

  it('admits a pinned durable script as one background DBOS run without invoking code:run', async () => {
    const script = { source: 'return "durable";' };
    const execution = { lifecycle: 'background' as const, durability: 'durable' as const };
    const ctx = {
      workspaceId: 'ws-durable',
      harnessSlug: 'papercusp',
      role: 'su',
      uiClientId: 'su-durable',
      idempotencyKey: 'request-1',
    } as UnifiedToolContext;
    const inspected = await inspectOrchestration({ script, execution }, ctx);
    const pin = ((inspected as ToolResult & { data?: unknown }).data as {
      normalized: { durability: { pin: { sourceSha256: string; bindingsSha256: string } } };
    }).normalized.durability.pin;
    const runCode = vi.fn<ServerScriptRunDeps['runCode']>();
    const startDurable = vi.fn().mockResolvedValue({
      workflowId: 'orchestrate-durable:ws-durable:run-1',
    });

    const result = await runOrchestration(
      { script, execution, inspectionPin: pin, timeoutSec: 120, workItemId: 'WI-1' },
      ctx,
      {
        server: {
          runCode,
          startDurable,
          durableRunKey: () => 'run-1',
        },
      },
    );

    expect(runCode).not.toHaveBeenCalled();
    expect(startDurable).toHaveBeenCalledWith({
      runKey: 'run-1',
      script: script.source,
      inputs: {},
      pin,
      caller: {
        ownerId: 'su-durable',
        workspaceId: 'ws-durable',
        harnessSlug: 'papercusp',
        role: 'su',
      },
      timeoutSec: 120,
      link: { workItemId: 'WI-1' },
    });
    const body = envelope(result);
    expect(body).toMatchObject({
      state: 'complete',
      metrics: { backend: 'dbos', lifecycle: 'background', durability: 'durable' },
    });
    expect(JSON.parse(body.summary)).toEqual({
      durableRun: { workflowId: 'orchestrate-durable:ws-durable:run-1', status: 'admitted' },
    });
  });

  it('refuses durable admission on runtime-owned nondeterminism before DBOS enqueue', async () => {
    const script = { source: 'return Date.now();' };
    const execution = { lifecycle: 'background' as const, durability: 'durable' as const };
    const ctx = {
      workspaceId: 'ws-durable', role: 'su', uiClientId: 'su-durable',
    } as UnifiedToolContext;
    const inspected = await inspectOrchestration({ script, execution }, ctx);
    const pin = ((inspected as ToolResult & { data?: unknown }).data as {
      normalized: { durability: { pin: { sourceSha256: string; bindingsSha256: string } } };
    }).normalized.durability.pin;
    const startDurable = vi.fn();

    const result = await runOrchestration(
      { script, execution, inspectionPin: pin },
      ctx,
      { server: { runCode: vi.fn(), startDurable } },
    );

    expect(startDurable).not.toHaveBeenCalled();
    expect(envelope(result)).toMatchObject({
      state: 'error',
      error: { code: 'durable_replay_unsafe', message: expect.stringContaining('wall-clock') },
      metrics: { phase: 'preflight', executed: false },
    });
  });

  it('routes durable cancel and signal controls through DBOS and scopes them to the workspace', async () => {
    const workflowId = 'orchestrate-durable:ws-durable:run-1';
    const durableControl = vi.fn().mockResolvedValue(undefined);
    const ctx = { workspaceId: 'ws-durable' } as UnifiedToolContext;

    const result = await runOrchestration(
      {
        durableControl: {
          workflowId,
          action: 'signal',
          topic: 'approved',
          message: { by: 'test' },
          idempotencyKey: 'signal-1',
        },
      },
      ctx,
      { durableControl },
    );

    expect(durableControl).toHaveBeenCalledWith({
      workflowId,
      action: 'signal',
      topic: 'approved',
      message: { by: 'test' },
      idempotencyKey: 'signal-1',
    });
    expect(JSON.parse(envelope(result).summary)).toEqual({
      durableControl: { workflowId, action: 'signal', accepted: true },
    });

    durableControl.mockClear();
    const denied = await runOrchestration(
      { durableControl: { workflowId: 'orchestrate-durable:other:run-1', action: 'cancel' } },
      ctx,
      { durableControl },
    );
    expect(durableControl).not.toHaveBeenCalled();
    expect(envelope(denied)).toMatchObject({ error: { code: 'capability_denied' } });
  });

  it('rejects an oversized authored summary without truncating or auto-summarizing it', async () => {
    const summary = 'x'.repeat(DEFAULT_OUTPUT_SUMMARY_BUDGET_CHARS + 1);
    const result = await runServerScriptAdapter({ script: { source: 'return tooLarge;' } }, {} as UnifiedToolContext, {
      runCode: async () => codeResult({ ok: true, summary }),
    });
    const body = envelope(result);

    expect(body).toMatchObject({
      summary: '',
      state: 'error',
      error: { code: 'summary_budget_exceeded' },
      metrics: { phase: 'execution', executed: true },
    });
    expect(JSON.stringify(body)).not.toContain(summary);
  });

  it('maps child failures to an explicit incomplete state', async () => {
    const result = await runServerScriptAdapter({ script: { source: 'return "partial";' } }, {} as UnifiedToolContext, {
      runCode: async () =>
        codeResult({
          ok: true,
          summary: 'partial',
          childFailures: [{ tool: 'x:y', kind: 'semantic' }],
        }),
    });

    expect(envelope(result)).toMatchObject({
      summary: 'partial',
      state: 'incomplete',
      incomplete: { reason: 'partial_execution' },
      metrics: { childFailureCount: 1 },
    });
  });

  it('replays an exact saved recipe through the canonical adapter and returns one envelope', async () => {
    const run = vi.fn().mockResolvedValue({
      ok: true,
      results: [{
        ok: true,
        id: 'triage-stale',
        result: {
          ok: true,
          summary: { triaged: 4 },
          dispatchCount: 2,
          intermediateBytes: 700,
          writeAttempts: [{ tool: 'work_items:set_state' }],
        },
      }],
      counts: { requested: 1, succeeded: 1, failed: 0 },
    });
    const adapter = { run } as unknown as SavedRecipeAdapter;

    const result = await runOrchestration(
      {
        recipe: { id: 'triage-stale', revision: 'a'.repeat(64) },
        execution: { mode: 'auto' },
        timeoutSec: 20,
      },
      {} as UnifiedToolContext,
      { recipes: adapter },
    );

    expect(run).toHaveBeenCalledWith({
      recipe: { id: 'triage-stale', revision: 'a'.repeat(64) },
      timeoutSec: 20,
    });
    expect(envelope(result)).toMatchObject({
      summary: '{"triaged":4}',
      state: 'complete',
      metrics: {
        backend: 'server',
        toolCalls: 3,
        intermediateBytes: 700,
        recipeReuse: true,
        recipeId: 'triage-stale',
        requestedExecutionMode: 'auto',
        executionMode: 'server',
        executionModeDeprecated: true,
        writeAttemptCount: 1,
      },
    });
  });

  it('preserves a saved-recipe preflight failure without executing a fallback', async () => {
    const run = vi.fn().mockResolvedValue({
      ok: false,
      phase: 'preflight',
      executed: false,
      error: {
        code: 'recipe_authority_stale',
        message: 'inspect/search again before running',
        path: 'recipe.revision',
      },
    });
    const result = await runOrchestration(
      { recipe: { id: 'stale', revision: 'b'.repeat(64) } },
      {} as UnifiedToolContext,
      { recipes: { run } as unknown as SavedRecipeAdapter },
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(envelope(result)).toMatchObject({
      state: 'error',
      error: { code: 'recipe_authority_stale' },
      metrics: { phase: 'preflight', executed: false },
    });
  });

  it('rejects both and neither source before any backend is selected', async () => {
    const run = vi.fn();
    const adapter = { run } as unknown as SavedRecipeAdapter;
    const both = await runOrchestration(
      { script: { source: 'return 1;' }, recipe: { id: 'also' } },
      {} as UnifiedToolContext,
      { recipes: adapter },
    );
    const neither = await runOrchestration(
      {},
      {} as UnifiedToolContext,
      { recipes: adapter },
    );

    expect(run).not.toHaveBeenCalled();
    expect(envelope(both)).toMatchObject({ state: 'error', error: { code: 'ambiguous_source' } });
    expect(envelope(neither)).toMatchObject({ state: 'error', error: { code: 'source_missing' } });
  });
});

/** WI-40720 gap 2 — outer-row telemetry on EVERY return path.
 *
 *  Only the script SUCCESS path used to stamp `ctx.metadata`. Preflight refusals, the saved-recipe
 *  path and both catch paths stamped nothing, so a refused, thrown, or recipe-driven
 *  orchestrate:run left no telemetry row — and the P-020 rollout gates therefore measured only the
 *  runs that worked. That is survivorship bias in the exact metric meant to detect regressions:
 *  the more often the door failed, the healthier its failure rate looked.
 *
 *  These assert on the STAMP (ctx.metadata), never on the returned envelope. Every path already
 *  filled envelope.metrics correctly, which is precisely why the gap was easy to miss by reading. */
describe('WI-40720 gap 2 — orchestrate:run stamps a telemetry row on every path, not just success', () => {
  const spyCtx = () => {
    const metadata = vi.fn();
    return { ctx: { metadata } as unknown as UnifiedToolContext, metadata };
  };
  const stamp = (metadata: ReturnType<typeof vi.fn>) =>
    (metadata.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;

  it('stamps a PREFLIGHT REFUSAL, which previously recorded nothing at all', async () => {
    const { ctx, metadata } = spyCtx();
    await runOrchestration(
      { script: { source: 'return "ok";' }, execution: { mode: 'client' } },
      ctx,
      { server: { runCode: vi.fn<ServerScriptRunDeps['runCode']>() } },
    );
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(stamp(metadata)).toMatchObject({
      backend: 'server',
      phase: 'preflight',
      executed: false,
      source: 'script',
      failureClass: 'execution_mode_unavailable',
    });
  });

  it('stamps a THROWN adapter — the row most certain to have been missing', async () => {
    const { ctx, metadata } = spyCtx();
    const runCode = vi.fn<ServerScriptRunDeps['runCode']>().mockRejectedValue(new Error('boom'));
    await runOrchestration({ script: { source: 'return "ok";' } }, ctx, { server: { runCode } });
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(stamp(metadata)).toMatchObject({
      phase: 'execution',
      executed: false,
      source: 'script',
      failureClass: 'server_adapter_failed',
    });
    // durationMs must be present and sane, not absent — the latency gate reads it.
    expect(typeof stamp(metadata).durationMs).toBe('number');
    expect(stamp(metadata).durationMs as number).toBeGreaterThanOrEqual(0);
  });

  it('stamps the SAVED-RECIPE path and tags it source:recipe, not source:script', async () => {
    const { ctx, metadata } = spyCtx();
    const run = vi.fn<SavedRecipeAdapter['run']>().mockRejectedValue(new Error('recipe exploded'));
    await runOrchestration({ recipe: { id: 'saved' } }, ctx, { recipes: { run } as unknown as SavedRecipeAdapter });
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(stamp(metadata)).toMatchObject({ source: 'recipe', executed: false, phase: 'execution' });
    // REGRESSION: recipeRequested must be set on a THROWN recipe too. An earlier draft set it
    // only on the success path, so failed recipe calls fell out of the denominator that reuse
    // is measured against — reuse rate would then IMPROVE as recipes broke more often.
    expect(stamp(metadata).recipeRequested).toBe(true);
  });

  it('counts a REFUSED recipe in the requested denominator as well', async () => {
    const { ctx, metadata } = spyCtx();
    const run = vi.fn<SavedRecipeAdapter['run']>().mockResolvedValue({
      ok: false,
      error: { code: 'recipe_not_found', message: 'no such recipe' },
    } as unknown as Awaited<ReturnType<SavedRecipeAdapter['run']>>);
    await runOrchestration({ recipe: { id: 'missing' } }, ctx, {
      recipes: { run } as unknown as SavedRecipeAdapter,
    });
    expect(stamp(metadata)).toMatchObject({ source: 'recipe', recipeRequested: true, executed: false });
  });

  it('carries the recipe SELECTOR on failure paths, not just on success', () => {
    // REGRESSION: recipeId/recipeRevision were stamped only where the recipe SUCCEEDED, so a
    // failing recipe could be counted but never IDENTIFIED — the telemetry would say recipes
    // are failing and be unable to say WHICH, which is the one thing you need to act. Both are
    // now derived from args for every recipe path.
    const cases: Array<{ label: string; run: ReturnType<typeof vi.fn> }> = [
      { label: 'thrown', run: vi.fn<SavedRecipeAdapter['run']>().mockRejectedValue(new Error('x')) },
      {
        label: 'refused',
        run: vi.fn<SavedRecipeAdapter['run']>().mockResolvedValue({
          ok: false,
          error: { code: 'recipe_not_found', message: 'gone' },
        } as unknown as Awaited<ReturnType<SavedRecipeAdapter['run']>>),
      },
    ];
    return Promise.all(
      cases.map(async ({ label, run }) => {
        const { ctx, metadata } = spyCtx();
        await runOrchestration({ recipe: { id: 'the-recipe', revision: '7' } }, ctx, {
          recipes: { run } as unknown as SavedRecipeAdapter,
        });
        expect(stamp(metadata), `${label} path lost the selector`).toMatchObject({
          source: 'recipe',
          recipeRequested: true,
          recipeId: 'the-recipe',
          recipeRevision: '7',
        });
      }),
    );
  });

  it('does NOT flag execution mode "auto" as a backend mismatch', async () => {
    // REGRESSION. backendMismatch is one of gap 4's HARD rollback triggers, and `auto` means
    // "server, you choose" — being served server-side is that request HONOURED. An earlier draft
    // computed `requested !== 'server'`, which would have fired the loudest alarm in the gate on
    // entirely correct behaviour, and on what is likely the most common mode.
    const { ctx, metadata } = spyCtx();
    const run = vi.fn<SavedRecipeAdapter['run']>().mockRejectedValue(new Error('x'));
    await runOrchestration({ recipe: { id: 'saved' }, execution: { mode: 'auto' } }, ctx, {
      recipes: { run } as unknown as SavedRecipeAdapter,
    });
    expect(stamp(metadata)).toMatchObject({ requestedExecutionMode: 'auto', backendMismatch: false });
  });

  it('DOES flag a genuinely non-server requested mode as a mismatch', async () => {
    // The falsifying counterpart: if backendMismatch were hardcoded false the test above would
    // pass while the trigger never fired at all.
    const { ctx, metadata } = spyCtx();
    await runOrchestration({ script: { source: 'return "ok";' }, execution: { mode: 'client' } }, ctx, {
      server: { runCode: vi.fn<ServerScriptRunDeps['runCode']>() },
    });
    expect(stamp(metadata)).toMatchObject({ requestedExecutionMode: 'client', backendMismatch: true });
  });

  it('omitting execution entirely defaults to server and is not a mismatch', async () => {
    const { ctx, metadata } = spyCtx();
    const run = vi.fn<SavedRecipeAdapter['run']>().mockRejectedValue(new Error('x'));
    await runOrchestration({ recipe: { id: 'saved' } }, ctx, { recipes: { run } as unknown as SavedRecipeAdapter });
    expect(stamp(metadata)).toMatchObject({ requestedExecutionMode: 'server', backendMismatch: false });
  });

  it('stamps a saved-recipe SUCCESS with the resolved recipe selector', async () => {
    // The success path was previously covered only by its catch sibling, which meant the
    // selector and reuse stamps were never exercised at all.
    const { ctx, metadata } = spyCtx();
    const run = vi.fn<SavedRecipeAdapter['run']>().mockResolvedValue({
      results: [{ ok: true, id: 'saved', result: { summary: 'done' } }],
    } as unknown as Awaited<ReturnType<SavedRecipeAdapter['run']>>);
    await runOrchestration({ recipe: { id: 'saved', revision: '3' } }, ctx, {
      recipes: { run } as unknown as SavedRecipeAdapter,
    });
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(stamp(metadata)).toMatchObject({
      source: 'recipe',
      phase: 'execution',
      executed: true,
      recipeRequested: true,
      recipeReuse: true,
      // REGRESSION: an earlier draft guarded this with `typeof args.recipe === 'string'`, which
      // can never be true for the public OBJECT selector — so recipeId was silently never
      // stamped, and saved-recipe reuse (a headline rollout metric) read as zero forever.
      recipeId: 'saved',
      recipeRevision: '3',
    });
  });

  it('derives phase/executed from the envelope — a recipe that never RAN is not stamped as executed', async () => {
    // REGRESSION: the recipe stamp used to hardcode phase:'execution', executed:true. An item
    // that failed in its own preflight builds a preflight/not-executed envelope, so hardcoding
    // recorded work that never happened — inflating the executed count and polluting the
    // latency sample, in the metric meant to detect exactly that kind of degradation.
    const { ctx, metadata } = spyCtx();
    const run = vi.fn<SavedRecipeAdapter['run']>().mockResolvedValue({
      results: [{ ok: false, phase: 'preflight', error: 'recipe_preflight_rejected', id: 'saved' }],
    } as unknown as Awaited<ReturnType<SavedRecipeAdapter['run']>>);
    await runOrchestration({ recipe: { id: 'saved' } }, ctx, { recipes: { run } as unknown as SavedRecipeAdapter });
    expect(stamp(metadata)).toMatchObject({ source: 'recipe', phase: 'preflight', executed: false });
  });

  it('stamps a recipes:run top-level refusal as a preflight row', async () => {
    const { ctx, metadata } = spyCtx();
    const run = vi.fn<SavedRecipeAdapter['run']>().mockResolvedValue({
      ok: false,
      error: { code: 'recipe_not_found', message: 'no such recipe' },
    } as unknown as Awaited<ReturnType<SavedRecipeAdapter['run']>>);
    await runOrchestration({ recipe: { id: 'missing' } }, ctx, { recipes: { run } as unknown as SavedRecipeAdapter });
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(stamp(metadata)).toMatchObject({
      source: 'recipe',
      phase: 'preflight',
      executed: false,
      failureClass: 'recipe_not_found',
    });
  });
});
