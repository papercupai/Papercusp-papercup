import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import { encode } from '@papercusp/result-encoding';
import { applyResultDoor, beginResultDoorAggregate, resetResultDoorAggregatesForTests } from '../../result-door';
import { parseScratchReference } from '../../scratch-reference';
import { safeScratchFilesystemPath } from '../../scratch-uri';
import { FOREGROUND_TIMEOUT_CEILING_MS } from '../capability/foreground-transport-cap';

// ── Mocks for the CAPTURE wiring (code-recipes-2026-06-21 P-003) ─────────────
// maybeCaptureRecipe lazy-imports these; replace them so no PG / embedder /
// registry is touched and we can assert captureRecipe was invoked on success.
const {
  captureRecipeMock,
  recordRecipeRunMock,
  normalizeExecutionTraceMock,
  resolveLiveBoundRefsMock,
  resolvePresenceFleetMock,
  normalizedTrace,
} = vi.hoisted(() => {
  const trace = {
    schemaVersion: 1 as const,
    backend: 'server' as const,
    requirements: { tools: [], capabilities: [], premises: ['host:same'] as ['host:same'] },
    toolGraph: { staticCalls: [], runtimeCalls: [] },
    stableBindings: [],
    ephemeralValues: [],
    redactedSecretPaths: [],
    portability: { host: 'same' as const, replayability: 'deterministic' as const, ephemeralKinds: [] },
    structuralFingerprint: 'a'.repeat(64),
  };
  return {
    captureRecipeMock: vi.fn<typeof import('./capture-recipe').captureRecipe>(async () => null),
    recordRecipeRunMock: vi.fn(async () => {}),
    normalizeExecutionTraceMock: vi.fn(async () => trace),
    resolveLiveBoundRefsMock: vi.fn(async () => ({
      workspaces: [],
      fleets: [],
      plans: ['workspace-host-deferred-spend-reconciliation-2026-09-07'],
      harnesses: ['alpha'],
      items: ['WI-live'],
      resources: ['resource-live'],
    })),
    resolvePresenceFleetMock: vi.fn(async () => ({ fleetSlug: null, fleetRole: null })),
    normalizedTrace: trace,
  };
});
vi.mock('./capture-recipe', () => ({
  captureRecipe: captureRecipeMock,
}));
vi.mock('../../code-recipes-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordRecipeRun: recordRecipeRunMock,
}));
vi.mock('../../orchestration-trace', () => ({
  normalizeExecutionTrace: normalizeExecutionTraceMock,
}));
vi.mock('../../recipe-authority', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLiveBoundRefs: resolveLiveBoundRefsMock,
}));
vi.mock('../coordination/presence-fleet', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePresenceFleet: resolvePresenceFleetMock,
}));
vi.mock('../locks/su-lock-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTxPool: () => orgSqlMock,
}));
// ── Mocks for the WI-1411 per-inner-call rebinding wiring ────────────────────
// withWorkspace/synthesizeDispatchPrincipal/runWithWorkspaceIfConcrete would
// otherwise open a real PG transaction — replace them with spies so
// bindInnerDispatch's own branch logic (crossWorkspace / hop / fast-path) is
// what's under test, not a live database.
const {
  withWorkspaceMock,
  synthesizeDispatchPrincipalMock,
  runWithWorkspaceIfConcreteMock,
  orgSqlMock,
} = vi.hoisted(() => ({
  withWorkspaceMock: vi.fn(async (workspaceId: string, fn: (tx: unknown) => unknown) => fn({ __tx: workspaceId })),
  synthesizeDispatchPrincipalMock: vi.fn(async (tx: unknown, spawnCtx: { workspaceId: string; role: string }) => ({
    slug: `system:${spawnCtx.role}`,
    workspaceId: spawnCtx.workspaceId,
    capabilities: new Set<string>(),
    __tx: tx,
  })),
  runWithWorkspaceIfConcreteMock: vi.fn(async (_workspaceId: string | undefined, fn: () => unknown) => fn()),
  // fallback-observations uses the admin pool's Sql value as a callable tag.
  // Keep it local and inert so this suite cannot reach a real Postgres client.
  orgSqlMock: Object.assign(vi.fn(async () => []), { __admin: true }),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: orgSqlMock }),
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

import codeRunTool, {
  CODE_RUN_SUMMARY_CHAR_BUDGET,
  shapeCodeRunLogs,
  shapeCodeRunSummary,
  shapeMutationEcho,
  annotateChildFailureWarning,
  annotatePublicCodeRunStatus,
  bindInnerDispatch,
  buildFacadeHelp,
  FACADE_HELP_VERB_SIGNATURES,
  shapeCodeRunSimilarRecipes,
  shapeFieldMissHelp,
  isRecipeCaptureEligible,
  isRecipeCaptureAuthorityEligible,
  codeRunReturnedContextBytes,
  codeRunFailureClass,
  CODE_RUN_POSTPROCESSING_BUDGET_MS,
  codeRunPostprocessingDeadlineAtMs,
  withCodeRunCaptureMode,
  withCodeRunResponseBudget,
} from './run'; // named import ALSO runs the side-effect: registers code:run (AFTER the mocks are hoisted)
import { createPhaseTracker, type FieldMiss } from '@papercusp/tooldef';

beforeEach(() => {
  recordRecipeRunMock.mockClear();
  normalizeExecutionTraceMock.mockClear();
});

/**
 * B-CX-2A: the code:run tool registers into the projected registry, keeps its write-effect
 * (so it's itself dry-run-gateable), and is open to ALL roles (owner directive 2026-06-25 — the
 * facade stays role-scoped per inner call, so the grant is privilege-preserving). The outer
 * wrapper uses the read-only facade capability so evidence-only roles can orchestrate their
 * already-authorized reads without receiving the shell capability.
 */
describe('code:run registration (B-CX-2A)', () => {
  it('registers code:run as a write-effect tool open to every role', () => {
    const tool = listAllProjectedTools().find((t) => t.expose.mcp?.name === 'code:run');
    expect(tool).toBeDefined();
    expect(tool?.effect).toBe('write');
    expect(tool?.capabilities).toEqual(['agent_tools:read']);
    expect(tool?.capabilities).not.toContain('capability:bash');
    expect(tool?.needsWorkspaceTx).toBeFalsy();
    expect(tool?.agentRoles?.length ?? 0).toBeGreaterThan(0);
    // All-roles widening: roles excluded under the old [...SU_ROLES,'cup'] gate now qualify.
    for (const role of ['worker', 'cup', 'papercup', 'kettle', 'reviewer']) {
      expect(tool?.agentRoles).toContain(role);
    }
  });

  it.each([
    ['work_item_id', ['Default attribution for nested capability:bash', 'holding several items']],
    ['script', ['Plain JavaScript only', 'TypeScript annotations are unsupported']],
    ['script', ['Dynamic dispatch is `tools.tools.invoke({ name, args })`', 'recursive `code:run` and `orchestrate:run` calls are excluded']],
    ['script', ['Nested calls return typed result roots', '`output`, `exit_code`, `status`', '`rows`, `fields`, and `rowCount`']],
    ['script', ['timeoutSettledReadRecovery.calls', 'omittedReadCount', 'writes are never recovered']],
    ['script', ['preserve backslashes and `${...}` at each layer', 'a template literal or quoted heredoc', 'instead of interpolating it into a shell string']],
    ['script', ['Use fixed-string search or separate `-e` patterns']],
  ])('preserves the concise %s discovery contract: %j', (field, required) => {
    const tool = listAllProjectedTools().find((candidate) => candidate.expose.mcp?.name === 'code:run');
    const schema = tool?.inputSchema as { properties?: Record<string, { description?: string }> } | undefined;
    const description = schema?.properties?.[field as string]?.description ?? '';
    for (const fragment of required as string[]) expect(description).toContain(fragment);
  });
  it('lets malformed shell text reach the VM compile error instead of static arg preflight', async () => {
    const tool = listAllProjectedTools().find((candidate) => candidate.expose.mcp?.name === 'code:run');
    if (!tool) throw new Error('code:run not registered');
    const res = await tool.fn(
      {
        script: String.raw`const r = await tools.capability.bash({
          command: "head -n 12 /tmp/x.log | awk '{print NR ":" substr($0,1,600)}' ; tail -n 18 /tmp/x.log | awk '{print NR ":" substr($0,1,600)}'",
          cwd: "/tmp",
          description: "Sample checkpoint log markers",
          timeout: 15000
        });
        return { output: (r?.output || "").slice(-12000) };`,
      },
      {
        log: () => {},
        workspaceId: 'ws-test',
        harnessSlug: 'alpha',
        role: 'su',
        isSuperuser: true,
        uiClientId: 'su-test',
      } as never,
    );
    const payload = JSON.parse(String((res as { content: { text: string }[] }).content[0].text));
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/^compile_error:/);
    expect(payload.argPreflight).toBeUndefined();
  });

  it('accepts a quote-safe inline Python -c command as valid JavaScript', async () => {
    const tool = listAllProjectedTools().find((candidate) => candidate.expose.mcp?.name === 'code:run');
    if (!tool) throw new Error('code:run not registered');
    const script =
      "const command = String.raw`journalctl -u app.service | python3 -c 'import sys; print(\"ts\", sys.stdin.readline().strip())'`;\n" +
      'return { command };';
    const res = await tool.fn(
      { script },
      {
        log: () => {},
        workspaceId: 'ws-test',
        harnessSlug: 'alpha',
        role: 'su',
        isSuperuser: true,
        uiClientId: 'su-test',
      } as never,
    );
    const payload = JSON.parse(String((res as { content: { text: string }[] }).content[0].text));
    expect(payload.ok).toBe(true);
    expect(payload.summary).toEqual({
      command: `journalctl -u app.service | python3 -c 'import sys; print("ts", sys.stdin.readline().strip())'`,
    });
  });

  it('documents colon-only namespace conversion and preserves underscores within segments', () => {
    const tool = listAllProjectedTools().find((t) => t.expose.mcp?.name === 'code:run');
    const description = tool?.description ?? '';

    expect(description).toContain('only the namespace/verb separator `:` becomes `.`');
    expect(description).toContain('while `_` stays inside each segment');
    expect(description).toContain('work_items:get → tools.work_items.get or tools.workItems.get');
    expect(description).not.toContain('`:`/`_` → `.`');
  });

  it('documents the explicit final-media return contract', () => {
    const tool = listAllProjectedTools().find((t) => t.expose.mcp?.name === 'code:run');
    const scriptDescription =
      (tool?.inputSchema as { properties?: { script?: { description?: string } } })?.properties?.script?.description ??
      '';
    // code:run is a FLOOR tool with almost no seat headroom, so its script description is the
    // compact form: pin the contract tokens it still carries, not the earlier long-form prose.
    // The helper signatures and the state_limit_exceeded refusal are pinned behaviourally below.
    expect(scriptDescription).toContain('{ summary, media:');
    expect(scriptDescription).toContain('"image"|"audio"');
    expect(scriptDescription).toContain('`generatedImage` appends validated media');
    expect(scriptDescription).toContain('`notify` and `yield_control` stream output');
    expect(scriptDescription).toContain('`store`/`load` with explicit `inputs`');
    expect(scriptDescription).toContain('200 keys and 64 KiB');
    expect(scriptDescription).toContain('reduce large reads with `projection.pick`');
    expect(scriptDescription).toContain("payloadTier:'full'");
    expect(scriptDescription).toContain('summaryNotice.rawSummaryCursor');
    expect(scriptDescription).toContain('capability:read');
    expect(scriptDescription).toContain('bounded slices');
  });

  it('accepts explicit replay inputs and seeds the stateless sandbox', async () => {
    const tool = listAllProjectedTools().find((candidate) => candidate.expose.mcp?.name === 'code:run');
    if (!tool) throw new Error('code:run not registered');
    const inputsDescription =
      (tool.inputSchema as { properties?: { inputs?: { description?: string } } }).properties?.inputs?.description ?? '';
    expect(inputsDescription).toContain('deeply frozen');
    expect(inputsDescription).toContain('Clone nested values before mutation');
    expect(inputsDescription).toContain('use store/load for state the script updates');
    const args = { script: 'return { cursor: inputs.cursor, label: inputs.label };', inputs: { cursor: 7, label: 'resume' } };
    expect(codeRunTool.args.safeParse(args).success).toBe(true);
    const res = await tool.fn(args, {
      log: () => {},
      workspaceId: 'ws-test',
      harnessSlug: 'alpha',
      role: 'su',
      isSuperuser: true,
      uiClientId: 'su-test',
    } as never);
    const payload = JSON.parse(String((res as { content: { text: string }[] }).content[0].text));
    expect(payload.ok).toBe(true);
    expect(payload.summary).toEqual({ cursor: 7, label: 'resume' });
  });
});

