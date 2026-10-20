/**
 * recipes.test.ts — the recipes:* verbs (code-recipes-2026-06-21 Phase 2):
 *   1. registration: recipes:list/get/search/run self-register, role-gated.
 *   2. THE SECURITY INVARIANT (P-006 / D-004): recipes:run executes the recipe's
 *      script under the REUSER's role-scoped envelope (ctx.role), NEVER the
 *      author's — a recipe authored by an operator, run by a worker, can only
 *      touch worker-allowed tools. We assert the `allowed` set handed to
 *      runToolOrchestration is exactly roleScopedToolNames(all, ctx.role, …) and
 *      that an operator-only tool an operator-authored recipe could call is ABSENT
 *      when the reuser is a worker.
 *
 * No PG / embedder: getRecipe + recordRecipeRun + runToolOrchestration are mocked
 * so the test pins the role-scoping decision, not the orchestration internals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listAllProjectedTools, roleScopedToolNames } from '@papercusp/agent-mcp';
import {
  deriveRecipeAuthority,
  recipeRevision,
  recipeRevisionDiagnostics,
  validateRecipeAuthorityProof,
} from '../../recipe-authority';
import { FOREGROUND_TIMEOUT_CEILING_MS } from '../capability/foreground-transport-cap';
import { bindCurrentCallerDispatch } from '../orchestration/current-caller-dispatch';

// ── Mocks ────────────────────────────────────────────────────────────────────
// recipes:run lazy/eagerly imports these; replace so no PG/orchestration runs and
// we can capture the `allowed` set the handler builds for the facade.
const {
  listRecipesMock,
  getRecipeMock,
  reviseRecipeSourceMock,
  recordRecipeRunMock,
  runOrchestrationMock,
  normalizeExecutionTraceMock,
  normalizedTrace,
  orgSqlMock,
  resourceSqlMock,
  searchSimilarRecipesMock,
  buildQueryEmbedderResolvedMock,
  resolvePresenceFleetMock,
  NO_RUNTIME_OBSERVATIONS,
} = vi.hoisted(() => {
  // OrchestrateResult.runtimeObservations is REQUIRED on purpose, unlike every optional field
  // beside it: it carries independent runtime evidence (authorizationObservationCount,
  // authorityWideningDetected) that is never derived from the script's return value. A fixture
  // must therefore STATE "nothing was observed" rather than omit the field — an omitted value
  // reads as `undefined` → falsy → "no authority widening detected", which is exactly the
  // silent false-negative the required field exists to prevent. Defined INSIDE vi.hoisted (and
  // returned) because vi.hoisted is lifted above module scope: a module-level const referenced
  // from this factory would be a temporal-dead-zone ReferenceError at runtime.
  const NO_RUNTIME_OBSERVATIONS = {
    authorizationObservationCount: 0,
    authorityWideningDetected: false,
    midTurnPromptInjectionObservability: 'not-observable',
  } as const;
  const trace = {
    schemaVersion: 1 as const,
    backend: 'server' as const,
    requirements: { tools: [], capabilities: [], premises: ['host:same'] as ['host:same'] },
    toolGraph: { staticCalls: [], runtimeCalls: [] },
    stableBindings: [],
    ephemeralValues: [],
    redactedSecretPaths: [],
    portability: { host: 'same' as const, replayability: 'deterministic' as const, ephemeralKinds: [] },
    structuralFingerprint: 'b'.repeat(64),
  };
  return {
    listRecipesMock: vi.fn(),
    getRecipeMock: vi.fn(),
    reviseRecipeSourceMock: vi.fn(),
    recordRecipeRunMock: vi.fn(async () => {}),
    runOrchestrationMock: vi.fn<typeof import('@papercusp/agent-mcp').runToolOrchestration>(async () => ({
      ok: true,
      summary: { done: true },
      logs: [],
      dryRun: false,
      runtimeObservations: NO_RUNTIME_OBSERVATIONS,
      plannedMutations: [],
      callRecords: [],
    })),
    normalizeExecutionTraceMock: vi.fn(async () => trace),
    normalizedTrace: trace,
    orgSqlMock: vi.fn(),
    resourceSqlMock: vi.fn(),
    searchSimilarRecipesMock: vi.fn(async () => []),
    buildQueryEmbedderResolvedMock: vi.fn(async () => null),
    resolvePresenceFleetMock: vi.fn(async () => ({ fleetSlug: 'live-fleet', fleetRole: 'member' })),
    NO_RUNTIME_OBSERVATIONS,
  };
});

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: orgSqlMock }),
}));
vi.mock('../locks/su-lock-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTxPool: () => resourceSqlMock,
}));
vi.mock('../../code-recipes-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listRecipes: listRecipesMock,
  getRecipe: getRecipeMock,
  reviseRecipeSource: reviseRecipeSourceMock,
  recordRecipeRun: recordRecipeRunMock,
}));
vi.mock('../../code-recipes-search', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  searchSimilarRecipes: searchSimilarRecipesMock,
}));
vi.mock('../search/embedder', () => ({
  buildQueryEmbedderResolved: buildQueryEmbedderResolvedMock,
  interactiveEmbedAcquireBudgetMs: vi.fn(() => 0),
}));
vi.mock('../coordination/presence-fleet', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePresenceFleet: resolvePresenceFleetMock,
}));
vi.mock('../../orchestration-trace', () => ({
  normalizeExecutionTrace: normalizeExecutionTraceMock,
}));
vi.mock('../../hive-federation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  potHomeSlugForHarness: async () => 'alpha',
}));
vi.mock('../coordination/identity', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveAgentIdentity: () => ({ ownerId: 'owner-reuser' }),
}));
// Capture the orchestration options (we read `allowed` from them).
vi.mock('@papercusp/agent-mcp', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, runToolOrchestration: runOrchestrationMock };
});
// P-012: flag ON (the shipped default) — existing tests pass no ctx.metadata, so the
// mark is invisible to them; the dispatch-wrapper describe asserts it explicitly.
vi.mock('../../telemetry-dispatch-wrapper', () => ({
  dispatchWrapperMarkEnabled: vi.fn(async () => true),
}));

// Side-effect: register the recipes:* tools AFTER the mocks are hoisted.
import recipeListTool from './list';
import recipeGetTool from './get';
import recipeReviseTool from './revise';
import recipeSearchTool from './search';
import recipeRunTool from './run';
import './candidates';
import './merge';
import './sweep';
// The encoded-owner regression exercises the live condition reader through the
// recipe's caller-scoped catalog preflight.
import '../coordination/tools/conditions';
// Authority fixtures below execute work_items:get; register it so P-015's current-catalog
// preflight observes the same implementation that the production define-tool router loads.
import '../work_items/get';
// Output-schema preflight regression uses the live optional `gate` field contract.
import '../release/trace';
import '../storage/usage';

const findTool = (name: string) => {
  const t = listAllProjectedTools().find((x) => x.expose.mcp?.name === name);
  if (!t) throw new Error(`${name} not registered`);
  return t;
};

describe('recipes:* registration (P-005, P-013)', () => {
  it('lists public recipe metadata through the formatter without exposing stored source', async () => {
    const publicRecipe = {
      id: 'recipe-public', title: 'Reusable lookup', description: 'Read current evidence',
      toolsUsed: ['facts:list'], runCount: 3, successCount: 2,
      lastRunAt: '2026-10-06T00:00:00.000Z', status: 'active',
    };
    listRecipesMock.mockResolvedValueOnce([{ ...publicRecipe, script: 'private source', executionTrace: { private: true } }]);
    const result = await recipeListTool.handler({ limit: 7, includeTrivial: true } as never, {} as never);
    expect(listRecipesMock).toHaveBeenLastCalledWith(orgSqlMock, { limit: 7, includeTrivial: true });
    expect(result).toEqual({ data: { ok: true, count: 1, recipes: [publicRecipe] } });
    listRecipesMock.mockResolvedValueOnce([]);
    expect(await recipeListTool.handler({} as never, {} as never)).toEqual({ data: { ok: true, count: 0, recipes: [] } });
    expect(listRecipesMock).toHaveBeenLastCalledWith(orgSqlMock, { limit: 25, includeTrivial: false });
  });

  for (const name of ['recipes:list', 'recipes:get', 'recipes:search', 'recipes:run', 'recipes:candidates']) {
    it(`registers ${name} as a role-gated tool`, () => {
      const tool = findTool(name);
      expect(tool).toBeDefined();
      expect(tool.agentRoles?.length ?? 0).toBeGreaterThan(0);
      // bee is in the envelope (mirrors code:run's [...SU_ROLES,'cup'])
      expect(tool.agentRoles).toContain('cup');
    });
  }

  it('lets evidence-only callers discover and reuse recipes without a shell grant', () => {
    for (const name of ['recipes:list', 'recipes:get', 'recipes:search', 'recipes:run']) {
      const tool = findTool(name);
      expect(tool.capabilities, name).toEqual(['agent_tools:read']);
      expect(tool.capabilities, name).not.toContain('capability:bash');
      expect(tool.agentRoles, name).toContain('judge');
    }
    // The wrapper can orchestrate writes, but its own effect remains visible to
    // dry-run gates. Inner calls retain their separate capability checks.
    expect(findTool('recipes:run').effect).toBe('write');
  });

  it('rejects timeoutSec above the foreground ceiling for single and heterogeneous runs', () => {
    const maxTimeoutSec = FOREGROUND_TIMEOUT_CEILING_MS / 1000;
    expect(recipeRunTool.args.safeParse({ id: 'recipe-1', timeoutSec: maxTimeoutSec }).success).toBe(true);
    expect(recipeRunTool.args.safeParse({ id: 'recipe-1', timeoutSec: maxTimeoutSec + 1 }).success).toBe(false);
    expect(recipeRunTool.args.safeParse({ items: [{ id: 'recipe-1', timeoutSec: maxTimeoutSec }] }).success).toBe(true);
    expect(recipeRunTool.args.safeParse({ items: [{ id: 'recipe-1', timeoutSec: maxTimeoutSec + 1 }] }).success).toBe(false);
  });

  it('recipes:candidates is a READ-only graduation worklist (P-013 / D-017)', () => {
    const tool = findTool('recipes:candidates');
    expect(tool.effect).toBe('read');
    expect(tool.capabilities).toContain('recipes:read');
  });

  it('recipes:search accepts limits through 50 and rejects 51', () => {
    const limit = (recipeSearchTool.args as any).shape.limit;
    expect(limit.safeParse(40).success).toBe(true);
    expect(limit.safeParse(50).success).toBe(true);
    expect(limit.safeParse(51).success).toBe(false);
  });

  it('recipes:search accepts an explicit semantic:false lexical-only recovery request', () => {
    expect(recipeSearchTool.args.safeParse({ query: 'find a recovery recipe', semantic: false, limit: 5 }).success).toBe(true);
    expect(recipeSearchTool.args.safeParse({ query: 'find a recovery recipe', semantic: true, limit: 5 }).success).toBe(true);
  });

  it('recipes:get advertises its global scope and rejects harness scoping', () => {
    const tool = findTool('recipes:get');
    expect(tool.description).toContain('global/fleet-wide');
    expect(tool.guidance?.when).toContain('not `harness`');
    expect(tool.guidance?.chaining).toContain('omit `harness`');
    expect(tool.guidance?.argRedirects?.harness).toContain('global recipe read');
    expect(recipeGetTool.args.safeParse({ id: 'recipe-1', harness: 'papercusp' }).success).toBe(false);
  });

  // Phase 4 hygiene tools (P-010 / D-015): curation actions, SU-only (no bee), write-effect.
  for (const name of ['recipes:merge', 'recipes:sweep', 'recipes:revise']) {
    it(`registers ${name} as an SU-only write-effect curation tool`, () => {
      const tool = findTool(name);
      expect(tool).toBeDefined();
      expect(tool.agentRoles?.length ?? 0).toBeGreaterThan(0);
      // A review/curation action — NOT bee-authored (unlike recipes:run/get/list).
      expect(tool.agentRoles).not.toContain('cup');
      // Mutates the recipe corpus.
      expect(tool.effect).toBe('write');
      expect(tool.capabilities).toContain('intel:write');
    });
  }
});

describe('recipes:revise versioned contract updates', () => {
  it('accepts and atomically forwards an invocation-scoped binding contract', async () => {
    const current = {
      id: 'read-all-criterion-evidence-of-one-scorecard',
      title: 'Read all criterion evidence of one scorecard',
      description: 'read scorecard evidence',
      script: 'return 1;',
      bindingSchema: null,
      capabilityManifest: null,
      updatedAt: '2026-10-02T00:00:00.000Z',
      toolsUsed: [],
    };
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
      requirements: [],
      lifecycle: { allowed: ['foreground' as const], default: 'foreground' as const },
      replay: { class: 'read-only' as const },
      content: { emits: ['text' as const] },
    };
    const script = 'return 2;';
    const title = 'Evaluate exact spec-test bindings';
    const description = 'Evaluate every supplied current binding and emit canonical passing drafts.';
    getRecipeMock.mockResolvedValue(current);
    reviseRecipeSourceMock.mockResolvedValue({
      status: 'updated',
      row: {
        ...current,
        title,
        description,
        script,
        bindingSchema,
        capabilityManifest,
        updatedAt: '2026-10-02T00:01:00.000Z',
      },
    });
    const tool = recipeReviseTool;
    const args = {
      id: current.id,
      expectedRevision: recipeRevision(current.script, current.updatedAt, current),
      title,
      description,
      script,
      contract: { bindingSchema, capabilityManifest },
      reason: 'Make the scorecard recipe reusable per invocation.',
    };

    expect(tool.args.safeParse(args).success).toBe(true);
    await tool.handler(args, {
      log: () => {},
      workspaceId: 'ws-test',
      harnessSlug: 'alpha',
      role: 'operator',
      isSuperuser: false,
      uiClientId: 'revise-test',
    } as never);

    expect(reviseRecipeSourceMock).toHaveBeenCalledWith(orgSqlMock, {
      id: current.id,
      title,
      description,
      script,
      toolsUsed: [],
      contract: { bindingSchema, capabilityManifest },
      expectedUpdatedAt: current.updatedAt,
    });
  });

  it('rejects a binding schema without its capability manifest', () => {
    const tool = recipeReviseTool;
    expect(tool.args.safeParse({
      id: 'recipe',
      expectedRevision: 'a'.repeat(64),
      script: 'return 1;',
      contract: {
        bindingSchema: {
          version: 1,
          properties: {
            issueId: { type: 'string', required: true, lifetime: { kind: 'invocation-ephemeral' } },
          },
          additionalProperties: false,
        },
        capabilityManifest: null,
      },
      reason: 'Add a binding without its manifest.',
    }).success).toBe(false);
  });

  it('applies metadata-only revisions instead of treating them as no_change', async () => {
    const current = {
      id: 'generic-recipe',
      title: 'Old title',
      description: 'Old description',
      script: 'return 1;',
      bindingSchema: null,
      capabilityManifest: null,
      updatedAt: '2026-10-02T00:00:00.000Z',
      toolsUsed: [],
    };
    getRecipeMock.mockResolvedValue(current);
    reviseRecipeSourceMock.mockResolvedValue({
      status: 'updated',
      row: { ...current, description: 'Corrected description', updatedAt: '2026-10-02T00:01:00.000Z' },
    });
    const args = {
      id: current.id,
      expectedRevision: recipeRevision(current.script, current.updatedAt, current),
      script: current.script,
      description: 'Corrected description',
      reason: 'Correct the stale saved-recipe description.',
    };

    expect(recipeReviseTool.args.safeParse(args).success).toBe(true);
    await recipeReviseTool.handler(args, {
      log: () => {},
      workspaceId: 'ws-test',
      harnessSlug: 'papercusp',
      role: 'operator',
      isSuperuser: false,
      uiClientId: 'revise-metadata-test',
    } as never);

    expect(reviseRecipeSourceMock).toHaveBeenCalledWith(orgSqlMock, {
      id: current.id,
      description: 'Corrected description',
      script: current.script,
      toolsUsed: [],
      expectedUpdatedAt: current.updatedAt,
    });
  });
});

describe('recipes:run REUSE ENVELOPE invariant (P-006 / D-004)', () => {
  beforeEach(() => {
    getRecipeMock.mockReset();
    recordRecipeRunMock.mockClear();
    runOrchestrationMock.mockClear();
    normalizeExecutionTraceMock.mockClear();
    orgSqlMock.mockReset();
    resourceSqlMock.mockReset();
    searchSimilarRecipesMock.mockReset();
    searchSimilarRecipesMock.mockResolvedValue([]);
    buildQueryEmbedderResolvedMock.mockReset();
    buildQueryEmbedderResolvedMock.mockResolvedValue(null);
    resolvePresenceFleetMock.mockReset();
    resolvePresenceFleetMock.mockResolvedValue({ fleetSlug: 'live-fleet', fleetRole: 'member' });
    orgSqlMock.mockImplementation(async (parts: TemplateStringsArray) => {
      const query = parts.join(' ');
      if (query.includes('plan_item_claims')) return [];
      if (query.includes('harness_shared.work_items')) {
        return [{ harness_slug: 'alpha', item_id: 'WI-bound' }];
      }
      return [];
    });
    resourceSqlMock.mockResolvedValue([]);
  });

  const mkCtx = (role: string) =>
    ({
      log: () => {},
      workspaceId: 'ws-test',
      harnessSlug: 'alpha',
      role,
      isSuperuser: false,
      uiClientId: 'reuser-test',
    }) as never;

  it('builds search authority from live refs and ignores caller-bound context', async () => {
    orgSqlMock.mockImplementation(async (parts: TemplateStringsArray) => {
      const query = parts.join(' ');
      if (query.includes('plan_item_claims')) {
        return [{ plan_slug: 'live-plan', harness_slug: 'alpha', item_id: 'WI-live-claim' }];
      }
      if (query.includes('harness_shared.work_items')) {
        return [{ harness_slug: 'alpha', item_id: 'WI-live-item' }];
      }
      return [];
    });
    resourceSqlMock.mockResolvedValue([{ resource: 'resource-live' }]);

    await findTool('recipes:search').fn(
      {
        query: 'read the current lane',
        context: {
          fleet: 'spoof-fleet',
          plan: 'spoof-plan',
          harness: 'spoof-harness',
          items: ['WI-spoof'],
          resources: ['resource-spoof'],
        },
      },
      mkCtx('worker'),
    );

    expect(searchSimilarRecipesMock).toHaveBeenCalledTimes(1);
    const [, input] = searchSimilarRecipesMock.mock.calls[0] as unknown as [unknown, { recommendationContext: unknown }];
    expect(input.recommendationContext).toEqual({
      workspace: 'ws-test',
      fleet: 'live-fleet',
      harness: 'alpha',
      plan: 'live-plan',
      items: ['WI-live-claim', 'WI-live-item'],
      resources: ['resource-live'],
    });
  });

  it('fails closed for bound search authority when live refs cannot be measured', async () => {
    orgSqlMock.mockRejectedValue(new Error('live authority unavailable'));

    await findTool('recipes:search').fn(
      {
        query: 'read the current lane',
        context: {
          plan: 'spoof-plan',
          items: ['WI-spoof'],
          resources: ['resource-spoof'],
        },
      },
      mkCtx('worker'),
    );

    expect(searchSimilarRecipesMock).toHaveBeenCalledTimes(1);
    const [, input] = searchSimilarRecipesMock.mock.calls[0] as unknown as [unknown, { recommendationContext: unknown }];
    expect(input.recommendationContext).toEqual({
      workspace: 'ws-test',
      fleet: 'live-fleet',
      harness: 'alpha',
    });
  });

  it('skips embedder acquisition for explicit lexical-only recipe search', async () => {
    await findTool('recipes:search').fn(
      { query: 'recover the current lane', semantic: false, limit: 5 },
      mkCtx('worker'),
    );

    expect(buildQueryEmbedderResolvedMock).not.toHaveBeenCalled();
    expect(searchSimilarRecipesMock).toHaveBeenCalledTimes(1);
    const deps = (searchSimilarRecipesMock.mock.calls[0] as unknown as [unknown, unknown, { embedder?: unknown }])?.[2];
    expect(deps.embedder).toBeNull();
  });

  const emptyManifest = (requirements: string[] = []) => ({
    version: 1 as const,
    representation: 'recipe-script' as const,
    topology: { premises: ['host:same'] as ['host:same'] },
    requirements: requirements.map((capability) => ({ capability })),
    lifecycle: { allowed: ['foreground'] as ['foreground'], default: 'foreground' as const },
    replay: { class: 'read-only' as const },
    content: { emits: ['text'] as ['text'] },
  });

  it("runs the AUTHOR's recipe under the REUSER's role-scoped envelope, not the author's", async () => {
    // A recipe AUTHORED by an operator (privileged), referencing whatever tools.
    getRecipeMock.mockResolvedValue({
      id: 'r1',
      workspaceId: 'ws-test',
      potSlug: 'alpha',
      title: 'op recipe',
      description: 'authored by operator',
      script: 'return 1;',
      authorRole: 'operator', // ← the AUTHOR's role
      toolsUsed: [],
      runCount: 3,
      successCount: 3,
      status: 'active',
      tags: [],
    });

    // RUN it as a WORKER.
    await findTool('recipes:run').fn({ id: 'r1' }, mkCtx('worker'));

    expect(runOrchestrationMock).toHaveBeenCalledTimes(1);
    const [, opts] = runOrchestrationMock.mock.calls[0] as unknown as [
      string,
      { allowed: ReadonlySet<string>; tools: unknown[]; wrapDispatch?: unknown },
    ];
    const allowed = opts.allowed;

    // Saved replay and inline code:run enter the same current-caller dispatcher.
    expect(opts.wrapDispatch).toBe(bindCurrentCallerDispatch);

    // The allow-set must EQUAL the WORKER's role-scoped set (exclude code:run),
    // NOT the operator author's. Compute both reference sets from the real registry.
    const all = listAllProjectedTools();
    const workerSet = roleScopedToolNames(all, 'worker', new Set(['code:run']));
    const operatorSet = roleScopedToolNames(all, 'operator', new Set(['code:run']));

    // Same membership as the worker envelope.
    expect(allowed.size).toBe(workerSet.size);
    for (const n of workerSet) expect(allowed.has(n)).toBe(true);

    // And NOT the author's: any operator-only tool (in operatorSet, absent from
    // workerSet) must be ABSENT from the reuse envelope — no privilege escalation.
    const operatorOnly = [...operatorSet].filter((n) => !workerSet.has(n));
    expect(operatorOnly.length).toBeGreaterThan(0); // sanity: there IS a privilege gap to test
    for (const n of operatorOnly) expect(allowed.has(n)).toBe(false);

    // code:run is excluded (no recursive code-mode nesting).
    expect(allowed.has('code:run')).toBe(false);
  });

  it('gives storage:usage recipes enough time for the child read and preserves an explicit timeout', async () => {
    getRecipeMock.mockResolvedValue({
      id: 'storage-read',
      workspaceId: 'ws-test',
      potSlug: 'alpha',
      title: 'storage read',
      description: 'read storage categories',
      script: 'return tools.storage.usage({});',
      authorRole: 'operator',
      toolsUsed: ['storage:usage'],
      runCount: 0,
      successCount: 0,
      status: 'active',
      tags: [],
    });

    await findTool('recipes:run').fn({ id: 'storage-read' }, mkCtx('operator'));
    let [, options] = runOrchestrationMock.mock.calls.at(-1) as unknown as [
      string,
      { timeoutMs?: number },
    ];
    expect(options.timeoutMs).toBe(40_000);

    await findTool('recipes:run').fn({ id: 'storage-read', timeoutSec: 20 }, mkCtx('operator'));
    [, options] = runOrchestrationMock.mock.calls.at(-1) as unknown as [
      string,
      { timeoutMs?: number },
    ];
    expect(options.timeoutMs).toBe(20_000);
  });

  it('preflights typed bindings and passes only validated safe inputs into the VM', async () => {
    getRecipeMock.mockResolvedValue({
      id: 'bound-inputs',
      workspaceId: 'ws-test',
      potSlug: 'alpha',
      title: 't',
      description: 'd',
      script: 'return inputs.query;',
      authorRole: 'operator',
      toolsUsed: [],
      runCount: 0,
      successCount: 0,
      status: 'active',
      tags: [],
      bindingSchema: {
        version: 1,
        properties: {
          query: { type: 'string', required: true, lifetime: { kind: 'stable' } },
          token: {
            type: 'secret-ref',
            required: true,
            lifetime: { kind: 'resolved-ref', refKind: 'secret', resolution: 'each-use' },
          },
        },
        additionalProperties: false,
      },
      capabilityManifest: emptyManifest(),
    });

    const res = await findTool('recipes:run').fn(
      {
        id: 'bound-inputs',
        bindings: {
          values: {
            query: 'open queue',
            token: { secretRef: 'secret://github/pat' },
          },
        },
      },
      mkCtx('worker'),
    );
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);

    expect(payload.results[0]).toMatchObject({ ok: true, id: 'bound-inputs' });
    expect(runOrchestrationMock).toHaveBeenCalledTimes(1);
    const [, options] = runOrchestrationMock.mock.calls[0] as unknown as [string, { inputs: unknown }];
    expect(options.inputs).toEqual({ query: 'open queue' });
    expect(options.inputs).not.toHaveProperty('token');
  });

  it('returns typed binding preflight diagnostics without dispatching the script', async () => {
    getRecipeMock.mockResolvedValue({
      id: 'invalid-binding',
      workspaceId: 'ws-test',
      potSlug: 'alpha',
      title: 't',
      description: 'd',
      script: 'return inputs.count;',
      authorRole: 'operator',
      toolsUsed: [],
      runCount: 0,
      successCount: 0,
      status: 'active',
      tags: [],
      bindingSchema: {
        version: 1,
        properties: { count: { type: 'integer', required: true, lifetime: { kind: 'stable' } } },
        additionalProperties: false,
      },
      capabilityManifest: emptyManifest(),
    });

    const res = await findTool('recipes:run').fn(
      {
        id: 'invalid-binding',
        bindings: { values: { count: 'many' } },
      },
      mkCtx('worker'),
    );
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);

    expect(payload.results[0]).toMatchObject({
      ok: false,
      id: 'invalid-binding',
      phase: 'preflight',
      executed: false,
      error: 'binding_invalid',
      diagnostic: { code: 'binding_invalid', path: 'bindings.values.count' },
    });
    expect(runOrchestrationMock).not.toHaveBeenCalled();
  });

  it('fails unavailable declared capabilities in current-caller preflight before execution', async () => {
    getRecipeMock.mockResolvedValue({
      id: 'durable-unavailable',
      workspaceId: 'ws-test',
      potSlug: 'alpha',
      title: 't',
      description: 'd',
      script: 'return 1;',
      authorRole: 'operator',
      toolsUsed: [],
      runCount: 0,
      successCount: 0,
      status: 'active',
      tags: [],
      bindingSchema: null,
      capabilityManifest: emptyManifest(['tools:unavailable:recipe-tool']),
    });

    const res = await findTool('recipes:run').fn({ id: 'durable-unavailable' }, mkCtx('worker'));
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);

    expect(payload.results[0]).toMatchObject({
      ok: false,
      phase: 'preflight',
      executed: false,
      error: 'capability_unavailable',
      diagnostic: { capability: 'tools:unavailable:recipe-tool' },
    });
    expect(runOrchestrationMock).not.toHaveBeenCalled();
  });

  it('records the run with reused:true on a successful committing run', async () => {
    getRecipeMock.mockResolvedValue({
      id: 'r2',
      workspaceId: 'ws-test',
      potSlug: 'alpha',
      title: 't',
      description: 'd',
      script: 'return 1;',
      authorRole: 'operator',
      toolsUsed: [],
      runCount: 0,
      successCount: 0,
      status: 'active',
      tags: [],
    });
    await findTool('recipes:run').fn({ id: 'r2' }, mkCtx('worker'));
    expect(recordRecipeRunMock).toHaveBeenCalledTimes(1);
    const [, input] = recordRecipeRunMock.mock.calls[0] as unknown as [
      unknown,
      {
        reused: boolean;
        recipeId: string;
        agentRole: string;
        executionTrace: unknown;
        countTowardRecipe: boolean;
      },
    ];
    expect(input.reused).toBe(true);
    expect(input.recipeId).toBe('r2');
    expect(input.agentRole).toBe('worker'); // the REUSER's role, recorded
    expect(input.executionTrace).toBe(normalizedTrace);
    expect(input.countTowardRecipe).toBe(true);
  });

  it('records a dry-run trace without moving the parent recipe counters', async () => {
    getRecipeMock.mockResolvedValue({
      id: 'r3',
      workspaceId: 'ws-test',
      potSlug: 'alpha',
      title: 't',
      description: 'd',
      script: 'return 1;',
      authorRole: 'operator',
      toolsUsed: [],
      runCount: 0,
      successCount: 0,
      status: 'active',
      tags: [],
    });
    const res = await findTool('recipes:run').fn({ id: 'r3', dryRun: true }, mkCtx('worker'));
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(payload.results[0].result.callRecords).toBeUndefined();
    expect(recordRecipeRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        recipeId: 'r3',
        executionTrace: normalizedTrace,
        success: true,
        reused: true,
        countTowardRecipe: false,
      }),
    );
  });

  it('rejects a saved recipe whose literal arguments no longer match the live tool schema', async () => {
    getRecipeMock.mockResolvedValue({
      id: 'stale',
      workspaceId: 'ws-test',
      potSlug: 'alpha',
      title: 'stale',
      description: 'd',
      script: 'return await tools.recipes.list({ bogus: true });',
      authorRole: 'operator',
      toolsUsed: ['recipes:list'],
      runCount: 1,
      successCount: 1,
      status: 'active',
      tags: [],
    });
    const res = await findTool('recipes:run').fn({ id: 'stale' }, mkCtx('worker'));
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(payload.results[0]).toMatchObject({ ok: false, id: 'stale', error: 'recipe_schema_stale' });
    expect(payload.results[0].schemaIssues[0].message).toContain('bogus');
    expect(runOrchestrationMock).not.toHaveBeenCalled();
  });

  it('rejects a saved recipe reading an optional current result field before orchestration', async () => {
    const traceTool = findTool('release:trace');
    expect(traceTool.outputJsonSchema?.properties).toHaveProperty('gate');
    getRecipeMock.mockResolvedValue({
      id: 'stale-output',
      workspaceId: 'ws-test',
      potSlug: 'alpha',
      title: 'stale output field',
      description: 'd',
      script: 'const trace = await tools.release.trace({ path: "packages/example" });\nreturn trace.gate;',
      authorRole: 'operator',
      toolsUsed: ['release:trace'],
      runCount: 1,
      successCount: 1,
      status: 'active',
      tags: [],
    });

    const res = await findTool('recipes:run').fn({ id: 'stale-output' }, mkCtx('worker'));
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(payload.results[0]).toMatchObject({ ok: false, id: 'stale-output', error: 'recipe_schema_stale' });
    expect(payload.results[0].schemaIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'release:trace',
        path: 'result.gate',
        kind: 'output-field',
        message: expect.stringContaining('optional in the current output schema'),
      }),
    ]));
    expect(runOrchestrationMock).not.toHaveBeenCalled();
  });

  it('fails a recipe with stale field reads instead of recording a successful reuse', async () => {
    getRecipeMock.mockResolvedValue({
      id: 'field-miss',
      workspaceId: 'ws-test',
      potSlug: 'alpha',
      title: 'field miss',
      description: 'd',
      script: 'return 1;',
      authorRole: 'operator',
      toolsUsed: [],
      runCount: 1,
      successCount: 1,
      status: 'active',
      tags: [],
    });
    runOrchestrationMock.mockResolvedValueOnce({
      ok: true,
      summary: { done: true },
      logs: [],
      dryRun: false,
      runtimeObservations: NO_RUNTIME_OBSERVATIONS,
      plannedMutations: [],
      partial: false,
      fieldMisses: [
        {
          tool: 'scheduler:getNext',
          path: '(root)',
          read: 'windDown',
          available: ['workItem', 'claimedUnder'],
        },
      ],
    });

    const res = await findTool('recipes:run').fn({ id: 'field-miss' }, mkCtx('worker'));
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(payload.results[0]).toMatchObject({
      ok: false,
      id: 'field-miss',
      error: 'recipe_field_miss',
    });
    expect(payload.results[0].fieldMisses).toHaveLength(1);
    expect(recordRecipeRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        recipeId: 'field-miss',
        executionTrace: normalizedTrace,
        success: false,
        countTowardRecipe: false,
      }),
    );
  });

  it('returns not_found for a missing recipe per item (no orchestration) — bulk envelope', async () => {
    getRecipeMock.mockResolvedValue(null);
    const res = await findTool('recipes:run').fn({ id: 'nope' }, mkCtx('worker'));
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    // EI-23737206446729041: the envelope's `ok` is DERIVED from its items, so this single
    // per-item failure makes the TOP-LEVEL ok false as well. The per-item detail below is
    // unchanged — what the derivation buys is that a caller checking only the envelope can no
    // longer read a wholly-failed batch as success.
    expect(payload.ok).toBe(false);
    expect(payload.counts).toEqual({ ok: 0, failed: 1 });
    expect(payload.results[0]).toMatchObject({ ok: false, id: 'nope', error: 'not_found' });
    expect(runOrchestrationMock).not.toHaveBeenCalled();
  });

  it('ids:[…] runs MANY recipes; a missing one fails only itself (keyed by id)', async () => {
    getRecipeMock.mockImplementation(async (_sql: unknown, id: string) =>
      id === 'gone'
        ? null
        : {
            id,
            workspaceId: 'ws-test',
            potSlug: 'alpha',
            title: 't',
            description: 'd',
            script: 'return 1;',
            authorRole: 'operator',
            toolsUsed: [],
            runCount: 0,
            successCount: 0,
            status: 'active',
            tags: [],
          },
    );
    const res = await findTool('recipes:run').fn({ ids: ['r1', 'gone', 'r2'] }, mkCtx('worker'));
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    // EI-23737206446729041: per-item isolation is what this test proves and it is INTACT — r1 and
    // r2 still ran and still succeeded. The envelope's `ok` is now derived from the items, so the
    // one failure among them is also reported at the top level rather than being hidden there.
    expect(payload.ok).toBe(false);
    expect(payload.counts).toEqual({ ok: 2, failed: 1 });
    expect(payload.results.map((r: { id: string; ok: boolean }) => [r.id, r.ok])).toEqual([
      ['r1', true],
      ['gone', false],
      ['r2', true],
    ]);
    // The two present recipes were each orchestrated; the missing one was not.
    expect(runOrchestrationMock).toHaveBeenCalledTimes(2);
  });

  it('requires and revalidates authority for an entity-bound recipe (P-008)', async () => {
    const script = `return await tools.workItems.get({ id: 'WI-bound', harness: 'alpha' });`;
    const updatedAt = '2026-07-13T12:00:00.000Z';
    getRecipeMock.mockResolvedValue({
      id: 'bound',
      title: 'bound',
      description: 'd',
      script,
      updatedAt,
      authorRole: 'operator',
      toolsUsed: ['work_items:get'],
      runCount: 0,
      successCount: 0,
      status: 'active',
      tags: [],
    });

    const missing = await findTool('recipes:run').fn({ id: 'bound' }, mkCtx('worker'));
    const missingBody = JSON.parse((missing as { content: { text: string }[] }).content[0].text);
    expect(missingBody.results[0]).toMatchObject({ ok: false, id: 'bound', error: 'authority_required' });
    // EI-12057: `reason` is threaded through to the tool result so a caller (including one
    // hitting this via a NESTED tools.recipes.run(...) composition) can tell "get a proof
    // first" (fixable) apart from a permanent authority_unresolved (opaque script) failure.
    expect(missingBody.results[0].reason).toMatch(/recipes:search/);
    expect(runOrchestrationMock).not.toHaveBeenCalled();

    const authority = {
      version: 1,
      revision: recipeRevision(script, updatedAt),
      context: { harness: 'alpha', items: ['WI-bound'] },
    };
    const accepted = await findTool('recipes:run').fn({ id: 'bound', authority }, mkCtx('worker'));
    const acceptedBody = JSON.parse((accepted as { content: { text: string }[] }).content[0].text);
    expect(acceptedBody.results[0]).toMatchObject({ ok: true, id: 'bound' });
    expect(runOrchestrationMock).toHaveBeenCalledTimes(1);

    orgSqlMock.mockImplementation(async (parts: TemplateStringsArray) => {
      const query = parts.join(' ');
      if (query.includes('plan_item_claims')) return [];
      if (query.includes('harness_shared.work_items')) return [];
      return [];
    });
    const mismatched = await findTool('recipes:run').fn({ id: 'bound', authority }, mkCtx('worker'));
    const mismatchedBody = JSON.parse((mismatched as { content: { text: string }[] }).content[0].text);
    expect(mismatchedBody.results[0]).toMatchObject({ ok: false, error: 'authority_entity_mismatch' });

    const stale = await findTool('recipes:run').fn(
      {
        id: 'bound',
        authority: { ...authority, revision: '0'.repeat(64) },
      },
      mkCtx('worker'),
    );
    const staleBody = JSON.parse((stale as { content: { text: string }[] }).content[0].text);
    expect(staleBody.results[0]).toMatchObject({ ok: false, error: 'authority_stale_revision' });
    expect(staleBody.results[0].authorityDiagnostics).toMatchObject({
      version: 1,
      computedRevision: recipeRevision(script, updatedAt),
      suppliedRevision: '0'.repeat(64),
      updatedAt,
      inputFingerprints: {
        script: expect.stringMatching(/^[a-f0-9]{64}$/),
        bindingSchema: null,
        capabilityManifest: null,
      },
    });
    expect(JSON.stringify(staleBody.results[0].authorityDiagnostics)).not.toContain(script);
  });

  it('rejects a condition recipe that pins an owner UUID inside its encoded key', async () => {
    const script = `
      const r = await tools.coord.conditions({ include_resolved: false });
      const data = r && Array.isArray(r.open) ? r : JSON.parse(r.content?.[0]?.text ?? "{}");
      const key = "alarm:codex-rollout-provider:%5B%22papercusp-workspace%22%2C%2240336%22%2C%22su-e5f812b6-2f01-4cb8-8d23-3299e65fc494%22%5D";
      return { openCount: data.open_count ?? null, matches: (data.open ?? []).filter(x => x.condition_key === key) };
    `;
    const updatedAt = '2026-10-14T00:00:00.000Z';
    getRecipeMock.mockResolvedValue({
      id: 'read-codex-provider-condition',
      title: 'Read Codex provider condition',
      description: "Filter the live condition ledger to the admitted work-item's condition key.",
      script,
      updatedAt,
      authorRole: 'operator',
      toolsUsed: ['coord:conditions'],
      runCount: 0,
      successCount: 0,
      status: 'active',
      tags: [],
    });

    const result = await findTool('recipes:run').fn(
      { id: 'read-codex-provider-condition' },
      mkCtx('operator'),
    );
    const body = JSON.parse((result as { content: { text: string }[] }).content[0].text);

    expect(body.results[0]).toMatchObject({
      ok: false,
      id: 'read-codex-provider-condition',
      error: 'authority_unresolved',
    });
    expect(body.results[0].reason).toContain('concrete agent owner id');
    expect(runOrchestrationMock).not.toHaveBeenCalled();
  });

  it('accepts the authority metadata emitted by recipes:get and still revalidates the live lane', async () => {
    const script = `return await tools.workItems.get({ id: 'WI-bound', harness: 'alpha' });`;
    const updatedAt = '2026-07-13T12:00:00.000Z';
    getRecipeMock.mockResolvedValue({
      id: 'metadata-bound',
      title: 'bound',
      description: 'd',
      script,
      updatedAt,
      authorRole: 'operator',
      toolsUsed: ['work_items:get'],
      runCount: 0,
      successCount: 0,
      status: 'active',
      tags: [],
    });

    const metadata = {
      version: 1 as const,
      revision: recipeRevision(script, updatedAt),
      refs: (await deriveRecipeAuthority(script)).refs,
      requiresContext: true,
      runnable: true,
    };
    const schema = findTool('recipes:run').inputSchema as {
      properties?: { authority?: { anyOf?: Array<{ properties?: Record<string, unknown> }> } };
    };
    expect(schema.properties?.authority?.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            refs: expect.any(Object),
            requiresContext: expect.any(Object),
            runnable: expect.any(Object),
          }),
        }),
      ]),
    );

    const accepted = await findTool('recipes:run').fn({ id: 'metadata-bound', authority: metadata }, mkCtx('worker'));
    const acceptedBody = JSON.parse((accepted as { content: { text: string }[] }).content[0].text);
    expect(acceptedBody.results[0]).toMatchObject({ ok: true, id: 'metadata-bound' });
    expect(runOrchestrationMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a coordination recipe hardcodes sender or cursor arguments', async () => {
    const script = `return await tools.coord.inbox({
      from: 'su-stale-leader',
      since_ts: '2026-07-10T16:05:00.000Z',
    });`;
    const descriptor = await deriveRecipeAuthority(script);

    expect(descriptor.unresolved).toBe(true);
    expect(descriptor.unresolvedCause).toEqual({
      kind: 'volatile-coordination-args',
      tool: 'coord.inbox',
      keys: ['from', 'since_ts'],
    });

    const result = await validateRecipeAuthorityProof({
      script,
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('authority_unresolved');
      expect(result.reason).toContain('volatile coordination sender/cursor');
      expect(result.reason).toContain('since_ts');
    }
  });
});

describe('recipes:get HANDLER (bulk keyed-array)', () => {
  beforeEach(() => {
    getRecipeMock.mockReset();
  });

  const ctx = { workspaceId: 'ws-test' } as never;
  const getBody = async (args: unknown) => {
    const res = await findTool('recipes:get').fn(args as never, ctx);
    return JSON.parse((res as { content: { text: string }[] }).content[0].text);
  };

  it('inline { id } → one result with the recipe (script included)', async () => {
    const updatedAt = '2026-08-22T22:00:00.000Z';
    getRecipeMock.mockResolvedValue({
      id: 'r1',
      workspaceId: 'ws-test',
      potSlug: 'alpha',
      title: 't',
      description: 'd',
      script: 'return 1;',
      updatedAt,
      authorRole: 'operator',
      toolsUsed: [],
      runCount: 0,
      successCount: 0,
      lastRunAt: null,
      status: 'active',
      tags: [],
      bindingSchema: { version: 1, properties: {}, additionalProperties: false },
      capabilityManifest: {
        version: 1,
        representation: 'recipe-script',
        topology: { premises: ['host:same'] },
        requirements: [],
        lifecycle: { allowed: ['foreground'], default: 'foreground' },
        replay: { class: 'read-only' },
        content: { emits: ['text'] },
      },
    });
    const b = await getBody({ id: 'r1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({
      ok: true,
      id: 'r1',
      recipe: {
        id: 'r1',
        script: 'return 1;',
        bindingSchema: { version: 1, properties: {}, additionalProperties: false },
        capabilityManifest: { version: 1, representation: 'recipe-script' },
      },
    });
    expect(b.results[0].recipe.authorityDiagnostics).toEqual(recipeRevisionDiagnostics({
      script: 'return 1;',
      updatedAt,
      contract: {
        bindingSchema: { version: 1, properties: {}, additionalProperties: false },
        capabilityManifest: {
          version: 1,
          representation: 'recipe-script',
          topology: { premises: ['host:same'] },
          requirements: [],
          lifecycle: { allowed: ['foreground'], default: 'foreground' },
          replay: { class: 'read-only' },
          content: { emits: ['text'] },
        },
      },
    }));
    expect(JSON.stringify(b.results[0].recipe.authorityDiagnostics)).not.toContain('return 1;');
  });

  it('ids:[…] → many; a not-found id fails only itself', async () => {
    getRecipeMock.mockImplementation(async (_sql: unknown, id: string) =>
      id === 'x'
        ? null
        : {
            id,
            workspaceId: 'ws-test',
            potSlug: 'alpha',
            title: 't',
            description: 'd',
            script: 's',
            authorRole: 'operator',
            toolsUsed: [],
            runCount: 0,
            successCount: 0,
            lastRunAt: null,
            status: 'active',
            tags: [],
          },
    );
    const b = await getBody({ ids: ['r1', 'x', 'r2'] });
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'x', error: 'not_found' });
  });
});

/**
 * P-012 (census double-count): recipes:run marks its OWN telemetry row as a dispatch
 * wrapper when (and only when) the batch's scripts actually dispatched inner tools,
 * aggregating the count across items. The zero-dispatch case is the control: a
 * mark-by-tool-name implementation fails it.
 */
