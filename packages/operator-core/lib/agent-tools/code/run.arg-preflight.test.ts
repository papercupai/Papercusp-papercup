/**
 * EI-19449316000499177: code:run pre-validates statically-known tool args BEFORE dispatch.
 *
 * The reported failure is ORDERING, not detection: code:run runs its calls in sequence, so an
 * argument the tool does not accept is caught at EXECUTION time — call #1 is rejected and every
 * later write is reported as `strandedWrites` and never runs, even though the offending key sat
 * literally in the script the whole time. So the load-bearing assertion in this file is not that
 * a message is produced; it is that `runToolOrchestration` is NEVER ENTERED. If it runs at all,
 * writes can strand, and the fix has not happened regardless of what the payload says.
 *
 * Lives apart from run.test.ts because the orchestrator is MOCKED here (vi.mock is file-global and
 * the sibling tests need the real one), and apart from recipe-schema-validation.test.ts because
 * that file proves the CLASSIFICATION against real schemas while this one proves the WIRING: given
 * a class, does code:run refuse or proceed. The split is deliberate — code:run fails closed on
 * `unknown-key` ONLY, and a validator that mislabels a class would otherwise turn into a false
 * refusal here with nothing to catch it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listAllProjectedTools } from '@papercusp/agent-mcp';

const { captureRecipeMock, recordRecipeRunMock } = vi.hoisted(() => ({
  captureRecipeMock: vi.fn(async () => null),
  recordRecipeRunMock: vi.fn<typeof import('../../code-recipes-store').recordRecipeRun>(async () => {}),
}));
vi.mock('./capture-recipe', () => ({
  captureRecipe: captureRecipeMock,
}));
vi.mock('../../code-recipes-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../code-recipes-store')>()),
  recordRecipeRun: recordRecipeRunMock,
}));
vi.mock('../../learning/pot-scope', () => ({ resolveLearningPotSlug: async () => 'alpha' }));
const { withWorkspaceMock, synthesizeDispatchPrincipalMock, runWithWorkspaceIfConcreteMock } = vi.hoisted(() => ({
  withWorkspaceMock: vi.fn(async (workspaceId: string, fn: (tx: unknown) => unknown) => fn({ __tx: workspaceId })),
  synthesizeDispatchPrincipalMock: vi.fn(async (tx: unknown, spawnCtx: { workspaceId: string; role: string }) => ({
    slug: `system:${spawnCtx.role}`,
    workspaceId: spawnCtx.workspaceId,
    capabilities: new Set<string>(),
    __tx: tx,
  })),
  runWithWorkspaceIfConcreteMock: vi.fn(async (_workspaceId: string | undefined, fn: () => unknown) => fn()),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: { __admin: true } }),
  withWorkspace: withWorkspaceMock,
}));
vi.mock('../../workspace-als', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runWithWorkspaceIfConcrete: runWithWorkspaceIfConcreteMock,
}));
vi.mock('../../endpoint-route/routes/transport/role-principal-caps', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  synthesizeDispatchPrincipal: synthesizeDispatchPrincipalMock,
}));
vi.mock('../search/embedder', () => ({
  buildQueryEmbedderResolved: async () => null,
  interactiveEmbedAcquireBudgetMs: () => 4000,
}));
vi.mock('../../hive-federation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  potHomeSlugForHarness: async () => 'alpha',
}));
vi.mock('../coordination/identity', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveAgentIdentity: () => ({ ownerId: 'owner-x' }),
}));

const { runToolOrchestrationMock } = vi.hoisted(() => ({
  runToolOrchestrationMock: vi.fn(),
}));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runToolOrchestration: runToolOrchestrationMock,
}));

// The validator itself is mocked so each ISSUE CLASS can be driven deterministically; its real
// behaviour against real schemas is proven in recipes/recipe-schema-validation.test.ts.
const { validateMock } = vi.hoisted(() => ({
  validateMock: vi.fn(),
}));
vi.mock('../recipes/recipe-schema-validation', () => ({
  validateRecipeScriptAgainstCatalog: validateMock,
}));

import './run'; // registers code:run (after the mocks are hoisted)
// Registers improvements:capture so the end-to-end predicate at the bottom can read its REAL
// published schema. Imported directly rather than via the registry barrel: the barrel drags in
// the whole catalog (and its mock surface) for one schema.
import '../improvements/capture';
import '../plans/set-status';
import '../work_items/claim';
import '../pre-prompt-registry-config';

const orchestration = (over: Record<string, unknown> = {}) => ({
  ok: true,
  summary: { done: true },
  logs: [],
  dryRun: false,
  plannedMutations: [],
  okFalseMutations: [],
  childFailures: [],
  partial: false,
  dispatchCount: 0,
  ...over,
});

const codeRun = () => {
  const tool = listAllProjectedTools().find((t) => t.expose.mcp?.name === 'code:run');
  if (!tool) throw new Error('code:run not registered');
  return tool;
};
const mkCtx = (metadata = vi.fn()) =>
  ({
    log: () => {},
    metadata,
    workspaceId: 'ws-test',
    harnessSlug: 'alpha',
    role: 'su',
    isSuperuser: true,
    uiClientId: 'su-test',
  }) as never;

const payloadOf = (result: unknown): Record<string, unknown> =>
  JSON.parse((result as { content: { text: string }[] }).content[0].text);

/** The item's first measured case, 2026-08-03. */
const UNKNOWN_KEY_ISSUE = {
  tool: 'improvements:capture',
  path: 'args',
  message: 'args.harness is not accepted by the current tool schema',
  kind: 'unknown-key' as const,
};