describe('code:run → explicit final media (P-027 / D-021)', () => {
  const codeRun = () => {
    const tool = listAllProjectedTools().find((t) => t.expose.mcp?.name === 'code:run');
    if (!tool) throw new Error('code:run not registered');
    return tool;
  };
  const mkCtx = () =>
    ({
      log: () => {},
      workspaceId: 'ws-test',
      harnessSlug: 'alpha',
      role: 'su',
      isSuperuser: true,
      uiClientId: 'su-test',
    }) as never;

  beforeEach(() => {
    captureRecipeMock.mockClear();
    resetResultDoorAggregatesForTests();
  });

  it('preserves summary JSON once and appends validated image/audio content items', async () => {
    const res = (await codeRun().fn(
      {
        script: `return {
          summary: { rendered: 2, kept: true },
          media: [
            { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            { type: 'audio', data: 'd29ybGQ=', mimeType: 'audio/mpeg' }
          ]
        };`,
      },
      mkCtx(),
    )) as unknown as { content: Array<Record<string, unknown>> };

    expect(res.content).toEqual([
      expect.objectContaining({ type: 'text' }),
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      { type: 'audio', data: 'd29ybGQ=', mimeType: 'audio/mpeg' },
    ]);
    const payload = JSON.parse(String(res.content[0].text));
    expect(payload.summary).toEqual({ rendered: 2, kept: true });
    expect(payload.media).toBeUndefined();
    expect(String(res.content[0].text)).not.toContain('aGVsbG8=');
  });

  it('appends generatedImage output with validated hint metadata and keeps replay state explicit', async () => {
    const res = (await codeRun().fn(
      {
        script:
          `store('cursor', 2); ` +
          `generatedImage({ image_url: 'data:image/png;base64,aGVsbG8=', output_hint: 'preview' }); ` +
          `return { rendered: true };`,
      },
      mkCtx(),
    )) as unknown as { content: Array<Record<string, unknown>> };

    expect(res.content).toEqual([
      expect.objectContaining({ type: 'text' }),
      {
        type: 'image',
        data: 'aGVsbG8=',
        mimeType: 'image/png',
        _meta: { output_hint: 'preview' },
      },
    ]);
    const payload = JSON.parse(String(res.content[0].text));
    expect(payload.summary).toEqual({ rendered: true });
    expect(payload.state).toEqual({ cursor: 2 });
    expect(String(res.content[0].text)).not.toContain('aGVsbG8=');
  });

  it('refuses replay state past its key and byte caps with state_limit_exceeded instead of truncating it', async () => {
    for (const script of [
      `for (let i = 0; i < 201; i++) store('k' + i, i); return { stored: true };`,
      `store('big', 'x'.repeat(70000)); return { stored: true };`,
    ]) {
      const res = await codeRun().fn({ script }, mkCtx());
      const payload = JSON.parse(String((res as { content: { text: string }[] }).content[0].text));
      expect(payload.ok).toBe(false);
      expect(String(payload.error)).toContain('state_limit_exceeded');
      expect(payload.summary).toBeUndefined();
    }
  });

  it('keeps a small script return visible when store replay state exceeds the result door', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'papercusp-code-run-result-door-'));
    const previousScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
    process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
    try {
      const res = (await codeRun().fn(
        {
          script:
            `store('full', { rows: Array.from({ length: 12 }, (_, index) => String(index).padEnd(600, 'x')) }); ` +
            `return { marker: 'small-script-return', count: 3 };`,
        },
        mkCtx(),
      )) as unknown as Parameters<typeof applyResultDoor>[0];
      const source = JSON.parse(String(res.content[0].text)) as {
        state?: { full?: { rows?: string[] } };
      };
      expect(source.state?.full?.rows).toHaveLength(12);
      expect(source.state?.full?.rows?.every((row) => row.length === 600)).toBe(true);
      const genericDoor = applyResultDoor(res, {
        toolName: 'diagnostic:get',
        workspaceId: 'ws-test',
        runId: '99999999-3333-4333-8444-555555555555',
      });
      expect(JSON.parse(String(genericDoor.content[0].text)).summary).toBeUndefined();
      const doored = applyResultDoor(res, {
        toolName: 'code:run',
        workspaceId: 'ws-test',
        runId: '99999999-2222-4333-8444-555555555555',
      });
      const payload = JSON.parse(String(doored.content[0].text)) as {
        summary?: { marker?: string; count?: number };
        _projection?: { truncated?: boolean };
      };

      expect(payload.summary).toEqual({ marker: 'small-script-return', count: 3 });
      expect(payload._projection?.truncated).toBe(true);
      expect(doored._meta?.resultDoor).toMatchObject({ truncated: true, spillUri: expect.any(String) });
    } finally {
      if (previousScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
      else process.env.PAPERCUSP_SCRATCH_ROOT = previousScratchRoot;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('rejects invalid final media without placing a non-text item on the wire', async () => {
    const res = (await codeRun().fn(
      {
        script:
          `return { summary: { kept: true }, ` +
          `media: [{ type: 'audio', data: 'not base64!', mimeType: 'audio/mpeg' }] };`,
      },
      mkCtx(),
    )) as unknown as { content: Array<Record<string, unknown>> };

    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    const payload = JSON.parse(String(res.content[0].text));
    expect(payload.ok).toBe(false);
    expect(payload.summary).toEqual({ kept: true });
    expect(payload.error).toContain('invalid_media_result');
  });

  it('counts emitted media bytes toward the shared aggregate budget and spills on exhaustion', async () => {
    const res = (await codeRun().fn(
      {
        script:
          `return { summary: { rendered: true }, ` +
          `media: [{ type: 'image', data: 'YWFh'.repeat(1250), mimeType: 'image/png' }] };`,
      },
      mkCtx(),
    )) as unknown as Parameters<typeof applyResultDoor>[0];
    const aggregateScope = beginResultDoorAggregate({
      sessionKey: 'p027-media-accounting',
      outputGroupId: 'turn-1',
    });

    let doored = res;
    for (let index = 0; index < 20; index += 1) {
      doored = applyResultDoor(res, {
        toolName: 'code:run',
        workspaceId: 'ws-test',
        ownerId: 'owner-x',
        aggregateScope,
      });
      const aggregate = (
        doored._meta as
          | {
              resultDoor?: { aggregate?: { exceeded?: boolean; sourceBytes?: number } };
            }
          | undefined
      )?.resultDoor?.aggregate;
      if (aggregate?.exceeded) break;
    }

    const resultDoor = (
      doored._meta as
        | {
            resultDoor?: {
              reason?: string;
              nonTextBytes?: number;
              aggregate?: { exceeded?: boolean; sourceBytes?: number };
            };
          }
        | undefined
    )?.resultDoor;
    expect(resultDoor?.reason).toBe('aggregate-output-budget-exceeded');
    expect(resultDoor?.aggregate?.exceeded).toBe(true);
    expect(resultDoor?.nonTextBytes).toBe(5_000);
    expect(resultDoor?.aggregate?.sourceBytes).toBeGreaterThan(5_000);
    expect(doored.content).toHaveLength(1);
    expect(doored.content[0]?.type).toBe('text');
  });
});

/**
 * code-recipes-2026-06-21 P-003: a SUCCESSFUL, non-dry-run code:run captures the
 * script as a reusable recipe; a dry-run preview does NOT.
 */
describe('code:run → recipe capture (P-003)', () => {
  const codeRun = () => {
    const tool = listAllProjectedTools().find((t) => t.expose.mcp?.name === 'code:run');
    if (!tool) throw new Error('code:run not registered');
    return tool;
  };
  const mkCtx = () =>
    ({
      log: () => {},
      // minimal spawn-context identity the capture path reads
      workspaceId: 'ws-test',
      harnessSlug: 'alpha',
      role: 'su',
      isSuperuser: true,
      uiClientId: 'su-test',
    }) as never;

  beforeEach(() => {
    captureRecipeMock.mockClear();
  });

  it('captures a recipe after a successful run', async () => {
    const tool = codeRun();
    const res = await tool.fn({ script: 'return 1 + 1;', title: 'add', description: 'adds' }, mkCtx());
    // the tool returns the orchestration result as JSON text
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(payload.ok).toBe(true);

    expect(captureRecipeMock).toHaveBeenCalledTimes(1);
    const [, input] = captureRecipeMock.mock.calls[0] as unknown as [
      unknown,
      { script: string; workspaceId: string; title?: string; executionTrace?: unknown; recommendationContext?: unknown },
    ];
    expect(input.script).toBe('return 1 + 1;');
    expect(input.workspaceId).toBe('ws-test');
    expect(input.title).toBe('add');
    expect(input.executionTrace).toBe(normalizedTrace);
    expect(input.recommendationContext).toEqual({
      workspace: 'ws-test',
      harness: 'alpha',
      plan: 'workspace-host-deferred-spend-reconciliation-2026-09-07',
      items: ['WI-live'],
      resources: ['resource-live'],
    });
    expect(payload.callRecords).toBeUndefined();
  });

  it('does NOT capture on a dry-run preview, but records one trace-only execution', async () => {
    const tool = codeRun();
    await tool.fn({ script: 'return 1;', dryRun: true }, mkCtx());
    expect(captureRecipeMock).not.toHaveBeenCalled();
    expect(recordRecipeRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        recipeId: null,
        executionTrace: normalizedTrace,
        success: true,
        countTowardRecipe: false,
      }),
    );
  });

  it('honors the internal capture-mode override without changing the public args', async () => {
    const tool = codeRun();
    await tool.fn({ script: 'return 1;' }, withCodeRunCaptureMode(mkCtx(), 'never') as never);
    expect(captureRecipeMock).not.toHaveBeenCalled();
  });

  it('does NOT capture when the run fails, but records the failed trace-only execution', async () => {
    const tool = codeRun();
    const res = await tool.fn({ script: 'throw new Error("boom");' }, mkCtx());
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.callRecords).toBeUndefined();
    expect(captureRecipeMock).not.toHaveBeenCalled();
    expect(recordRecipeRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recipeId: null, executionTrace: normalizedTrace, success: false }),
    );
  });

  describe('capture eligibility for nested child failures', () => {
    const read = { effect: 'read', expose: { mcp: { name: 'dev:pg-query' } } };
    const write = { effect: 'write', expose: { mcp: { name: 'work_items:set_state' } } };

    it('allows a semantic read diagnostic while the script completed', () => {
      expect(
        isRecipeCaptureEligible(
          {
            ok: true,
            childFailures: [{ tool: 'dev:pg-query', kind: 'semantic' }],
          },
          [read, write],
        ),
      ).toBe(true);
    });

    it('rejects a semantic write failure, a thrown child, and an unknown reference', () => {
      expect(
        isRecipeCaptureEligible({ ok: true, childFailures: [{ tool: 'work_items:set_state', kind: 'semantic' }] }, [
          read,
          write,
        ]),
      ).toBe(false);
      expect(
        isRecipeCaptureEligible({ ok: false, childFailures: [{ tool: 'dev:pg-query', kind: 'uncertain' }] }, [
          read,
          write,
        ]),
      ).toBe(false);
      expect(
        isRecipeCaptureEligible({ ok: true, unknownRefs: ['nope.doStuff'], childFailures: [] }, [read, write]),
      ).toBe(false);
    });
  });

  describe('WI-40896 fault 2: capture must not certify what recipes:run permanently refuses', () => {
    // recipes:run rejects these with authority_unresolved on EVERY invocation, and
    // that refusal is documented as permanent — no proof can ever satisfy it.
    const opaqueScript = `await tools.dev.pg_query({ sql: 'SELECT 1' });`;
    const dynamicDispatchScript = `await tools.tools.invoke({ name: chosenVerb, args: {} });`;
    const resolvableScript = `return await tools.plans.list({});`;

    it('refuses capture for a script whose authority can never be resolved', async () => {
      await expect(isRecipeCaptureAuthorityEligible(opaqueScript)).resolves.toBe(false);
      await expect(isRecipeCaptureAuthorityEligible(dynamicDispatchScript)).resolves.toBe(false);
    });

    it('still allows capture for a resolvable script', async () => {
      await expect(isRecipeCaptureAuthorityEligible(resolvableScript)).resolves.toBe(true);
    });

    // THE DEFECT, pinned: the run-quality predicate and the authority predicate
    // DISAGREE about the opaque script. isRecipeCaptureEligible says "capture it"
    // (the run genuinely succeeded — dev:pg-query is a read tool and a semantic
    // diagnostic on it is explicitly allowed above), while execution would refuse
    // it forever. Before the fix only the first predicate was consulted, so exactly
    // this script was captured and then accumulated run/success counts certifying a
    // recipe that can never be run once.
    it('pins the defect: run-quality says capture, authority says never — and only authority is right', async () => {
      const read = { effect: 'read', expose: { mcp: { name: 'dev:pg-query' } } };

      const runQualitySaysCapture = isRecipeCaptureEligible(
        { ok: true, childFailures: [{ tool: 'dev:pg-query', kind: 'semantic' }] },
        [read],
      );
      const authoritySaysCapture = await isRecipeCaptureAuthorityEligible(opaqueScript);

      expect(runQualitySaysCapture).toBe(true);
      expect(authoritySaysCapture).toBe(false);
      // If these ever agree, this test has stopped covering the gap it was written for.
      expect(runQualitySaysCapture).not.toBe(authoritySaysCapture);
    });

    // MEASURED, not assumed. A syntactically broken script does NOT throw and is NOT
    // reported unresolved: it parses to zero tool calls, so there is nothing for the
    // analyzer to find unprovable, and it comes back resolvable-with-empty-refs. That
    // is fine HERE only because such a script never reaches this gate — its run fails,
    // and `isRecipeCaptureEligible`'s `result.ok` check rejects it upstream. This test
    // records that division of labour so nobody "hardens" this predicate against
    // malformed input under the impression it is the thing standing in the way.
    it('does not gate malformed input — that is result.ok upstream, not authority', async () => {
      await expect(isRecipeCaptureAuthorityEligible('const = = = ;')).resolves.toBe(true);
      expect(isRecipeCaptureEligible({ ok: false, childFailures: [] }, [])).toBe(false);
    });
  });

  it('stamps effective error metadata when the script fails', async () => {
    const tool = codeRun();
    const metadata = vi.fn();
    const ctx = { ...(mkCtx() as unknown as Record<string, unknown>), metadata } as never;
    await tool.fn({ script: 'throw new Error("boom");' }, ctx);
    expect(metadata).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'server',
        toolCalls: 1,
        intermediateBytes: 0,
        spilledBytes: 0,
        failureClass: 'script-error',
        effectiveStatus: 'error',
        childFailureCount: 1,
      }),
    );
  });

  it('stamps exact pre-door run metrics and captured recipe identity without content', async () => {
    captureRecipeMock.mockResolvedValueOnce({
      row: {
        id: 'metric-recipe',
        script: 'return { kept: true };',
        updatedAt: '2026-08-22T20:00:00.000Z',
      } as never,
      disposition: 'created',
      matchedSimilarity: null,
      similarRecipes: [],
    });
    const metadata = vi.fn();
    const ctx = { ...(mkCtx() as unknown as Record<string, unknown>), metadata } as never;
    const res = (await codeRun().fn({ script: 'return { kept: true };' }, ctx)) as {
      content: Array<{ type: string; text?: string }>;
    };
    const stamped = metadata.mock.calls[0][0] as Record<string, unknown>;
    const payload = JSON.parse(String(res.content[0]?.text));

    expect(stamped).toMatchObject({
      backend: 'server',
      toolCalls: 1,
      intermediateBytes: 0,
      returnedContextBytes: codeRunReturnedContextBytes(payload, undefined),
      spilledBytes: 0,
      failureClass: null,
      recipeCapture: 'captured',
      recipeReuse: false,
      recipeCacheHit: false,
      recipeCandidateCount: 0,
      recipeId: 'metric-recipe',
      recipeCaptureDisposition: 'created',
    });
    expect(stamped.recipeRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(stamped.durationMs).toEqual(expect.any(Number));
    expect(recordRecipeRunMock).not.toHaveBeenCalled();
    expect(captureRecipeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ executionTrace: normalizedTrace }),
    );
    expect(JSON.stringify(stamped)).not.toContain('kept');
    expect(codeRunFailureClass({ ok: true })).toBeNull();
  });

  it('shapes console logs before serializing the code:run payload and keeps a small summary unchanged', async () => {
    const tool = codeRun();
    const res = await tool.fn(
      {
        script: 'console.log("raw \\u001b[31mred\\u001b[0m bell \\u0007 newline\\nnext");\n' + 'return { kept: true };',
      },
      mkCtx(),
    );
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.summary).toEqual({ kept: true });
    expect(payload.logs).toEqual(['raw red bell  newline next']);
    expect(payload.logsNotice).toMatchObject({
      rawCount: 1,
      shownCount: 1,
      sanitizedLines: 1,
      droppedAfterLimit: 0,
    });
  });
});