describe('recipes:run dispatch-wrapper mark (P-012)', () => {
  const RECIPE = {
    id: 'r1',
    workspaceId: 'ws-test',
    potSlug: 'alpha',
    title: 't',
    description: 'd',
    script: 'return 1;',
    authorRole: 'operator',
    toolsUsed: [],
    runCount: 0,
    successCount: 0,
    lastRunAt: null,
    status: 'active',
    tags: [],
  };
  const orchestration = (dispatchCount: number) => ({
    ok: true,
    summary: { done: true },
    logs: [],
    dryRun: false,
    runtimeObservations: NO_RUNTIME_OBSERVATIONS,
    plannedMutations: [],
    dispatchCount,
  });
  const mkCtx = (metadata: ReturnType<typeof vi.fn>) =>
    ({
      log: () => {},
      metadata,
      workspaceId: 'ws-test',
      harnessSlug: 'alpha',
      role: 'worker',
      isSuperuser: false,
      uiClientId: 'reuser-test',
    }) as never;

  it('aggregates inner dispatches across the batch and stamps one mark', async () => {
    getRecipeMock.mockImplementation(async (_sql: unknown, id: string) => ({ ...RECIPE, id }));
    runOrchestrationMock.mockResolvedValueOnce(orchestration(2)).mockResolvedValueOnce(orchestration(3));
    const metadata = vi.fn();
    await findTool('recipes:run').fn({ ids: ['r1', 'r2'] }, mkCtx(metadata));
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({ dispatchWrapper: true, dispatchedToolCalls: 5 }));
  });

  it('control: a zero-dispatch batch (and a legacy result with no dispatchCount) stamps nothing', async () => {
    getRecipeMock.mockImplementation(async (_sql: unknown, id: string) => ({ ...RECIPE, id }));
    runOrchestrationMock
      .mockResolvedValueOnce(orchestration(0))
      // legacy shape: dispatchCount absent entirely — must be read as 0, never guessed.
      // runtimeObservations is still stated: it is a REQUIRED field, so its absence would be a
      // type error rather than the "legacy" condition under test, which is specifically about
      // dispatchCount being optional.
      .mockResolvedValueOnce({
        ok: true,
        summary: {},
        logs: [],
        dryRun: false,
        runtimeObservations: NO_RUNTIME_OBSERVATIONS,
        plannedMutations: [],
      });
    const metadata = vi.fn();
    await findTool('recipes:run').fn({ ids: ['r1', 'r2'] }, mkCtx(metadata));
    expect(metadata).not.toHaveBeenCalled();
  });
});