describe('code:run static arg preflight (EI-19449316000499177)', () => {
  beforeEach(() => {
    recordRecipeRunMock.mockClear();
    captureRecipeMock.mockClear();
    runToolOrchestrationMock.mockReset();
    runToolOrchestrationMock.mockResolvedValue(orchestration());
    validateMock.mockReset();
    validateMock.mockResolvedValue({ ok: true, issues: [], staticToolNames: [] });
  });

  it('normalizes registered positional work_items:claim rows before code:run preflight', async () => {
    const { validateRecipeScriptAgainstCatalog } = await vi.importActual<
      typeof import('../recipes/recipe-schema-validation')
    >('../recipes/recipe-schema-validation');
    validateMock.mockImplementation(validateRecipeScriptAgainstCatalog);

    const result = await codeRun().fn({
      script: 'return await tools.workItems.claim({ row: "EI-24779677812251161,,papercusp" });',
    }, mkCtx());

    expect(runToolOrchestrationMock).toHaveBeenCalledTimes(1);
    expect(payloadOf(result)).not.toMatchObject({ error: 'script_invalid' });
  });

  it('shares the response deadline with preflight instead of giving a slow preflight a fresh worker budget', async () => {
    const clock = vi.spyOn(Date, 'now');
    let now = 1_000_000;
    clock.mockImplementation(() => now);
    validateMock.mockImplementationOnce(async () => {
      now += 43_000;
      return { ok: true, issues: [], staticToolNames: [] };
    });
    runToolOrchestrationMock.mockResolvedValueOnce(orchestration({
      ok: false,
      error: 'script_timeout after 1000ms',
    }));
    try {
      const payload = payloadOf(await codeRun().fn({ script: 'return 1;', timeoutSec: 45 }, mkCtx()));
      expect(runToolOrchestrationMock).toHaveBeenCalledTimes(1);
      expect(runToolOrchestrationMock.mock.calls[0]?.[1]?.timeoutMs).toBeLessThanOrEqual(1_000);
      expect(payload.error).toContain('argument preflight used part of this call');
    } finally {
      clock.mockRestore();
    }
  });

  it('returns a typed no-dispatch timeout when preflight never settles', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateMock.mockImplementationOnce(() => new Promise(() => {}));
    try {
      const pending = codeRun().fn({ script: 'return 1;', timeoutSec: 45 }, mkCtx());
      await vi.advanceTimersByTimeAsync(44_000);
      const payload = payloadOf(await pending);
      expect(payload).toMatchObject({ ok: false, error: 'script_timeout during argument preflight', executed: false, dispatchCount: 0 });
      expect(runToolOrchestrationMock).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('argument preflight'));
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reports a thrown preflight error without calling it a timeout or dispatching', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateMock.mockRejectedValueOnce(new Error('catalog unavailable'));
    try {
      const payload = payloadOf(await codeRun().fn({ script: 'return 1;' }, mkCtx()));
      expect(payload).toMatchObject({
        ok: false,
        error: 'script_preflight_error: catalog unavailable',
        executed: false,
        dispatchCount: 0,
      });
      expect(runToolOrchestrationMock).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('catalog unavailable'));
    } finally {
      warning.mockRestore();
    }
  });

  it('an undeclared arg refuses the script BEFORE the orchestrator is entered — nothing can strand', async () => {
    validateMock.mockResolvedValueOnce({
      ok: false,
      issues: [UNKNOWN_KEY_ISSUE],
      staticToolNames: ['improvements:capture'],
    });
    const result = await codeRun().fn(
      { script: 'await tools.improvements.capture({ harness: "papercusp" }); await tools.plans.setNow({ slug: "s", body: "b" });' },
      mkCtx(),
    );
    // THE assertion this file exists for: the write path was never reached.
    expect(runToolOrchestrationMock).not.toHaveBeenCalled();
    const payload = payloadOf(result);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('script_invalid');
    expect(payload.executed).toBe(false);
    expect(payload.dispatchCount).toBe(0);
  });

  it('retains one preflight refusal receipt without inventing executed calls or popularity', async () => {
    validateMock.mockResolvedValueOnce({ ok: false, issues: [UNKNOWN_KEY_ISSUE], staticToolNames: [] });
    const script = 'return "refusé";';
    await codeRun().fn({ script }, { ...(mkCtx() as Record<string, unknown>), dispatchCallId: 'dispatch-refused-1' } as never);
    expect(runToolOrchestrationMock).not.toHaveBeenCalled();
    expect(captureRecipeMock).not.toHaveBeenCalled();
    expect(recordRecipeRunMock).toHaveBeenCalledTimes(1);
    expect(recordRecipeRunMock.mock.calls[0]?.[1]).toMatchObject({
      recipeId: null, success: false, countTowardRecipe: false,
      executionTrace: { toolGraph: { runtimeCalls: [] } },
      usage: { selection: 'authored', mode: 'commit', outcome: 'refused', settled: true },
      runEvidence: { invocationId: 'dispatch-refused-1', attempt: 0, executed: false,
        sourceBytes: Buffer.byteLength(script, 'utf8'), intermediateBytes: 0 },
    });
  });

  it.each([
    ['partial effects', { partial: true }, 'error', true],
    ['failed child', { childFailures: [{ tool: 'x:y', kind: 'semantic' }] }, 'error', true],
    ['missing returned field', { fieldMisses: [{ tool: 'x:y', read: 'missing', path: '$', available: [] }] }, 'error', true],
    ['detached child', { detachedCalls: [{ tool: 'x:y' }] }, 'unknown', false],
    ['in-flight child', { callRecords: [{ ordinal: 0, tool: 'x:y', effect: 'read', disposition: 'in_flight', outputReferences: [] }] }, 'unknown', false],
  ])('retains %s as an unsuccessful receipt with its settlement state', async (_label, extra, outcome, settled) => {
    runToolOrchestrationMock.mockResolvedValueOnce(orchestration(extra));
    await codeRun().fn({ script: 'return 1;' }, mkCtx());
    expect(captureRecipeMock).not.toHaveBeenCalled();
    expect(recordRecipeRunMock).toHaveBeenCalledTimes(1);
    expect(recordRecipeRunMock.mock.calls[0]?.[1]).toMatchObject({
      success: false, countTowardRecipe: false,
      usage: { selection: 'authored', outcome, settled },
      runEvidence: { executed: true },
    });
  });

  it('the refusal names the rejected arg and the accepted keys, so it is fixable in one edit', async () => {
    validateMock.mockResolvedValueOnce({
      ok: false,
      issues: [UNKNOWN_KEY_ISSUE],
      staticToolNames: ['improvements:capture'],
    });
    const payload = payloadOf(await codeRun().fn({ script: 'return 1;' }, mkCtx()));
    const refusals = (payload.argPreflight as { refusals: Record<string, unknown>[] }).refusals;
    expect(refusals).toHaveLength(1);
    expect(refusals[0].tool).toBe('improvements:capture');
    expect(refusals[0].rejectedArg).toBe('harness');
    // `accepts` is read off the live catalog; improvements:capture is a real registered tool, so
    // this is a real key list, not a fixture.
    expect(Array.isArray(refusals[0].accepts)).toBe(true);
    expect(String(payload.note)).toContain('NOTHING RAN');
  });

  it('a refused run is stamped as an error for telemetry, not left looking successful', async () => {
    validateMock.mockResolvedValueOnce({
      ok: false,
      issues: [UNKNOWN_KEY_ISSUE],
      staticToolNames: ['improvements:capture'],
    });
    const metadata = vi.fn();
    await codeRun().fn({ script: 'return 1;' }, mkCtx(metadata));
    expect(metadata).toHaveBeenCalledWith(
      expect.objectContaining({ effectiveStatus: 'error', codeRunArgPreflight: 'refused' }),
    );
  });

  // The three controls below are the false-positive guard. code:run is the fleet's
  // highest-traffic script tool, so a refusal it should not have made is more expensive than a
  // hint it failed to give.
  it('a `type` issue does NOT block — z.coerce may accept the literal at dispatch', async () => {
    validateMock.mockResolvedValueOnce({
      ok: false,
      issues: [{ tool: 'plans:revision-diff', path: 'args', message: 'args.revisionId must be a number', kind: 'type' }],
      staticToolNames: ['plans:revision-diff'],
    });
    await codeRun().fn({ script: 'return 1;' }, mkCtx());
    expect(runToolOrchestrationMock).toHaveBeenCalledTimes(1);
  });

  it('a `required` issue does NOT block — the dispatcher remains the authority on it', async () => {
    validateMock.mockResolvedValueOnce({
      ok: false,
      issues: [{ tool: 'release:deploy', path: 'args', message: 'args.op is required', kind: 'required' }],
      staticToolNames: ['release:deploy'],
    });
    await codeRun().fn({ script: 'return 1;' }, mkCtx());
    expect(runToolOrchestrationMock).toHaveBeenCalledTimes(1);
  });

  it('an UNCLASSIFIED issue (produced before the classification existed) does NOT block', async () => {
    validateMock.mockResolvedValueOnce({
      ok: false,
      issues: [{ tool: 'x:y', path: 'args', message: 'args.z is not accepted by the current tool schema' }],
      staticToolNames: ['x:y'],
    });
    await codeRun().fn({ script: 'return 1;' }, mkCtx());
    expect(runToolOrchestrationMock).toHaveBeenCalledTimes(1);
  });

  it('a clean script runs exactly as before', async () => {
    await codeRun().fn({ script: 'return 1;' }, mkCtx());
    expect(runToolOrchestrationMock).toHaveBeenCalledTimes(1);
  });

  // END-TO-END PREDICATE, against the LIVE registry rather than a fixture. Everything above
  // drives the classes through a mocked validator, so none of it can tell whether the item's
  // ACTUAL reported call is caught — that depends entirely on the real tool publishing
  // `additionalProperties:false`, which is the single fact the fail-closed branch rests on. A tool
  // that switched to .passthrough() would silently stop being covered with every test above still
  // green, so assert the predicate itself here.
  it('the tools in the reported cases still publish additionalProperties:false — the predicate fail-closed rests on', () => {
    const schemaOf = (name: string) =>
      listAllProjectedTools().find((t) => t.expose.mcp?.name === name)?.inputSchema as
        | { additionalProperties?: unknown; properties?: Record<string, unknown> }
        | undefined;

    for (const name of ['improvements:capture', 'plans:set-status']) {
      const schema = schemaOf(name);
      expect(schema, `${name} is not registered — its coverage cannot be checked`).toBeDefined();
      // The whole fail-closed branch is valid only while this is false. A tool that moved to
      // .passthrough() would silently drop out of coverage with every mocked test above still green.
      expect(schema?.additionalProperties, `${name} no longer rejects unknown keys`).toBe(false);
    }

    // The item's SECOND measured case (2026-08-03): `plans.setStatus({ itemId })` was rejected with
    // "Did you mean `item`", stranding the plans:set-now call behind it. Still live — so this is a
    // real end-to-end example of what now gets caught before dispatch instead of mid-script.
    const setStatusKeys = Object.keys(schemaOf('plans:set-status')?.properties ?? {});
    expect(setStatusKeys).not.toContain('itemId');
    expect(setStatusKeys).toContain('item');

    // The item's FIRST measured case is deliberately NOT asserted: `improvements:capture` has since
    // gained a real `harness` argument, so that exact call no longer fails at all. Recorded here so
    // a later reader does not re-derive it — the CLASS is what this change addresses, and it stays
    // live via the additionalProperties predicate above.
    expect(Object.keys(schemaOf('improvements:capture')?.properties ?? {})).toContain('harness');
  });
});