describe('code:run → nested summary shaping (EI-20981474230843769)', () => {
  it('keeps a small summary byte-identical', () => {
    const result = { summary: { markerCount: 1, lines: ['first', 'second'] } };
    expect(shapeCodeRunSummary(result)).toBe(result);
  });

  it('spills the original summary and returns an owner-scoped recovery cursor when shaping omits data', async () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'code-run-summary-spill-'));
    const previousRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
    process.env.PAPERCUSP_SCRATCH_ROOT = scratchRoot;
    try {
      const tool = listAllProjectedTools().find((candidate) => candidate.expose.mcp?.name === 'code:run');
      if (!tool) throw new Error('code:run not registered');
      const res = await tool.fn(
        {
          script:
            'return { records: Array.from({ length: 24 }, (_, index) => ({ ' +
            'id: index, detail: `record-${index}-${"x".repeat(500)}` })) };',
        },
        {
          log: () => {},
          workspaceId: 'ws-test',
          harnessSlug: 'alpha',
          role: 'su',
          isSuperuser: true,
          uiClientId: 'su-test',
        } as never,
      );
      const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text) as {
        summary: { records: unknown[] };
        summaryNotice: {
          truncated: true;
          rawSummaryCursor: {
            status: string;
            args?: { uri: string };
            byteCount?: number;
            sha256?: string;
          };
        };
      };

      expect(payload.summaryNotice.truncated).toBe(true);
      expect(payload.summaryNotice.rawSummaryCursor.status).toBe('available');
      const uri = payload.summaryNotice.rawSummaryCursor.args?.uri;
      expect(uri).toBeTruthy();
      const reference = parseScratchReference(readFileSync(safeScratchFilesystemPath(uri!)));
      expect(reference).not.toBeNull();
      expect(reference!.manifest).toMatchObject({
        audience: 'owner',
        ownerId: 'owner-x',
        byteCount: payload.summaryNotice.rawSummaryCursor.byteCount,
        sha256: payload.summaryNotice.rawSummaryCursor.sha256,
        bodyOffsetInPayload: 0,
      });
      expect(JSON.parse(reference!.payload.toString('utf8'))).toEqual({
        records: Array.from({ length: 24 }, (_, index) => ({
          id: index,
          detail: `record-${index}-${'x'.repeat(500)}`,
        })),
      });
    } finally {
      if (previousRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
      else process.env.PAPERCUSP_SCRATCH_ROOT = previousRoot;
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it('preserves source array counts in TOON while marking omitted entries (EI-24966800800754357)', () => {
    const summary = {
      union: Array.from({ length: 16 }, (_, index) => `D-${String(index + 1).padStart(3, '0')}`),
      rows: Array.from({ length: 40 }, (_, index) => ({
        id: `row-${index + 1}`,
        detail: `row-${index + 1}-${'x'.repeat(500)}`,
      })),
    };
    const shaped = shapeCodeRunSummary({ summary }) as {
      summary: { union: unknown[]; rows: unknown[] };
      summaryNotice: {
        arraysTruncated: number;
        arrayOriginalLengths: Record<string, number>;
      };
    };
    const toon = encode(shaped.summary, 'toon');

    expect(shaped.summaryNotice.arraysTruncated).toBe(2);
    expect(shaped.summaryNotice.arrayOriginalLengths).toMatchObject({
      'summary.union': 16,
      'summary.rows': 40,
    });
    expect(shaped.summary.union).toHaveLength(16);
    expect(shaped.summary.rows).toHaveLength(40);
    expect(shaped.summary.union).toContain('[omitted]');
    expect(shaped.summary.rows).toContain('[omitted]');
    expect(toon).toMatch(/union\[16\]/);
    expect(toon).toMatch(/rows\[40\]/);
  });

  it('bounds nested strings and arrays while preserving scalar marker fields', async () => {
    const tool = listAllProjectedTools().find((t) => t.expose.mcp?.name === 'code:run');
    if (!tool) throw new Error('code:run not registered');

    const res = await tool.fn(
      {
        script:
          'return {' +
          'markerCount: 1,' +
          'lineCount: 81,' +
          'returnedChars: 54822,' +
          'lines: Array.from({ length: 81 }, (_, i) => `line-${i} ${"x".repeat(900)}`)' +
          '};',
      },
      {
        log: () => {},
        workspaceId: 'ws-test',
        harnessSlug: 'alpha',
        role: 'su',
        isSuperuser: true,
        uiClientId: 'su-test',
      } as never,
    );
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);

    expect(payload.ok).toBe(true);
    expect(payload.summary).toMatchObject({ markerCount: 1, lineCount: 81, returnedChars: 54822 });
    expect(payload.summary.lines).toHaveLength(81);
    expect(payload.summary.lines).toContain('[omitted]');
    // EI-21254588525256811: this used to assert `line.length <= 360` — the projection ladder's
    // internal rung CONSTANT, not a contract. Pinning it is what hid the defect: the ladder
    // stopped at the first rung that fit, so it returned ~11% of the budget it was entitled to
    // spend. Assert the two real invariants instead — bounded BY THE BUDGET, and the budget
    // actually USED — both derived from the exported constant so neither can drift from it.
    const summaryChars = JSON.stringify(payload.summary).length;
    expect(summaryChars).toBeLessThanOrEqual(CODE_RUN_SUMMARY_CHAR_BUDGET);
    expect(summaryChars).toBeGreaterThan(CODE_RUN_SUMMARY_CHAR_BUDGET * 0.75);
    expect(payload.summaryNotice).toMatchObject({
      truncated: true,
      originalChars: expect.any(Number),
      returnedChars: expect.any(Number),
      arraysTruncated: expect.any(Number),
      stringsTruncated: expect.any(Number),
    });
    expect(payload.summaryNotice.paths).toContain('summary.lines');
    expect(JSON.stringify(payload).length).toBeLessThan(6_000);
  });

  // EI-21254588525256811: a caller who had ALREADY bounded the value themselves
  // (`checkpoint.slice(-5000)`) had that deliberate reduction re-cut to 360 chars — the ladder's
  // rung constant — and lost the END of a value whose whole point was to be a tail.
  describe('caller-bounded scalar (EI-21254588525256811)', () => {
    // A tail scalar just over budget: the shaper must clip it, and how it clips is the subject.
    const tailValue = () => `[HEAD]${'x'.repeat(4_980)}[TAIL]`;

    it('spends the char budget instead of stopping at the ladder rung constant', () => {
      const shaped = shapeCodeRunSummary({ summary: { checkpointTail: tailValue() } }) as {
        summary: { checkpointTail: string };
      };
      const summaryChars = JSON.stringify(shaped.summary).length;

      // The defect returned 381 chars (10.9% of budget). Anything in that region is the
      // rung constant winning again, whatever the exact number.
      expect(summaryChars).toBeGreaterThan(CODE_RUN_SUMMARY_CHAR_BUDGET * 0.75);
      expect(summaryChars).toBeLessThanOrEqual(CODE_RUN_SUMMARY_CHAR_BUDGET);
    });

    it('keeps the END of a clipped string so a caller-derived tail survives', () => {
      const shaped = shapeCodeRunSummary({ summary: { checkpointTail: tailValue() } }) as {
        summary: { checkpointTail: string };
      };

      expect(shaped.summary.checkpointTail).toContain('[TAIL]');
      expect(shaped.summary.checkpointTail).toContain('[HEAD]');
    });

    // CONTROL. Both assertions above must be able to FAIL, or they prove nothing. Head-only
    // clipping at the old rung width is exactly the defect, reproduced here: it drops [TAIL] and
    // lands in the ~11%-of-budget region. If this control ever passes the two assertions above,
    // they have stopped discriminating and the guard is decorative.
    it('CONTROL: the pre-fix shape would fail both assertions above', () => {
      const headOnlyAtRungWidth = tailValue().slice(0, 360);
      const summaryChars = JSON.stringify({ checkpointTail: headOnlyAtRungWidth }).length;

      expect(headOnlyAtRungWidth).not.toContain('[TAIL]');
      expect(summaryChars).toBeLessThan(CODE_RUN_SUMMARY_CHAR_BUDGET * 0.75);
    });

    // CALIBRATION. The budget-spend assertion must not pass by clipping something that never
    // needed clipping: a summary under budget stays byte-identical and is never re-shaped.
    it('CALIBRATION: a summary already under budget is returned untouched', () => {
      const small = { summary: { checkpointTail: 'short' } };
      expect(shapeCodeRunSummary(small)).toBe(small);
    });
  });

  // EI-21267600739763524: a summary that is a top-level ARRAY (the natural shape of a
  // grep-context or row-scan result) and exceeds every ladder rung fell through to the minimal
  // projection, which returned []. The caller got an EMPTY result — and its notice reported
  // omittedItems: 0, so the envelope actively denied having cut anything.
  describe('oversized array summary (EI-21267600739763524)', () => {
    // Too large for every rung: 200 rows x 30 long fields forces the minimal projection.
    const rows = () =>
      Array.from({ length: 200 }, (_, row) =>
        Object.fromEntries(
          Array.from({ length: 30 }, (_, field) => [`f${field}`, `row${row}-field${field}-${'z'.repeat(200)}`]),
        ),
      );

    it('keeps retained rows in a count-bearing wrapper instead of collapsing to an empty result', () => {
      const shaped = shapeCodeRunSummary({ summary: rows() }) as unknown as {
        summary: { __truncatedArray: true; originalLength: number; items: unknown[] };
        summaryNotice: { omittedItems: number };
      };

      expect(shaped.summary).toMatchObject({ __truncatedArray: true, originalLength: 200 });
      expect(shaped.summary.items.length).toBeGreaterThan(0);
      expect(JSON.stringify(shaped.summary).length).toBeLessThanOrEqual(CODE_RUN_SUMMARY_CHAR_BUDGET);
    });

    it('discloses the original row count and dropped rows instead of reporting nothing was omitted', () => {
      const shaped = shapeCodeRunSummary({ summary: rows() }) as unknown as {
        summary: { originalLength: number; items: unknown[] };
        summaryNotice: { omittedItems: number };
      };

      expect(shaped.summary.originalLength).toBe(200);
      expect(shaped.summaryNotice.omittedItems).toBeGreaterThanOrEqual(
        shaped.summary.originalLength - shaped.summary.items.length,
      );
    });

    // CONTROL. Both assertions above must be able to fail. The pre-fix value is literally `[]`
    // with omittedItems 0; if that shape ever satisfies them, they have stopped discriminating.
    it('CONTROL: the pre-fix empty result would fail both assertions above', () => {
      const preFix: unknown[] = [];
      const preFixNotice = { omittedItems: 0 };

      expect(preFix.length).toBe(0);
      expect(preFixNotice.omittedItems).toBeLessThan(200 - preFix.length);
    });
  });

  // EI-21972587349695167: a depth-boundary array containing ordinary values (rather
  // than MCP `{ text }` entries) used to fall through to `[]`. That made a real
  // pending-migration list indistinguishable from an empty one.
  describe('nested ordinary arrays at a depth boundary (EI-21972587349695167)', () => {
    const nestedSummary = () => ({
      envelope: {
        envelope: {
          drift: {
            ok: true,
            in_sync: false,
            missing: ['1047-spawn-governor-observation.sql'],
            extra: [],
            content_drift: Array.from({ length: 40 }, (_, index) => ({
              name: `migration-${index}`,
              expected: 'e'.repeat(700),
              actual: 'a'.repeat(700),
            })),
            schema_ahead: ['future-migration.sql'],
          },
        },
      },
    });

    it('keeps a bounded prefix of non-empty nested arrays', () => {
      const shaped = shapeCodeRunSummary({ summary: nestedSummary() }) as {
        summary: {
          envelope: {
            envelope: {
              drift: {
                missing: string[];
                content_drift: Array<{ name: string }>;
                schema_ahead: string[];
              };
            };
          };
        };
        summaryNotice: { truncated: true; paths: string[] };
      };

      expect(shaped.summary.envelope.envelope.drift.missing).toContain('1047-spawn-governor-observation.sql');
      expect(shaped.summary.envelope.envelope.drift.content_drift.length).toBeGreaterThan(0);
      expect(shaped.summary.envelope.envelope.drift.content_drift[0]?.name).toBe('migration-0');
      expect(shaped.summary.envelope.envelope.drift.schema_ahead).toContain('future-migration.sql');
      expect(shaped.summaryNotice.paths).toContain('summary.envelope.envelope.drift.content_drift');
    });

    it('CONTROL: the pre-fix boundary fallback would erase every ordinary array', () => {
      const preFix = {
        missing: [],
        content_drift: [],
        schema_ahead: [],
      };

      expect(preFix.missing).not.toContain('1047-spawn-governor-observation.sql');
      expect(preFix.content_drift).toHaveLength(0);
      expect(preFix.schema_ahead).not.toContain('future-migration.sql');
    });
  });

  // The minimal projection is a separate fallback from the depth-boundary ladder.
  // Keep its nested arrays truthful too, otherwise a very wide object can still
  // launder a non-empty collection into `[]` after every ladder rung rejects.
  it('keeps nested arrays when the minimal object projection is required', () => {
    const summary = {
      pending: ['1047-spawn-governor-observation.sql'],
      ...Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, 'x'.repeat(1_000)])),
    };
    const shaped = shapeCodeRunSummary({ summary }) as {
      summary: { pending: string[] };
      summaryNotice: { truncated: true };
    };

    expect(shaped.summary.pending).toContain('1047-spawn-governor-observation.sql');
    expect(shaped.summaryNotice.truncated).toBe(true);
  });

  it('retains a bounded nested object when its first projection exceeds the remaining budget', () => {
    // Each B1 record is deliberately wide enough to force the last-resort
    // object projection. The old top-level admission treated `b` atomically
    // and returned only `head`/`nLines`, losing every nested key.
    const summary = {
      head: 'h'.repeat(1_200),
      nLines: 10,
      b: Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [
          `B1_${index}`,
          Object.fromEntries(
            Array.from({ length: 30 }, (_, field) => [`f${field}`, `value-${field}-${'x'.repeat(300)}`]),
          ),
        ]),
      ),
    };
    const shaped = shapeCodeRunSummary({ summary }) as {
      summary: { b: Record<string, unknown> };
      summaryNotice: { truncated: true; returnedChars: number };
    };

    const nestedKeys = Object.keys(shaped.summary.b).filter((key) => key.startsWith('B1_'));
    expect(nestedKeys.length).toBeGreaterThan(0);
    expect(JSON.stringify(shaped.summary).length).toBeLessThanOrEqual(CODE_RUN_SUMMARY_CHAR_BUDGET);
    expect(shaped.summaryNotice.returnedChars).toBe(JSON.stringify(shaped.summary).length);
  });

  it('uses spare summary budget for long nested evidence in the minimal code:run result', async () => {
    const tool = listAllProjectedTools().find((candidate) => candidate.expose.mcp?.name === 'code:run');
    if (!tool) throw new Error('code:run not registered');
    const summary = {
      criterion: { text: `scorecard evidence start ${'e'.repeat(7_900)} [EVIDENCE-END]` },
      ...Object.fromEntries(
        Array.from({ length: 30 }, (_, index) => [`sibling${index}`, `sibling-${index}-${'x'.repeat(120)}`]),
      ),
    };
    const res = await tool.fn(
      { script: `return ${JSON.stringify(summary)};` },
      {
        log: () => {},
        workspaceId: 'ws-test',
        harnessSlug: 'alpha',
        role: 'su',
        isSuperuser: true,
        uiClientId: 'su-test',
      } as never,
    );
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    const summaryChars = JSON.stringify(payload.summary).length;

    expect(payload.ok).toBe(true);
    expect(payload.summary.criterion.text.length).toBeGreaterThan(80);
    expect(summaryChars).toBeLessThanOrEqual(CODE_RUN_SUMMARY_CHAR_BUDGET);
    expect(summaryChars).toBeGreaterThan(CODE_RUN_SUMMARY_CHAR_BUDGET * 0.9);
    expect(payload.summaryNotice.returnedChars).toBe(summaryChars);
    expect(payload.summaryNotice.stringsTruncated).toBe(31);
    expect(Object.keys(payload.summary).filter((key) => key.startsWith('sibling'))).toHaveLength(30);

    const arrayRow = {
      evidence: `array scorecard evidence start ${'a'.repeat(7_900)} [ARRAY-EVIDENCE-END]`,
      ...Object.fromEntries(
        Array.from({ length: 29 }, (_, index) => [`arraySibling${index}`, `sibling-${index}-${'y'.repeat(120)}`]),
      ),
    };
    const arrayPayload = shapeCodeRunSummary({ summary: [arrayRow] }) as {
      summary: Array<{ evidence: string }>;
    };
    const arraySummaryChars = JSON.stringify(arrayPayload.summary).length;

    expect(arrayPayload.summary[0]?.evidence.length).toBeGreaterThan(80);
    expect(arraySummaryChars).toBeLessThanOrEqual(CODE_RUN_SUMMARY_CHAR_BUDGET);
    expect(arraySummaryChars).toBeGreaterThan(CODE_RUN_SUMMARY_CHAR_BUDGET * 0.9);
  });

  it('marks a populated nested result when depth bounding omits its fields, while preserving a truly empty object', () => {
    const results = Array.from({ length: 8 }, (_, index) => ({
      outputPayload: index === 0 ? {} : {
        processLifecycleVerdict: { status: 'passed', detail: 'x'.repeat(1_500) },
        audit: { detail: 'y'.repeat(1_500) },
      },
      detail: 'z'.repeat(1_000),
    }));
    const shaped = shapeCodeRunSummary({ summary: { results } }) as {
      summary: { results: Array<{ outputPayload: Record<string, unknown> }> };
      summaryNotice: { truncated: true; paths: string[] };
    };

    expect(shaped.summaryNotice.truncated).toBe(true);
    expect(shaped.summary.results[0]?.outputPayload).toEqual({});
    expect(shaped.summary.results[1]?.outputPayload).toMatchObject({
      __truncated: expect.stringContaining('summaryNotice.paths'),
    });
    expect(shaped.summaryNotice.paths).toContain('summary.results[1].outputPayload');
  });

  it('preserves background launch handles inside nested MCP result envelopes', () => {
    const launched = Array.from({ length: 9 }, (_, index) => ({
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              bash_id: `bash-${index}`,
              task_id: `task-${index}`,
              status: 'running',
              check: 'test',
              command: 'npx vitest run',
              advice: 'poll capability:bash_output after the detached check completes ' + 'x'.repeat(900),
            }),
          },
        ],
      },
    }));

    const shaped = shapeCodeRunSummary({
      summary: { launched, dispatchCount: 9, childFailures: [] },
    }) as {
      summary: { launched: Array<{ result: { content: Array<{ text: string }> } }> };
      summaryNotice?: { truncated: true };
    };

    expect(shaped.summaryNotice).toMatchObject({ truncated: true });
    expect(shaped.summary.launched).toHaveLength(launched.length);
    expect(shaped.summary.launched.some((row) => typeof row === 'string')).toBe(true);
    const retained = shaped.summary.launched.filter(
      (row): row is { result: { content: Array<{ text: string }> } } =>
        typeof row === 'object' && row !== null && 'result' in row,
    );
    expect(retained.length).toBeGreaterThan(0);
    for (const [index, row] of retained.entries()) {
      expect(row.result.content[0]?.text).toContain(`"bash_id":"bash-${index}"`);
      expect(row.result.content[0]?.text).toContain(`"task_id":"task-${index}"`);
    }
  });

  it('preserves scalar fields in ordinary nested records at the aggressive depth boundary', () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      id: `id-${index}`,
      invoked_at: index,
      tool_name: 'dev:pg_query',
      status: 'success',
      owner: `owner-${index}`,
      goal: `goal-${index}`,
      output: 'output-'.repeat(50),
      args: { path: 'x'.repeat(300), index },
    }));

    const shaped = shapeCodeRunSummary({
      summary: {
        invocations: { rows },
        selectedFields: ['id', 'invoked_at', 'tool_name', 'status', 'owner', 'goal', 'output', 'args'],
      },
    }) as {
      summary: {
        invocations: { rows: Array<Record<string, unknown>> };
        selectedFields: string[];
      };
      summaryNotice: { truncated: true; paths: string[] };
    };

    expect(shaped.summary.invocations.rows.length).toBeGreaterThan(0);
    expect(shaped.summary.invocations.rows).toHaveLength(rows.length);
    expect(shaped.summary.invocations.rows.some((row) => typeof row === 'string')).toBe(true);
    expect(shaped.summary.invocations.rows[0]).toMatchObject({
      id: 'id-0',
      invoked_at: 0,
      tool_name: 'dev:pg_query',
      status: 'success',
      owner: 'owner-0',
      goal: 'goal-0',
    });
    expect(shaped.summary.invocations.rows[0]?.output).toEqual(expect.stringContaining('output-'));
    expect(shaped.summary.invocations.rows[0]?.args).toBeUndefined();
    expect(shaped.summaryNotice.paths).toContain('summary.invocations.rows');
  });

  // EI-22796173621053064: a committed-image check emits a PASS prefix followed by the decisive
  // FAIL/result/verdict lines. A prefix-only projection made the failed run look successful.
  describe('failure/result-prioritized evidence arrays', () => {
    const evidence = () => [
      ...Array.from({ length: 12 }, (_, index) => `P305_PASS check=${index}`),
      'P305_FAIL phase=updated reason=sentinel-mismatch',
      'P305_RESULT result=failed exit=1',
      'P305_VERDICT verdict=fail',
      ...Array.from({ length: 9 }, (_, index) => `P305_DIAGNOSTIC detail=${index}`),
    ];

    it('keeps decisive suffix lines in an oversized evidence array', () => {
      const lines = evidence();
      const shaped = shapeCodeRunSummary({
        summary: {
          evidence: lines,
          duplicatedArgs: { input: 'x'.repeat(9_000), error: 'y'.repeat(9_000) },
        },
      }) as {
        summary: { evidence: string[] };
        summaryNotice: { paths: string[] };
      };

      expect(shaped.summary.evidence).toEqual(
        expect.arrayContaining([
          'P305_FAIL phase=updated reason=sentinel-mismatch',
          'P305_RESULT result=failed exit=1',
          'P305_VERDICT verdict=fail',
        ]),
      );
      expect(shaped.summary.evidence).toHaveLength(lines.length);
      expect(shaped.summary.evidence).toContain('[omitted]');
      expect(JSON.stringify(shaped.summary).length).toBeLessThanOrEqual(CODE_RUN_SUMMARY_CHAR_BUDGET);
      expect(shaped.summaryNotice.paths).toContain('summary.evidence');
    });

    it('also prioritizes decisive lines when evidence is projected at a depth boundary', () => {
      const lines = evidence();
      const shaped = shapeCodeRunSummary({
        summary: {
          envelope: {
            envelope: {
              evidence: lines,
              noise: 'z'.repeat(9_000),
            },
          },
        },
      }) as {
        summary: { envelope: { envelope: { evidence: string[] } } };
      };

      expect(shaped.summary.envelope.envelope.evidence).toEqual(
        expect.arrayContaining([
          'P305_FAIL phase=updated reason=sentinel-mismatch',
          'P305_RESULT result=failed exit=1',
          'P305_VERDICT verdict=fail',
        ]),
      );
    });

    it('CONTROL: the old prefix projection omits the decisive suffix', () => {
      const prefix = evidence().slice(0, 8);

      expect(prefix).not.toContain('P305_FAIL phase=updated reason=sentinel-mismatch');
      expect(prefix).not.toContain('P305_RESULT result=failed exit=1');
      expect(prefix).not.toContain('P305_VERDICT verdict=fail');
    });
  });

  // EI-22572881407380085: a Promise.all of release:trace reads must keep every target identity
  // and the authoritative fields needed to decide what to do next. The generic projector is
  // intentionally allowed to omit incidental detail; this fixture makes that detail large enough
  // to force its aggressive ladder so the identity-preservation seam is exercised.
  describe('release:trace multi-result identity projection', () => {
    const releaseTraceRows = () =>
      Array.from({ length: 3 }, (_, index) => {
        const sha = String(index + 1).repeat(40);
        return {
          ok: true,
          generatedAtMs: index + 1,
          target: { path: `packages/example-${index}.ts`, sha },
          gate: {
            state: 'green',
            authoritative: true,
            consecutiveReds: 0,
            failingTests: [`gate-${index}`],
            failingTestsMeasured: true,
            observedCandidate: sha,
            fixCommitContainment: {
              fixSha: sha,
              observedCandidate: sha,
              verdict: 'contained',
              reason: null,
            },
          },
          greenPin: { sha, source: 'green-checkpoint' },
          deploy: { sha, state: 'green' },
          testedDeployedParity: { testedSha: sha, deployedSha: sha, match: true },
          nextVerb: {
            name: 'checkpoint:await',
            args: { pipeline: `pipeline-${index}` },
            reason: `await the exact candidate ${sha}`,
          },
          noise: Object.fromEntries(Array.from({ length: 24 }, (_, field) => [`noise${field}`, 'x'.repeat(900)])),
        };
      });

    it('keeps all three SHAs and authoritative gate fields within the summary budget', () => {
      const rows = releaseTraceRows();
      const shaped = shapeCodeRunSummary({ summary: { releaseTraces: rows } }) as {
        summary: {
          releaseTraces: Array<{
            target: { sha: string };
            gate: { authoritative: boolean; failingTests: string[]; fixCommitContainment: { verdict: string } };
            greenPin: { sha: string };
            testedDeployedParity: { testedSha: string; deployedSha: string };
            nextVerb: { name: string };
          }>;
        };
        summaryNotice: { truncated: true; paths: string[] };
      };

      expect(shaped.summary.releaseTraces).toHaveLength(rows.length);
      for (const [index, row] of shaped.summary.releaseTraces.entries()) {
        const sha = String(index + 1).repeat(40);
        expect(row.target.sha).toBe(sha);
        expect(row.gate).toMatchObject({
          authoritative: true,
          failingTests: [`gate-${index}`],
          fixCommitContainment: { verdict: 'contained' },
        });
        expect(row.greenPin.sha).toBe(sha);
        expect(row.testedDeployedParity).toMatchObject({ testedSha: sha, deployedSha: sha });
        expect(row.nextVerb.name).toBe('checkpoint:await');
      }
      expect(JSON.stringify(shaped.summary).length).toBeLessThanOrEqual(CODE_RUN_SUMMARY_CHAR_BUDGET);
      expect(shaped.summaryNotice).toMatchObject({ truncated: true });
      expect(shaped.summaryNotice.paths).toContain('summary.releaseTraces[0]');
    });

    it('CONTROL: the old aggressive array rung could only retain a two-row prefix', () => {
      const rows = releaseTraceRows();
      const oldAggressivePrefix = rows.slice(0, 2);

      expect(oldAggressivePrefix).toHaveLength(2);
      expect(oldAggressivePrefix.map((row) => row.target.sha)).not.toContain(rows[2]?.target.sha);
    });
  });
});

