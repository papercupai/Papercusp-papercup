/**
 * P-012 (census double-count): code:run marks its OWN telemetry row as a dispatch
 * wrapper — but ONLY when the script actually dispatched inner tools (each of which
 * wrote its own row). A pure-compute run stays countable.
 *
 * Lives apart from run.test.ts because the orchestrator is MOCKED here: driving the
 * >0 branch through a real inner dispatch needs the full projected registry + deps,
 * while the branch under test keys purely off the orchestrator's dispatchCount
 * (whose own counting is proven in tooldef's orchestrate.test.ts). run.test.ts's
 * sibling tests need the REAL orchestrator, and vi.mock is file-global.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listAllProjectedTools } from '@papercusp/agent-mcp';

const { captureRecipeMock } = vi.hoisted(() => ({
  captureRecipeMock: vi.fn(async () => null),
}));
vi.mock('./capture-recipe', () => ({
  captureRecipe: captureRecipeMock,
}));
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

// The orchestrator itself is mocked — the branch under test keys off dispatchCount.
const { runToolOrchestrationMock } = vi.hoisted(() => ({
  runToolOrchestrationMock: vi.fn(),
}));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runToolOrchestration: runToolOrchestrationMock,
}));

// Flag defaults ON here (the shipped default); the kill-switch case flips it off.
vi.mock('../../telemetry-dispatch-wrapper', () => ({
  dispatchWrapperMarkEnabled: vi.fn(async () => true),
}));
import { dispatchWrapperMarkEnabled } from '../../telemetry-dispatch-wrapper';

import './run'; // registers code:run (after the mocks are hoisted)

const markEnabledMock = vi.mocked(dispatchWrapperMarkEnabled);

const orchestration = (over: Record<string, unknown>) => ({
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
const mkCtx = (metadata: ReturnType<typeof vi.fn>) =>
  ({
    log: () => {},
    metadata,
    workspaceId: 'ws-test',
    harnessSlug: 'alpha',
    role: 'su',
    isSuperuser: true,
    uiClientId: 'su-test',
  }) as never;

describe('code:run dispatch-wrapper mark (P-012)', () => {
  beforeEach(() => {
    runToolOrchestrationMock.mockReset();
    markEnabledMock.mockClear();
    markEnabledMock.mockResolvedValue(true);
  });

  it('a run that dispatched inner tools marks its row with the dispatch count', async () => {
    runToolOrchestrationMock.mockResolvedValueOnce(orchestration({ dispatchCount: 3 }));
    const metadata = vi.fn();
    await codeRun().fn({ script: 'return 1;' }, mkCtx(metadata));
    expect(metadata).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchWrapper: true, dispatchedToolCalls: 3 }),
    );
  });

  it('a pure-compute run (dispatchCount 0) is NOT marked — its row stays countable', async () => {
    runToolOrchestrationMock.mockResolvedValueOnce(orchestration({ dispatchCount: 0 }));
    const metadata = vi.fn();
    await codeRun().fn({ script: 'return 1;' }, mkCtx(metadata));
    const stamped = metadata.mock.calls[0][0] as Record<string, unknown>;
    expect(stamped).not.toHaveProperty('dispatchWrapper');
    expect(stamped).not.toHaveProperty('dispatchedToolCalls');
  });

  it('a legacy orchestration result with NO dispatchCount field is not marked (never guess)', async () => {
    const legacy = orchestration({});
    delete (legacy as Record<string, unknown>).dispatchCount;
    runToolOrchestrationMock.mockResolvedValueOnce(legacy);
    const metadata = vi.fn();
    await codeRun().fn({ script: 'return 1;' }, mkCtx(metadata));
    expect(metadata.mock.calls[0][0]).not.toHaveProperty('dispatchWrapper');
  });

  it('flag OFF (the kill-switch / control): dispatches happened but nothing is marked', async () => {
    markEnabledMock.mockResolvedValue(false);
    runToolOrchestrationMock.mockResolvedValueOnce(orchestration({ dispatchCount: 5 }));
    const metadata = vi.fn();
    await codeRun().fn({ script: 'return 1;' }, mkCtx(metadata));
    expect(metadata.mock.calls[0][0]).not.toHaveProperty('dispatchWrapper');
  });
});

describe('code:run late completion receipt (EI-25216756674045452)', () => {
  const resolveReceipt = (payload: unknown) => {
    const resolver = codeRun().abortCompletionReceipt;
    if (!resolver) throw new Error('code:run has no abort completion receipt');
    return resolver(
      { script: 'return { ok: true };' },
      { content: [{ type: 'text', text: JSON.stringify(payload) }] },
      { callId: 'attempt-123', toolName: 'code:run' },
    );
  };

  it('identifies a completed attempt while preserving partial-effect details', () => {
    expect(resolveReceipt({
      ok: true,
      partial: true,
      mutations: { count: 1, byTool: { 'work_items:create': 1 }, inFlightCount: 0 },
    })).toMatchObject({
      status: 'recorded',
      effectRef: 'code-run:attempt-123',
      reason: expect.stringContaining('partial inner-effect details'),
    });
  });

  it('fails closed when the returned payload does not confirm successful completion', () => {
    expect(resolveReceipt({ ok: false, error: 'script failed' })).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-successful-run-result'],
    });
  });
});