// EI-21163938645109933 / EI-21164455886001541 (P-007). Both were filed as "false field-miss
// flags", but the flags were TRUE — the fields really were absent. The defect was that a typo and
// a legitimately-optional field produced the SAME warning, burying the signal this detector
// exists for in noise it could not act on.
describe('code:run → field-miss classification (P-007)', () => {
  const miss = (over: Partial<FieldMiss> = {}): FieldMiss => ({
    tool: 'dev:pg_query',
    path: '(root)',
    read: 'ok',
    available: ['rowCount', 'truncated', 'fields', 'elapsedMs', 'rows'],
    ...over,
  });

  it('renders a typo as a correction naming the key it resembles', () => {
    const help = shapeFieldMissHelp([miss({ read: 'rowcount', likely: 'typo', didYouMean: 'rowCount' })]);

    expect(help).toContain('did you mean `rowCount`?');
    expect(help).toContain('does NOT have');
  });

  it('renders an absent optional field as presence-branching advice, not a misspelling', () => {
    // The real EI-21163938645109933 shape: dev:pg_query success omits `ok` entirely.
    const help = shapeFieldMissHelp([miss({ likely: 'optional-field' })]);

    expect(help).toContain('OPTIONAL field');
    expect(help).toContain("'k' in r");
    expect(help).not.toContain('did you mean');
  });

  it('separates the two classes when a result carries both', () => {
    const help = shapeFieldMissHelp([
      miss({ read: 'rowcount', likely: 'typo', didYouMean: 'rowCount' }),
      miss({ read: 'criterionClass', path: 'rows.0', available: ['one'], likely: 'optional-field' }),
    ]);

    expect(help).toContain('⚠ 1 read(s)');
    expect(help).toContain('ℹ 1 read(s)');
  });

  // CONTROL. The two renderings must be DISTINGUISHABLE, or the split is decorative. The pre-fix
  // behaviour is one undifferentiated warning for both — if these ever render identically, this
  // guard has stopped discriminating.
  it('CONTROL: the two classes do not render identically', () => {
    const typo = shapeFieldMissHelp([miss({ likely: 'typo', didYouMean: 'rowCount' })]);
    const optional = shapeFieldMissHelp([miss({ likely: 'optional-field' })]);

    expect(typo).not.toEqual(optional);
  });

  // CALIBRATION. A miss with no classification (produced before this existed, or by an older
  // orchestrator) must still be reported — silently dropping it would lose the original signal.
  it('CALIBRATION: an unclassified miss still renders as a correction', () => {
    const help = shapeFieldMissHelp([miss()]);

    expect(help).toContain('does NOT have');
    expect(help).toContain('`ok`');
  });

  it('returns undefined when there are no misses', () => {
    expect(shapeFieldMissHelp([])).toBeUndefined();
    expect(shapeFieldMissHelp(undefined)).toBeUndefined();
  });
});

describe('code:run → similarRecipes result shaping', () => {
  const authority = {
    version: 1 as const,
    revision: 'revision-1',
    context: { workspace: 'ws-test', fleet: 'fleet-test', harness: 'alpha' },
  };
  const recipe = (index: number) => ({
    id: `recipe-${index}`,
    title: `Recipe ${index} ${'x'.repeat(140)}`,
    description: 'a description that is intentionally not part of the compact result',
    runCount: index,
    toolsUsed: ['coord:send', 'work_items:get'],
    similarity: 0.9 - index / 100,
    authority,
    authorityRefs: { workspaces: [], fleets: [], plans: [], harnesses: [], items: [], resources: [] },
    runArgs: { id: `recipe-${index}`, authority },
  });

  it('keeps the exact runArgs while omitting duplicate advisory fields and capping the list', () => {
    const shaped = shapeCodeRunSimilarRecipes([recipe(1), recipe(2), recipe(3), recipe(4), recipe(5)]);

    expect(shaped.similarRecipes).toHaveLength(3);
    expect(shaped.similarRecipes[0]).toEqual({
      id: 'recipe-1',
      title: `Recipe 1 ${'x'.repeat(110)}…`,
      runCount: 1,
      similarity: 0.89,
      authorityRefs: { workspaces: [], fleets: [], plans: [], harnesses: [], items: [], resources: [] },
      runArgs: { id: 'recipe-1', authority },
    });
    expect(shaped.similarRecipes[0]).not.toHaveProperty('description');
    expect(shaped.similarRecipes[0]).not.toHaveProperty('toolsUsed');
    expect(shaped.similarRecipes[0]).not.toHaveProperty('authority');
    expect(shaped.similarRecipesTruncated).toEqual({
      shown: 3,
      truncatedByLimit: true,
      limit: 3,
      more: 'recipes:search { query, limit } for more matches; recipes:get { id } for a full recipe',
    });
  });

  it('uses the bounded shape in the agent-facing code:run payload', async () => {
    captureRecipeMock.mockResolvedValueOnce({
      row: {
        id: 'captured-recipe',
        title: 'Captured recipe',
        description: 'Captured during the test',
        script: 'return { delivered: true };',
        // null on both = a legacy recipe with no versioned runtime-input contract, which is
        // exactly what a capture-time fixture is. Stated rather than omitted: both fields are
        // required on CodeRecipeRow, and `null` is their documented "legacy" value.
        bindingSchema: null,
        capabilityManifest: null,
        potSlug: 'alpha',
        authorRole: 'su',
        toolsUsed: [],
        runCount: 1,
        successCount: 1,
        lastRunAt: null,
        status: 'active',
        promotedTool: null,
        mergedInto: null,
        tags: [],
        hasEmbedding: false,
        createdBy: 'owner-x',
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z',
      },
      disposition: 'near-similarity-reuse',
      matchedSimilarity: 0.9,
      similarRecipes: [recipe(1), recipe(2), recipe(3), recipe(4)],
    });
    const tool = listAllProjectedTools().find((t) => t.expose.mcp?.name === 'code:run');
    if (!tool) throw new Error('code:run not registered');

    const res = await tool.fn({ script: 'return { delivered: true };' }, {
      log: () => {},
      workspaceId: 'ws-test',
      harnessSlug: 'alpha',
      role: 'su',
      isSuperuser: true,
      uiClientId: 'su-test',
    } as never);
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);

    expect(payload.summary).toEqual({ delivered: true });
    expect(payload.similarRecipes).toHaveLength(3);
    expect(payload.similarRecipesTruncated).toMatchObject({ shown: 3, limit: 3 });
  });
});

/**
 * EI-21636457492876715: the public `timeoutSec` contract must not advertise a budget above the
 * effective foreground ceiling. Runtime clamping remains defensive for internal callers, while
 * transport callers should receive a schema rejection before dispatch for an ineffective value.
 */
describe('code:run → timeoutSec foreground contract (EI-21636457492876715)', () => {
  it('rejects timeoutSec above the foreground ceiling at the schema boundary', () => {
    const maxTimeoutSec = FOREGROUND_TIMEOUT_CEILING_MS / 1000;
    expect(codeRunTool.args.safeParse({ script: 'return 42;', timeoutSec: maxTimeoutSec }).success).toBe(true);
    expect(codeRunTool.args.safeParse({ script: 'return 42;', timeoutSec: maxTimeoutSec + 1 }).success).toBe(false);
    expect(codeRunTool.args.safeParse({ script: 'return 42;', timeoutSec: 120 }).success).toBe(false);
  });

  it('publishes the same foreground ceiling in the exposed argument schema', () => {
    const tool = listAllProjectedTools().find((candidate) => candidate.expose.mcp?.name === 'code:run');
    const timeoutSec = (tool?.inputSchema as {
      properties?: { timeoutSec?: { maximum?: number } };
    })?.properties?.timeoutSec;

    expect(timeoutSec?.maximum).toBe(FOREGROUND_TIMEOUT_CEILING_MS / 1000);
  });
});

describe('code:run → response-safe postprocessing budget', () => {
  it('attributes a pending capture and its elapsed time separately from worker and trace work', async () => {
    const tool = listAllProjectedTools().find((candidate) => candidate.expose.mcp?.name === 'code:run')!;
    let clock = 0;
    const phases = createPhaseTracker({ now: () => clock });
    let releaseCapture!: () => void;
    let captureStarted!: () => void;
    const heldCapture = new Promise<void>((resolve) => { releaseCapture = resolve; });
    const started = new Promise<void>((resolve) => { captureStarted = resolve; });
    normalizeExecutionTraceMock.mockImplementationOnce(async () => {
      clock += 37;
      return normalizedTrace;
    });
    captureRecipeMock.mockImplementationOnce(async () => {
      captureStarted();
      await heldCapture;
      clock += 61;
      return null;
    });
    const pending = tool.fn({ script: 'return "private-phase-test-payload";' }, {
      log: () => {}, workspaceId: 'ws-test', harnessSlug: 'alpha', role: 'su',
      isSuperuser: true, uiClientId: 'su-test', phases,
    } as never);
    try {
      await started;
      expect(phases.snapshot().activePhase).toBe('code:run:postprocessing:recipe capture');
      expect(phases.intervals()).toContainEqual({
        phase: 'code:run:postprocessing:trace normalization', startMs: 0, durationMs: 37,
      });
    } finally {
      releaseCapture();
      await pending;
    }
    const metadata = phases.toMetadata()!;
    expect(metadata.phases).toContainEqual({
      phase: 'code:run:postprocessing:recipe capture', startMs: 37, durationMs: 61,
    });
    expect(metadata.phases.map(({ phase }) => phase)).toEqual(expect.arrayContaining([
      'code:run:setup', 'code:run:preflight', 'code:run:worker',
      'code:run:postprocessing:trace-only recording',
    ]));
    expect(metadata.pending).toEqual([]);
    expect(JSON.stringify(metadata)).not.toContain('private-phase-test-payload');
  });

  it('retains worker attribution for a failed script without reporting recipe capture', async () => {
    const tool = listAllProjectedTools().find((candidate) => candidate.expose.mcp?.name === 'code:run')!;
    const phases = createPhaseTracker();
    const result = await tool.fn({ script: 'throw new Error("phase-test-failure");' }, {
      log: () => {}, workspaceId: 'ws-test', harnessSlug: 'alpha', role: 'su',
      isSuperuser: true, uiClientId: 'su-test', phases,
    } as never);
    const payload = JSON.parse((result as { content: { text: string }[] }).content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('phase-test-failure');
    const metadata = phases.toMetadata()!;
    expect(metadata.phases.map(({ phase }) => phase)).toEqual(expect.arrayContaining([
      'code:run:preflight', 'code:run:worker', 'code:run:postprocessing:trace-only recording',
    ]));
    expect(metadata.phases.some(({ phase }) => phase === 'code:run:postprocessing:recipe capture')).toBe(false);
    expect(metadata.pending).toEqual([]);
  });

  it('caps optional postprocessing at five seconds and still respects the outer response deadline', () => {
    const nowMs = 1_000;
    expect(codeRunPostprocessingDeadlineAtMs(nowMs + 45_000, nowMs)).toBe(
      nowMs + CODE_RUN_POSTPROCESSING_BUDGET_MS,
    );
    expect(codeRunPostprocessingDeadlineAtMs(nowMs + 3_000, nowMs)).toBe(nowMs + 3_000);
  });

  it('degrades a never-settling optional leg at the shared five-second deadline', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const startedAtMs = Date.now();
      const pending = withCodeRunResponseBudget(
        () => new Promise<null>(() => {}),
        {
          deadlineAtMs: codeRunPostprocessingDeadlineAtMs(startedAtMs + 45_000, startedAtMs),
          fallback: null,
          label: 'recipe capture',
        },
      );
      let settled = false;
      void pending.then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(CODE_RUN_POSTPROCESSING_BUDGET_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ value: null, degraded: true, reason: 'timeout' });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('recipe capture'));
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it('returns at the shared absolute deadline when trace/record work never settles', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pending = withCodeRunResponseBudget(
        () => new Promise<null>(() => {}),
        { deadlineAtMs: Date.now() + 25, fallback: null, label: 'trace normalization' },
      );

      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toMatchObject({
        value: null,
        degraded: true,
        reason: 'timeout',
      });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('trace normalization'));
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not start another postprocessing leg after the response deadline', async () => {
    const work = vi.fn(async () => 'late');
    const result = await withCodeRunResponseBudget(work, {
      deadlineAtMs: Date.now() - 1,
      fallback: 'fallback',
      label: 'trace-only recording',
    });

    expect(result).toMatchObject({ value: 'fallback', degraded: true, reason: 'timeout' });
    expect(work).not.toHaveBeenCalled();
  });
});

/**
 * P-007 (agent-tooling-token-efficiency): a script that references an unknown tool fails the
 * parse-check AND gets the typed signatures handed back inline — so the agent fixes the name and
 * re-runs WITHOUT a separate code:tools discovery round-trip. Capture never fires on this path.
 */
describe('code:run → inline facade help on unknown refs (P-007)', () => {
  const codeRun = () => {
    const tool = listAllProjectedTools().find((t) => t.expose.mcp?.name === 'code:run');
    if (!tool) throw new Error('code:run not registered');
    return tool;
  };
  const mkCtx = () =>
    ({
      log: () => {},
      workspaceId: 'ws-test',
      harnessSlug: 'alpha',
      role: 'su',
      isSuperuser: true,
      uiClientId: 'su-test',
    }) as never;

  beforeEach(() => captureRecipeMock.mockClear());

  it('returns facadeHelp + a BOUNDED closest-namespace suggestion (not the full index) when a referenced namespace does not exist', async () => {
    const tool = codeRun();
    const res = await tool.fn({ script: 'return await tools.nope.doStuff();' }, mkCtx());
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.unknownRefs).toContain('nope.doStuff');
    expect(payload.facadeHelp).toBeDefined();
    // the note tells the agent it never needed code:tools first
    expect(payload.facadeHelp.note).toContain('no code:tools pre-call required');
    expect(payload.facadeHelp.note).toContain('code:tools {}');
    // an unknown namespace ⇒ a SUGGESTION is included, capped well below the full facade
    // (EI-7677: the full index was ~15k tokens and blew a session to 157% context on one typo)
    expect(Array.isArray(payload.facadeHelp.namespaces)).toBe(true);
    expect(payload.facadeHelp.namespaces.length).toBeGreaterThan(0);
    expect(payload.facadeHelp.namespaces.length).toBeLessThanOrEqual(3);
    // sanity: the full allowed facade for this role is much larger than the 3-item suggestion —
    // proves this is a bounded suggestion, not the whole catalog
    const allNamespaceCount = new Set(
      listAllProjectedTools()
        .map((t) => t.expose?.mcp?.name)
        .filter((n): n is string => !!n && n.includes(':'))
        .map((n) => n.split(':')[0]),
    ).size;
    expect(allNamespaceCount).toBeGreaterThan(payload.facadeHelp.namespaces.length);
    // nothing captured on a failed run
    expect(captureRecipeMock).not.toHaveBeenCalled();
  });

  it.each([
    ['code.run', 'return await tools.code.run({ script: "return 1;" });'],
    ['orchestrate.run', 'return await tools.orchestrate.run({});'],
  ])('explains why recursive execution ref %s is excluded', async (unknownRef, script) => {
    const res = await codeRun().fn({ script }, mkCtx());
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.unknownRefs).toContain(unknownRef);
    expect(payload.facadeHelp.note).toContain('deliberately excluded from this facade');
    expect(payload.facadeHelp.note).toContain('Keep the sequence in this outer script');
  });

  it.each(['workItems.notARealMethod', 'work_items.notARealMethod', 'work_items:notARealMethod'])(
    'returns typed signatures for an unknown member under the %s namespace spelling',
    (unknownRef) => {
      const tools = [
        {
          expose: { mcp: { name: 'work_items:list' } },
          description: 'List work items',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ] as never;
      const help = buildFacadeHelp([unknownRef], tools, new Set(['work_items:list']));

      expect(help.note).toContain('Typed signatures for the namespaces you referenced');
      expect(help.signatures).toContain('workItems: {');
      expect(help.namespaces).toBeUndefined();
    },
  );

  it('distinguishes the root tools.call helper from a missing call verb in the tools namespace', () => {
    const tools = [wiTool('tools:invoke', 'Dynamic tool dispatcher')] as never;
    const help = buildFacadeHelp(['tools.call'], tools, new Set(['tools:invoke']));

    expect(help.note).toContain('universal helper is on the ROOT object');
    expect(help.note).toContain('use `tools.call("ns:verb", args)`');
    expect(help.note).toContain('`tools.tools.call(...)` is a missing `call` verb');
    expect(help.note).toContain('`tools.tools.invoke({ name, args })`');
    expect(help.signatures).toContain('  call(toolName: string, args?: unknown): Promise<unknown>;');
    expect(help.signatures).toContain('invoke(args?: {}): Promise<unknown>;');
  });

  // EI-23783922587988483: EI-7677 bounded the unknown-NAMESPACE branch but left the unknown-VERB
  // branch (the far more common shape) rendering every signature in the namespace — measured 67,864
  // chars for ONE bad `work_items` ref, which overflows the per-result cap, spills to a scratch
  // file, and costs MORE context than the failed call would have.
  const wiTool = (name: string, desc: string) => ({
    expose: { mcp: { name } },
    description: desc,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  });
  const numberedVerb = (i: number) => `work_items:verb_${String(i).padStart(2, '0')}`;
  /** Count rendered `verb(args): Promise<…>` lines — doc-comment lines cannot match. */
  const renderedSignatureCount = (signatures: string | undefined) =>
    (signatures ?? '').match(/^\s{4}\w+\(/gm)?.length ?? 0;

  it('bounds the closest-VERB signatures for a KNOWN namespace instead of dumping it whole', () => {
    const names = [...Array.from({ length: 20 }, (_, i) => numberedVerb(i)), 'work_items:zzz_completely_unrelated'];
    const tools = names.map((n) => wiTool(n, `Desc ${n}`)) as never;
    const help = buildFacadeHelp(['work_items.verb_3'], tools, new Set(names));

    // only the closest handful get FULL signatures — the whole namespace would be 21
    const rendered = renderedSignatureCount(help.signatures);
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThanOrEqual(FACADE_HELP_VERB_SIGNATURES);
    expect(rendered).toBeLessThan(names.length);

    // the bound DEFERS arg types; it never HIDES a verb — every one is still named in `namespaces`
    expect(help.signatures).not.toContain('zzzCompletelyUnrelated(');
    const entry = help.namespaces?.find((e) => e.ns === 'workItems');
    expect(entry).toBeDefined();
    expect(entry!.verbs).toHaveLength(names.length);
    expect(entry!.verbs).toContain('zzzCompletelyUnrelated');

    // …and the note names the escape hatch that still yields the full dump on demand
    expect(help.note).toContain('CLOSEST');
    expect(help.note).toContain('code:tools { namespaces: ["workItems"] }');
  });

  it('still renders a SMALL known namespace whole (the bound is conditional, not blanket)', () => {
    const names = [0, 1, 2].map(numberedVerb);
    const tools = names.map((n) => wiTool(n, `Desc ${n}`)) as never;
    const help = buildFacadeHelp(['work_items.verb_99'], tools, new Set(names));

    expect(renderedSignatureCount(help.signatures)).toBe(names.length);
    expect(help.note).toContain('Typed signatures for the namespaces you referenced');
    expect(help.namespaces).toBeUndefined();
  });

  it('keeps ONE bad ref against the REAL catalog far below the unbounded whole-namespace dump', () => {
    const all = listAllProjectedTools();
    const byNs = new Map<string, string[]>();
    for (const t of all) {
      const name = t.expose?.mcp?.name;
      if (!name?.includes(':')) continue;
      byNs.set(name.split(':')[0]!, [...(byNs.get(name.split(':')[0]!) ?? []), name]);
    }
    const biggest = [...byNs.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    expect(biggest).toBeDefined();
    const [biggestNs, names] = biggest!;

    // A BARE `ns` ref has no verb to rank against, so it takes the render-whole path by design —
    // that makes it the unbounded CONTROL, measured here against real schemas.
    const whole = buildFacadeHelp([biggestNs], all, new Set(names));
    const bounded = buildFacadeHelp([`${biggestNs}.definitely_not_a_real_verb`], all, new Set(names));
    expect(renderedSignatureCount(whole.signatures)).toBe(names.length);

    // MEASURED SCOPE — this in-process catalog's LARGEST namespace is small (8 verbs when written),
    // because only the tools reachable from the imported barrel are registered here; the live
    // surface's `work_items` is several times larger and is where the 67,864 chars were measured.
    // So assert the CONDITIONAL contract and let the synthetic 21-verb case above own the
    // large-namespace proof, rather than pretend this context exercises it.
    // Whether bounding fired is READ FROM THE CONTROL, not from a re-encoded threshold — a
    // hand-copied constant here would silently drift from buildFacadeHelp's own.
    if (renderedSignatureCount(bounded.signatures) < names.length) {
      expect(renderedSignatureCount(bounded.signatures)).toBeLessThanOrEqual(FACADE_HELP_VERB_SIGNATURES);
      expect((bounded.signatures ?? '').length).toBeLessThan((whole.signatures ?? '').length);
      // the complete verb list must ride along, so the bound defers types without hiding a verb
      expect(bounded.namespaces?.length).toBeGreaterThan(0);
    } else {
      expect(renderedSignatureCount(bounded.signatures)).toBe(names.length);
      expect(bounded.namespaces).toBeUndefined();
    }
  });
});

/**
 * WI-1377: on a REAL (non-dryRun) code:run the effect:write calls already executed, so the full
 * `plannedMutations` args-echo is pure waste that overflows the 100k result cap on a large batch.
 * shapeMutationEcho swaps it for a compact { count, byTool } summary on a committing run, while
 * keeping the full preview under dryRun.
 */
/**
 * WI-1411 (fleet-backlog-lessons-2026-07-01 — THE ANCHOR): `dispatch-binding.ts`'s
 * `realDispatch(ctx, deps)` reuses ONE fixed ctx for every inner call a code:run
 * script makes, so a batch never got the per-call EI-30 workspace hop / tx /
 * principal / ALS binding a DIRECT (non-batch) MCP dispatch of the same tool
 * receives from `_mcp-handler.ts` — the reported "pgQuery / fleet:assignments
 * return EMPTY inside a code:run batch" symptom for an unscoped superuser
 * passing a per-call `{ workspace: 'X' }`. `bindInnerDispatch` closes that gap;
 * these pin its three branches directly (no live DB — the tx/principal/ALS
 * calls are spied per the mocks above).
 */
describe('code:run → per-inner-call workspace/identity rebinding (WI-1411)', () => {
  const readTool = {
    effect: 'read',
    needsWorkspaceTx: true,
    expose: { mcp: { name: 'fleet:assignments' } },
  } as never;
  const crossWorkspaceTool = {
    effect: 'read',
    crossWorkspace: true,
    needsWorkspaceTx: true,
    expose: { mcp: { name: 'papercusp:list_workspaces' } },
  } as never;
  const echoNext = async (callCtx: unknown) => callCtx;

  beforeEach(() => {
    withWorkspaceMock.mockClear();
    synthesizeDispatchPrincipalMock.mockClear();
    runWithWorkspaceIfConcreteMock.mockClear();
  });

  it('fast path: a concrete-workspace (bee) ctx with no per-call override dispatches under the SAME binding — zero extra tx', async () => {
    const outerCtx = {
      workspaceId: 'ws-bee',
      role: 'cup',
      isSuperuser: false,
      tx: 'OUTER_TX',
      principal: 'OUTER_PRINCIPAL',
    };
    const result = (await bindInnerDispatch(readTool, 'fleet:assignments', {}, outerCtx as never, echoNext)) as Record<
      string,
      unknown
    >;
    // The invariant is "no REBIND work" — the same tx/principal/workspace, and no
    // extra transaction or principal synthesis. It is deliberately NOT object
    // identity: EI-18719561823587590 makes every inner ctx a copy carrying
    // `transportCapExempt`, so an identity assertion here would pin the
    // allocation rather than the binding it stands for.
    expect(result.tx).toBe('OUTER_TX');
    expect(result.principal).toBe('OUTER_PRINCIPAL');
    expect(result.workspaceId).toBe('ws-bee');
    expect(withWorkspaceMock).not.toHaveBeenCalled();
    expect(synthesizeDispatchPrincipalMock).not.toHaveBeenCalled();
  });

  it('creates a per-inner transaction when code:run has opted out of its outer workspace tx', async () => {
    const outerCtx = { workspaceId: 'ws-bee', role: 'cup', isSuperuser: false };
    const result = (await bindInnerDispatch(readTool, 'fleet:assignments', {}, outerCtx as never, echoNext)) as {
      workspaceId: string;
      tx: unknown;
      principal: unknown;
    };
    expect(withWorkspaceMock).toHaveBeenCalledWith('ws-bee', expect.any(Function));
    expect(runWithWorkspaceIfConcreteMock).toHaveBeenCalledWith('ws-bee', expect.any(Function));
    expect(result.workspaceId).toBe('ws-bee');
    expect(result.tx).toEqual({ __tx: 'ws-bee' });
    expect(result.principal).toMatchObject({ workspaceId: 'ws-bee' });
  });

  it('synthesizes a principal but does not retain tx for a default transaction-free inner tool', async () => {
    const childTool = {
      effect: 'read',
      expose: { mcp: { name: 'capability:bash' } },
    };
    const outerCtx = { workspaceId: 'ws-bee', role: 'cup', isSuperuser: false };
    const result = (await bindInnerDispatch(
      childTool as never,
      'capability:bash',
      {},
      outerCtx as never,
      echoNext,
    )) as { workspaceId: string; tx?: unknown; principal: unknown };
    expect(result.workspaceId).toBe('ws-bee');
    expect(result.tx).toBeUndefined();
    expect(result.principal).toMatchObject({ workspaceId: 'ws-bee' });
  });

  it('EI-30 hop: an unscoped superuser ctx + a per-call { workspace } rebinds tx/principal/workspaceId to it', async () => {
    const outerCtx = { workspaceId: '*', role: 'su', isSuperuser: true };
    const result = (await bindInnerDispatch(
      readTool,
      'fleet:assignments',
      { workspace: 'ws-target' },
      outerCtx as never,
      echoNext,
    )) as { workspaceId: string; tx: unknown; principal: unknown };
    expect(withWorkspaceMock).toHaveBeenCalledWith('ws-target', expect.any(Function));
    expect(runWithWorkspaceIfConcreteMock).toHaveBeenCalledWith('ws-target', expect.any(Function));
    expect(result.workspaceId).toBe('ws-target'); // the empty-result bug: this used to stay '*'
    expect(result.tx).toEqual({ __tx: 'ws-target' });
    expect(synthesizeDispatchPrincipalMock).toHaveBeenCalledWith(
      { __tx: 'ws-target' },
      expect.objectContaining({ workspaceId: 'ws-target', role: 'su' }),
    );
  });

  it('an unscoped superuser ctx with NO per-call override stays unbound (documented EI-30 boundary, not this bug)', async () => {
    const outerCtx = { workspaceId: '*', role: 'su', isSuperuser: true };
    const result = (await bindInnerDispatch(readTool, 'fleet:assignments', {}, outerCtx as never, echoNext)) as {
      workspaceId: string;
    };
    expect(result.workspaceId).toBe('*'); // nothing to hop to — fast path, still unscoped
    expect(withWorkspaceMock).not.toHaveBeenCalled();
  });

  it('a crossWorkspace inner tool always gets the admin tx, regardless of role', async () => {
    const outerCtx = { workspaceId: 'ws-bee', role: 'cup', isSuperuser: false };
    const result = (await bindInnerDispatch(
      crossWorkspaceTool,
      'papercusp:list_workspaces',
      {},
      outerCtx as never,
      echoNext,
    )) as { workspaceId: string; tx: unknown };
    expect(result.tx).toBe(orgSqlMock);
    expect(result.workspaceId).toBe('ws-bee');
    expect(withWorkspaceMock).not.toHaveBeenCalled(); // admin path bypasses the app-role tx
  });
});

/**
 * EI-18699443874201617: an inner call a code:run script makes used to silently
 * inherit the OUTER session's `ctx.contextTier` (e.g. a trimmed/standard MCP
 * session), so a large nested field on an intermediate result (rubrics:get's
 * `criteria[]`) got shaped/truncated by applyPayloadTier with no error signal —
 * indistinguishable from a genuinely small result to the script's own `.length` /
 * `.filter()` read. bindInnerDispatch now forces `contextTier:'full'` and
 * `payloadTierOverride:'full'` on every inner call so it receives the same
 * lossless materialization as a direct tools:invoke call (a script can still
 * opt into a narrower tier for one call via that call's own `payloadTier` arg —
 * resolved independently downstream).
 */
describe('code:run → inner calls default to full payload tier (EI-18699443874201617)', () => {
  const readTool = {
    effect: 'read',
    needsWorkspaceTx: true,
    expose: { mcp: { name: 'fleet:assignments' } },
  } as never;
  const crossWorkspaceTool = {
    effect: 'read',
    crossWorkspace: true,
    needsWorkspaceTx: true,
    expose: { mcp: { name: 'papercusp:list_workspaces' } },
  } as never;
  const echoNext = async (callCtx: unknown) => callCtx;

  beforeEach(() => {
    withWorkspaceMock.mockClear();
    synthesizeDispatchPrincipalMock.mockClear();
    runWithWorkspaceIfConcreteMock.mockClear();
  });

  it('fast path: forces full contextTier over a trimmed outer tier', async () => {
    const outerCtx = {
      workspaceId: 'ws-bee',
      role: 'cup',
      isSuperuser: false,
      tx: 'OUTER_TX',
      principal: 'OUTER_PRINCIPAL',
      contextTier: 'trimmed',
    };
    const result = (await bindInnerDispatch(readTool, 'fleet:assignments', {}, outerCtx as never, echoNext)) as {
      contextTier?: string;
    };
    expect(result).not.toBe(outerCtx); // a new ctx object — the tier was overridden
    expect(result.contextTier).toBe('full');
  });

  it('fast path: a ctx with no contextTier at all still dispatches under the same binding (no needless rebind)', async () => {
    const outerCtx = {
      workspaceId: 'ws-bee',
      role: 'cup',
      isSuperuser: false,
      tx: 'OUTER_TX',
      principal: 'OUTER_PRINCIPAL',
    };
    const result = (await bindInnerDispatch(readTool, 'fleet:assignments', {}, outerCtx as never, echoNext)) as {
      workspaceId: string;
      contextTier?: string;
    };
    expect(result.workspaceId).toBe('ws-bee');
    expect(result.contextTier).toBe('full');
    expect(withWorkspaceMock).not.toHaveBeenCalled();
    expect(synthesizeDispatchPrincipalMock).not.toHaveBeenCalled();
  });

  it('EI-30 hop: strips contextTier on the rebound ctx too', async () => {
    const outerCtx = { workspaceId: '*', role: 'su', isSuperuser: true, contextTier: 'standard' };
    const result = (await bindInnerDispatch(
      readTool,
      'fleet:assignments',
      { workspace: 'ws-target' },
      outerCtx as never,
      echoNext,
    )) as { contextTier?: string; workspaceId: string };
    expect(result.workspaceId).toBe('ws-target');
    expect(result.contextTier).toBe('full');
  });

  it('crossWorkspace path: strips contextTier on the admin-tx ctx too', async () => {
    const outerCtx = { workspaceId: 'ws-bee', role: 'cup', isSuperuser: false, contextTier: 'trimmed' };
    const result = (await bindInnerDispatch(
      crossWorkspaceTool,
      'papercusp:list_workspaces',
      {},
      outerCtx as never,
      echoNext,
    )) as { contextTier?: string };
    expect(result.contextTier).toBe('full');
  });
});

/**
 * EI-18719561823587590: clearing `contextTier` (the EI-18699443874201617 fix above)
 * only skips applyPayloadTier's STEP 1 tier shaping. Its STEP 2 HARD CEILING
 * force-shapes any result over PAYLOAD_TIER_HARD_CEILING_CHARS regardless of the
 * resolved tier, and its only exit is `explicitFullRequest`. So an inner result
 * that merely ran LARGE was still silently row-truncated, and a script's
 * `.filter()`/`.find()` over it searched a subset — a miss indistinguishable from
 * real absence (measured on facts:list: 40 rows in, 8 rows visible to the script,
 * the searched-for key among the 32 dropped). Because survival depends on ROW
 * SIZE, the same script was correct on small data and silently wrong on large.
 *
 * bindInnerDispatch now marks every inner ctx `transportCapExempt` — the inner
 * result never crosses the agent-facing transport (only the script's own returned
 * value does, and that is shaped by the OUTER code:run call).
 */
describe('code:run → inner calls are exempt from the transport hard ceiling (EI-18719561823587590)', () => {
  const readTool = {
    effect: 'read',
    needsWorkspaceTx: true,
    expose: { mcp: { name: 'facts:list' } },
  } as never;
  const crossWorkspaceTool = {
    effect: 'read',
    crossWorkspace: true,
    needsWorkspaceTx: true,
    expose: { mcp: { name: 'papercusp:list_workspaces' } },
  } as never;
  const echoNext = async (callCtx: unknown) => callCtx;

  it('fast path: marks the inner ctx transportCapExempt', async () => {
    const outerCtx = { workspaceId: 'ws-bee', role: 'cup', isSuperuser: false, tx: 'OUTER_TX' };
    const result = (await bindInnerDispatch(readTool, 'facts:list', {}, outerCtx as never, echoNext)) as {
      transportCapExempt?: boolean;
    };
    expect(result.transportCapExempt).toBe(true);
  });

  it('EI-30 hop: marks the rebound ctx transportCapExempt too', async () => {
    const outerCtx = { workspaceId: '*', role: 'su', isSuperuser: true };
    const result = (await bindInnerDispatch(
      readTool,
      'facts:list',
      { workspace: 'ws-target' },
      outerCtx as never,
      echoNext,
    )) as { transportCapExempt?: boolean; workspaceId: string };
    expect(result.workspaceId).toBe('ws-target');
    expect(result.transportCapExempt).toBe(true);
  });

  it('crossWorkspace path: marks the admin-tx ctx transportCapExempt too', async () => {
    const outerCtx = { workspaceId: 'ws-bee', role: 'cup', isSuperuser: false };
    const result = (await bindInnerDispatch(
      crossWorkspaceTool,
      'papercusp:list_workspaces',
      {},
      outerCtx as never,
      echoNext,
    )) as { transportCapExempt?: boolean };
    expect(result.transportCapExempt).toBe(true);
  });

  /**
   * The containment half, and the reason this is safe: the exemption must ride
   * ONLY the inner call. The OUTER code:run result DOES cross the transport, so
   * leaking the flag onto the caller's own ctx would uncap it — turning a
   * silent-truncation bug into an over-cap transport failure. Pinned because the
   * pre-fix code reused the outer ctx object verbatim on the fast path, where an
   * in-place mutation would have been the obvious (and wrong) way to set this.
   */
  it('never mutates the OUTER ctx — the caller-facing result stays capped', async () => {
    const outerCtx = { workspaceId: 'ws-bee', role: 'cup', isSuperuser: false, contextTier: 'trimmed' };
    await bindInnerDispatch(readTool, 'facts:list', {}, outerCtx as never, echoNext);
    expect((outerCtx as Record<string, unknown>).transportCapExempt).toBeUndefined();
    expect(outerCtx.contextTier).toBe('trimmed'); // the outer session's own tier is untouched
  });
});

// OrchestrateResult.runtimeObservations is REQUIRED on purpose, unlike every optional field
// beside it: it carries independent runtime evidence (authorizationObservationCount,
// authorityWideningDetected) that is never derived from the script's return value. A fixture
// must therefore STATE "nothing was observed" rather than omit the field — an omitted value
// reads as `undefined` → falsy → "no authority widening detected", which is exactly the silent
// false-negative the required field exists to prevent. Kept local to the test files on purpose:
// exporting a shared zero-value from production code would hand every real caller a way to
// satisfy the type without producing any actual evidence.
const NO_RUNTIME_OBSERVATIONS = {
  authorizationObservationCount: 0,
  authorityWideningDetected: false,
  midTurnPromptInjectionObservability: 'not-observable',
} as const;

describe('code:run → mutation echo shaping (WI-1377)', () => {
  const base = {
    ok: true as const,
    summary: { done: true },
    logs: [] as string[],
    runtimeObservations: NO_RUNTIME_OBSERVATIONS,
  };

  it('summarizes plannedMutations on a committing run (no full-args echo, so a big batch fits the cap)', () => {
    const shaped = shapeMutationEcho({
      ...base,
      dryRun: false,
      plannedMutations: [
        { tool: 'work_items:set_priority', args: { id: 'WI-1', priority: 1 } },
        { tool: 'work_items:set_priority', args: { id: 'WI-2', priority: 2 } },
        { tool: 'plans:set-now', args: { slug: 's', state: 'x' } },
      ],
    }) as Record<string, unknown>;
    // the full args echo is GONE (it is what overflowed the result cap)
    expect(shaped.plannedMutations).toBeUndefined();
    // replaced by a compact, bounded summary
    expect(shaped.mutations).toEqual({
      count: 3,
      byTool: { 'work_items:set_priority': 2, 'plans:set-now': 1 },
      note: expect.stringContaining('dryRun:true'),
    });
    // the script's own return value + ok survive untouched
    expect(shaped.ok).toBe(true);
    expect(shaped.summary).toEqual({ done: true });
  });

  it('keeps the full plannedMutations echo under dryRun when the preview is still bounded', () => {
    const pm = [{ tool: 'plans:set-now', args: { slug: 's', state: 'x' } }];
    const shaped = shapeMutationEcho({ ...base, dryRun: true, plannedMutations: pm }) as Record<string, unknown>;
    expect(shaped.plannedMutations).toEqual(pm);
    expect(shaped.mutations).toBeUndefined();
  });

  it('summarizes a large dryRun preview so the plan stays reviewable instead of truncating', () => {
    const pm = Array.from({ length: 160 }, (_, i) => ({
      tool: i % 2 === 0 ? 'work_items:set_priority' : 'plans:set-now',
      args: {
        id: `WI-${i}`,
        priority: i,
        detail: 'x'.repeat(220),
      },
    }));
    const shaped = shapeMutationEcho({ ...base, dryRun: true, plannedMutations: pm }) as Record<string, unknown>;
    expect(shaped.plannedMutations).toBeUndefined();
    expect(shaped.mutations).toEqual({
      dryRunPreview: true,
      count: 160,
      byTool: { 'work_items:set_priority': 80, 'plans:set-now': 80 },
      sample: expect.arrayContaining([
        expect.objectContaining({ tool: 'work_items:set_priority' }),
        expect.objectContaining({ tool: 'plans:set-now' }),
      ]),
      sampleOmittedCount: expect.any(Number),
      note: expect.stringContaining('reviewable'),
    });
    expect((shaped.mutations as { sample: unknown[] }).sample.length).toBeLessThan(pm.length);
  });

  it('leaves a read-only (no-write) committing run unchanged (already tiny)', () => {
    const r = { ...base, dryRun: false, plannedMutations: [] as { tool: string; args: unknown }[] };
    const shaped = shapeMutationEcho(r);
    expect(shaped).toBe(r); // same reference — nothing to summarize
    expect((shaped as Record<string, unknown>).mutations).toBeUndefined();
  });

  // EI-7174: a script_timeout (or any other ok:false) does not undo write-effect calls the
  // script already dispatched — dispatch() invokes the real tool immediately, timeout or not.
  // A prominent top-level `warning` (not just the easy-to-miss mutations.note) stops an agent
  // from blindly retrying the whole script and double-writing.
  it('ok:false with mutations already dispatched (e.g. script_timeout) surfaces a prominent top-level warning', () => {
    const shaped = shapeMutationEcho({
      ok: false,
      error: 'script_timeout after 30000ms',
      logs: [],
      dryRun: false,
      runtimeObservations: NO_RUNTIME_OBSERVATIONS,
      plannedMutations: [
        { tool: 'work_items:claim', args: { id: 'WI-1' } },
        { tool: 'work_items:set_state', args: { id: 'WI-1', state: 'in_progress' } },
      ],
    }) as Record<string, unknown>;
    expect(shaped.ok).toBe(false);
    expect(shaped.error).toBe('script_timeout after 30000ms');
    expect(shaped.mutations).toMatchObject({ count: 2, byTool: { 'work_items:claim': 1, 'work_items:set_state': 1 } });
    expect(shaped.warning).toEqual(expect.stringContaining('2 write-effect call(s) already executed'));
    expect(shaped.warning).toEqual(expect.stringContaining('double-write'));
  });

  it('timeout accounting reports the exact settled prefix and never labels an in-flight write as landed', () => {
    const shaped = shapeMutationEcho({
      ok: false,
      error: 'script_timeout after 30000ms',
      logs: [],
      dryRun: false,
      runtimeObservations: NO_RUNTIME_OBSERVATIONS,
      plannedMutations: [
        { tool: 'coord:send', args: { to: ['agent-1'] } },
        { tool: 'coord:send', args: { to: ['agent-2'] } },
      ],
      writeAttempts: [
        { index: 0, tool: 'coord:send', disposition: 'settled' },
        { index: 1, tool: 'coord:send', disposition: 'in_flight' },
      ],
    }) as Record<string, unknown>;

    expect(shaped.mutations).toMatchObject({
      count: 1,
      byTool: { 'coord:send': 1 },
      attemptedCount: 2,
      settledPrefixCount: 1,
      inFlightCount: 1,
      dispositions: { settled: [0], in_flight: [1] },
    });
    expect(shaped.warning).toEqual(expect.stringContaining('1 write-effect call(s) already executed'));
    expect(shaped.warning).toEqual(expect.stringContaining('1 still IN FLIGHT'));
    expect(shaped.warning).toEqual(expect.stringContaining('may settle later'));
  });

  it('keeps child dry-run previews out of applied mutation counts and names their disposition', () => {
    const shaped = shapeMutationEcho({
      ok: true,
      logs: [],
      dryRun: false,
      runtimeObservations: NO_RUNTIME_OBSERVATIONS,
      plannedMutations: [{ tool: 'rubrics:amend', args: { rubricRef: 'bar', dryRun: true } }],
      writeAttempts: [{ index: 0, tool: 'rubrics:amend', disposition: 'preview' }],
    }) as Record<string, unknown>;

    expect(shaped.mutations).toMatchObject({
      count: 0,
      byTool: {},
      attemptedCount: 1,
      settledPrefixCount: 0,
      previewCount: 1,
      previewByTool: { 'rubrics:amend': 1 },
      dispositions: { preview: [0] },
    });
    expect(shaped.warning).toBeUndefined();
  });

  it('ok:false with NO mutations dispatched carries no warning (nothing to guard against)', () => {
    const shaped = shapeMutationEcho({
      ok: false,
      error: 'some thrown error',
      logs: [],
      dryRun: false,
      runtimeObservations: NO_RUNTIME_OBSERVATIONS,
      plannedMutations: [],
    }) as Record<string, unknown>;
    expect(shaped.warning).toBeUndefined();
  });

  it('ok:true (a normal successful run with mutations) carries no spurious warning', () => {
    const shaped = shapeMutationEcho({
      ...base,
      dryRun: false,
      plannedMutations: [{ tool: 'work_items:claim', args: { id: 'WI-1' } }],
    }) as Record<string, unknown>;
    expect(shaped.warning).toBeUndefined();
  });

  // EI-7784: `ok:true` alone is misleading when a write-effect call dispatched without throwing
  // but reported its own ok:false. Its error result may describe only the last stage of a
  // multi-operation write, so the warning must preserve uncertainty about earlier effects.
  it('ok:true with an okFalse mutation carries partial:true + an effect-uncertainty warning naming the tool', () => {
    const okFalseResult = {
      ok: false,
      error: 'later command failed',
      partial: true,
      mutations: { count: 2, byTool: { 'capability:bash': 2 } },
    };
    const shaped = shapeMutationEcho({
      ...base,
      dryRun: false,
      partial: true,
      plannedMutations: [{ tool: 'work_items:set_state', args: { id: 'WI-1', state: 'resolved' } }],
      okFalseMutations: [
        { tool: 'work_items:set_state', args: { id: 'WI-1', state: 'resolved' }, result: okFalseResult },
      ],
    }) as Record<string, unknown>;
    expect(shaped.ok).toBe(true); // the script itself completed — this is exactly the misleading bit
    expect(shaped.partial).toBe(true);
    expect(shaped.okFalseWarning).toEqual(expect.stringContaining('work_items:set_state'));
    expect(shaped.okFalseWarning).toEqual(expect.stringContaining('reported ok:false'));
    expect(shaped.okFalseWarning).toEqual(expect.stringContaining('effects may be partial or absent'));
    expect(shaped.okFalseWarning).toEqual(expect.stringContaining('verify their effects before retrying'));
    expect(shaped.okFalseWarning).not.toEqual(expect.stringContaining('did NOT take effect'));
    expect(shaped.okFalseMutations).toEqual([
      { tool: 'work_items:set_state', args: { id: 'WI-1', state: 'resolved' }, result: okFalseResult },
    ]);
  });

  it('a hand-built fixture predating okFalseMutations (field absent) never throws — defaults to no warning', () => {
    const shaped = shapeMutationEcho({
      ...base,
      dryRun: false,
      plannedMutations: [{ tool: 'work_items:claim', args: { id: 'WI-1' } }],
      // okFalseMutations deliberately omitted — pre-EI-7669 fixture shape.
    }) as Record<string, unknown>;
    expect(shaped.okFalseWarning).toBeUndefined();
    expect(shaped.okFalseMutations).toBeUndefined();
  });
});

// WI-7061: `ok:true` on the envelope means "the script executed", but every caller reads it as
// "the work succeeded". EI-7669/EI-7784 closed that for WRITE-effect calls (okFalseMutations +
// okFalseWarning). A READ-effect call that reports its own `ok:false` was left with NO naming
// signal at all, for two compounding reasons:
//
//   1. the warning is built ONLY from okFalseMutations, and orchestrate.ts populates that list
//      `if (tool.effect === 'write')` — so a failed read is never in it; and
//   2. shapeMutationEcho early-returns on `plannedMutations.length === 0`, so a script that made
//      NO writes at all never even reaches the warning block.
//
// Detection itself was already general — orchestrate.ts pushes EVERY semantically-failed child
// (read or write) into `childFailures` and sets `partial: true` off it. So the caller was handed
// `ok:true, partial:true` and a childFailures array, with nothing saying WHAT failed in prose.
// That is the actual gap, and it is narrower than "code:run has no nested-failure detection":
// the signal existed, the human-readable pointer to it did not.
describe('annotateChildFailureWarning — a failed READ-effect child call is named too (WI-7061)', () => {
  const base = {
    ok: true as const,
    summary: { done: true },
    logs: [] as string[],
    dryRun: false,
    runtimeObservations: NO_RUNTIME_OBSERVATIONS,
  };

  it('⭐ names a failed read-effect call even when the script made NO writes at all', () => {
    // The exact shape that used to slip through: zero plannedMutations (so the mutation-echo
    // path early-returns) and a read tool that resolved with its own ok:false.
    const annotated = annotateChildFailureWarning({
      ...base,
      partial: true,
      plannedMutations: [],
      okFalseMutations: [],
      childFailures: [{ tool: 'work_items:get', kind: 'semantic', result: { ok: false, error: 'not_found' } }],
    }) as Record<string, unknown>;

    expect(annotated.ok).toBe(true); // still true — the script did run. This is the misleading bit.
    expect(annotated.partial).toBe(true);
    expect(annotated.childFailureWarning).toEqual(expect.stringContaining('work_items:get'));
    expect(annotated.childFailureWarning).toEqual(expect.stringContaining('ok:false'));

    // THE GAP, pinned permanently rather than as a transient red: the mutation-echo path alone
    // cannot produce this warning for the same input — `plannedMutations.length === 0` makes it
    // return untouched. If someone later "simplifies" by folding the annotation back into
    // shapeMutationEcho, this assertion fails and says why.
    const echoOnly = shapeMutationEcho({
      ...base,
      partial: true,
      plannedMutations: [],
      okFalseMutations: [],
      childFailures: [{ tool: 'work_items:get', kind: 'semantic', result: { ok: false, error: 'not_found' } }],
    }) as Record<string, unknown>;
    expect(echoOnly.childFailureWarning).toBeUndefined();
    expect(echoOnly.okFalseWarning).toBeUndefined();
  });

  it('does NOT duplicate a write failure okFalseWarning already names', () => {
    // The negative control that keeps the two fields complementary rather than redundant: a
    // write failure is already covered in prose by okFalseWarning, so naming it again here
    // would just add noise to the result an agent has to read.
    const annotated = annotateChildFailureWarning({
      ...base,
      partial: true,
      plannedMutations: [{ tool: 'coord:send', args: { to: ['nobody'] } }],
      okFalseMutations: [
        { tool: 'coord:send', args: { to: ['nobody'] }, result: { ok: false, error: 'unknown_recipient' } },
      ],
      childFailures: [{ tool: 'coord:send', kind: 'semantic', result: { ok: false, error: 'unknown_recipient' } }],
    }) as Record<string, unknown>;

    expect(annotated.childFailureWarning).toBeUndefined();
  });

  it('names ONLY the read failures when a script mixed a failed read with a failed write', () => {
    const annotated = annotateChildFailureWarning({
      ...base,
      partial: true,
      plannedMutations: [{ tool: 'coord:send', args: { to: ['nobody'] } }],
      okFalseMutations: [
        { tool: 'coord:send', args: { to: ['nobody'] }, result: { ok: false, error: 'unknown_recipient' } },
      ],
      childFailures: [
        { tool: 'coord:send', kind: 'semantic', result: { ok: false, error: 'unknown_recipient' } },
        { tool: 'plans:get', kind: 'semantic', result: { ok: false, error: 'not_found' } },
      ],
    }) as Record<string, unknown>;

    expect(annotated.childFailureWarning).toEqual(expect.stringContaining('plans:get'));
    expect(annotated.childFailureWarning).not.toEqual(expect.stringContaining('coord:send'));
  });

  it('is a no-op on a clean run, and on a fixture with no childFailures field at all', () => {
    const clean = annotateChildFailureWarning({
      ...base,
      plannedMutations: [],
      childFailures: [],
    }) as Record<string, unknown>;
    expect(clean.childFailureWarning).toBeUndefined();

    // Defensive: hand-built/older fixtures omit childFailures entirely — must not throw.
    const legacy = annotateChildFailureWarning({
      ...base,
      plannedMutations: [],
    } as never) as Record<string, unknown>;
    expect(legacy.childFailureWarning).toBeUndefined();
  });

  it('does not fire for a THROWN child (rejected/uncertain) — those have their own warnings', () => {
    // buildFailureWarning already covers the throw path with double-write semantics; naming
    // them here too would contradict it (a rejected call provably wrote nothing).
    const annotated = annotateChildFailureWarning({
      ...base,
      ok: false as unknown as true,
      plannedMutations: [],
      childFailures: [
        { tool: 'work_items:claim', kind: 'rejected', error: 'bad args' },
        { tool: 'work_items:claim', kind: 'uncertain', error: 'timeout' },
      ],
    }) as Record<string, unknown>;
    expect(annotated.childFailureWarning).toBeUndefined();
  });
});

describe('annotatePublicCodeRunStatus — child WRITE failures make the public envelope unsuccessful', () => {
  const base = {
    ok: true as const,
    summary: { done: true },
    logs: [] as string[],
    dryRun: false,
    plannedMutations: [{ tool: 'routines:set', args: { active: false } }],
    runtimeObservations: NO_RUNTIME_OBSERVATIONS,
  };

  it('flips ok:false for a pre-dispatch rejected write and preserves the rejection evidence', () => {
    const rejected = { tool: 'routines:set', args: { active: false }, error: 'reason too long' };
    const projected = annotatePublicCodeRunStatus({
      ...base,
      rejectedMutations: [rejected],
    }) as Record<string, unknown>;

    expect(projected.ok).toBe(false);
    expect(projected.error).toEqual(expect.stringContaining('child write failure'));
    expect(projected.error).toEqual(expect.stringContaining('rejected before execution'));
    expect(projected.rejectedMutations).toEqual([rejected]);

    // The real response path shapes mutation evidence after status projection, moving rejected
    // calls under `mutations.rejected`; the public failure must survive that shaping boundary.
    const shaped = shapeMutationEcho(projected as never) as Record<string, unknown>;
    expect(shaped.ok).toBe(false);
    expect(shaped.mutations).toMatchObject({ rejectedCount: 1 });
  });

  it('flips ok:false for a dispatched write whose own result is ok:false', () => {
    const failed = {
      tool: 'routines:set',
      args: { active: false },
      result: { ok: false, error: 'completion_integrity_required' },
    };
    const projected = annotatePublicCodeRunStatus({
      ...base,
      okFalseMutations: [failed],
    }) as Record<string, unknown>;

    expect(projected.ok).toBe(false);
    expect(projected.error).toEqual(expect.stringContaining('returned ok:false'));
    expect(projected.okFalseMutations).toEqual([failed]);
  });

  it('leaves read-only semantic diagnostics unchanged', () => {
    const readFailure = {
      tool: 'routines:list',
      kind: 'semantic',
      result: { ok: false, error: 'not_found' },
    };
    const input = {
      ...base,
      plannedMutations: [],
      partial: true,
      childFailures: [readFailure],
    };
    const projected = annotatePublicCodeRunStatus(input) as Record<string, unknown>;

    expect(projected).toBe(input);
    expect(projected.ok).toBe(true);
    expect(projected.error).toBeUndefined();
    expect(projected.childFailures).toEqual([readFailure]);
  });
});

describe('code:run → log shaping (WI-3127)', () => {
  const base = { ok: true as const, summary: { done: true }, dryRun: false, plannedMutations: [] as unknown[] };

  it('strips terminal escapes/control characters while preserving the script summary', () => {
    const shaped = shapeCodeRunLogs({
      ...base,
      logs: ['start \u001b[31mred\u001b[0m \u0007 \nnext'],
    }) as Record<string, unknown>;
    expect(shaped.summary).toEqual({ done: true });
    expect(shaped.logs).toEqual(['start red   next']);
    expect(shaped.logsNotice).toMatchObject({
      rawCount: 1,
      shownCount: 1,
      sanitizedLines: 1,
      truncatedLines: 0,
      droppedAfterLimit: 0,
    });
  });

  it('collapses adjacent duplicate lines, truncates oversized lines, and caps the shown log list', () => {
    const logs = ['same', 'same', 'x'.repeat(1_010), ...Array.from({ length: 90 }, (_, i) => `unique-${i}`)];
    const shaped = shapeCodeRunLogs({
      ...base,
      logs,
    }) as unknown as { logs: string[]; logsNotice: Record<string, unknown> };
    expect(shaped.logs).toContain('[previous code:run log line repeated 1 more time]');
    expect(shaped.logs.some((line) => line.includes('[truncated 10 chars]'))).toBe(true);
    expect(shaped.logs.length).toBe(80);
    expect(shaped.logsNotice).toMatchObject({
      rawCount: 93,
      shownCount: 80,
      adjacentDuplicatesCollapsed: 1,
      truncatedLines: 1,
      droppedAfterLimit: 13,
      textTruncated: true,
    });
  });

  it('leaves already-small clean logs unchanged', () => {
    const r = { ...base, logs: ['one', 'two'] };
    expect(shapeCodeRunLogs(r)).toBe(r);
  });
});
