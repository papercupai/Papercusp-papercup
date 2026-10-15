/**
 * Route-level tests for the P-008 OWNED-loop engine lane
 * (own-tui-full-divorce-2026-08-24, D-008/D-009 native session protocol):
 *
 *   POST /harness/:slug/agent-chats/:chatId/messages  { engine: 'loop' }
 *   GET  /harness/:slug/agent-chats/:chatId/approvals
 *   POST /harness/:slug/agent-chats/:chatId/approvals/:callId
 *
 * Engine + approval store are mocked (their own suites cover them); these
 * tests pin the ROUTE contract: lane selection, the systemText/transcript
 * handed to the engine, SSE close, transcript persistence of the loop
 * result, and the approval routes' status mapping.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProjectedTool } from '@papercusp/tooldef';
import type { RouteContext, RouteDefinition } from '../define-route';

// The first case owns the cold mocked dynamic import/transform for this very
// large route graph. Keep the OUTER harness budget separate from the behavior
// detector: every stream assertion still uses drainSse(..., 8_000), so a route
// that does not close fails in 8s rather than being hidden by this headroom.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 15_000 });

vi.mock('../../agent-chat-lock', () => ({
  AGENT_CHAT_LOCK_TTL_MS: 10 * 60_000,
  acquireAgentChatLock: async (chatId: string) => ({ chatId, token: 'test-lock-token' }),
  releaseAgentChatLock: async () => {},
  isAgentChatLocked: async () => false,
  __resetAgentChatLocks: async () => {},
}));

async function drainSse(
  body: ReadableStream<Uint8Array> | null,
  maxMs: number,
): Promise<{ text: string; closed: boolean }> {
  if (!body) return { text: '', closed: false };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + maxMs;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { text, closed: false };
      const step = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), remaining)),
      ]);
      if (step === 'timeout') return { text, closed: false };
      if (step.done) return { text, closed: true };
      text += decoder.decode(step.value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

const SLUG = 'test-harness';
const CHAT = 'CHAT-L1';

const baseRow = {
  id: CHAT,
  role: 'worker',
  feature_id: null,
  archived_at: null,
  transcript: [] as unknown[],
  total_cost_usd_cents: 0,
  total_input_tokens: 0,
  total_output_tokens: 0,
};

function ctxFor(chatId: string, extra: Record<string, string> = {}): RouteContext {
  return {
    principal: null,
    input: undefined,
    params: { slug: SLUG, chatId, ...extra },
    log: () => {},
    signal: new AbortController().signal,
  };
}

function postReq(body: unknown): Request {
  return new Request('http://localhost/api/harness/x/agent-chats/x/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function fakeProjected(name: string): ProjectedTool {
  return {
    pluginName: 'route-test',
    description: `desc of ${name}`,
    inputSchema: { type: 'object', properties: {} },
    needsWorkspaceTx: name.startsWith('tasks:'),
    expose: { mcp: { name } },
  } as unknown as ProjectedTool;
}

const ROUTE_TOOL_REGISTRY = [
  fakeProjected('capability:read'),
  fakeProjected('capability:bash'),
  fakeProjected('tasks:ops'),
  fakeProjected('tasks:todo_write'),
  fakeProjected('tasks:update_plan'),
];
const ROUTE_WORKSPACE_TX = { transaction: 'route-test' };

const MOCKED_MODULES = [
  '../../agent-tools',
  '../../workspace-registry',
  '../../memory/injection',
  '../../harness-registry',
  '../../operator-notes',
  '@papercusp/orchestrator/role-prompt',
  '../../prompt-assembly',
  '../../agent-chats-data',
  '@papercusp/db-org',
  '../../agent-loop/chat-engine',
  '../../agent-loop/approval-store',
  '../../agent-loop/capability-toolset',
  '@papercusp/agent-mcp',
];

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  for (const m of MOCKED_MODULES) vi.doUnmock(m);
  vi.unstubAllEnvs();
});

interface LoopLaneMocks {
  assembleHarnessRolePrompt: ReturnType<typeof vi.fn>;
  assembleOperatorRolePrompt: ReturnType<typeof vi.fn>;
  runLoopChatTurn: ReturnType<typeof vi.fn>;
  dispatchProjectedTool: ReturnType<typeof vi.fn>;
  withWorkspace: ReturnType<typeof vi.fn>;
  workspaceTx: typeof ROUTE_WORKSPACE_TX;
  resolveLoopApproval: ReturnType<typeof vi.fn>;
  listPendingLoopApprovals: ReturnType<typeof vi.fn>;
  updates: string[];
  updateArgs: unknown[][];
}

async function loopLaneRoutes(
  chatRow: Record<string, unknown> | null,
  engineResult: Record<string, unknown> = {},
): Promise<{
  routes: RouteDefinition<undefined>[];
  mocks: LoopLaneMocks;
}> {
  const updates: string[] = [];
  const updateArgs: unknown[][] = [];
  const runLoopChatTurn = vi.fn(async (opts: {
    sink: { event: (n: string, d: unknown) => void };
    deferTerminalEvent?: boolean;
    tools?: Array<{ name: string; execute: (input: unknown) => Promise<unknown> }>;
  }) => {
    const toolCall = engineResult.toolCall as { name: string; args: Record<string, unknown> } | undefined;
    if (toolCall) {
      const tool = opts.tools?.find((candidate) => candidate.name === toolCall.name);
      if (!tool) throw new Error(`test tool not found: ${toolCall.name}`);
      await tool.execute(toolCall.args);
    }
    opts.sink.event('text_delta', { type: 'text_delta', stepIndex: 0, text: 'loop says hi' });
    if (!opts.deferTerminalEvent) {
      opts.sink.event('done', { type: 'done', stopReason: 'complete', finalText: 'loop says hi' });
    }
    return {
      stopReason: 'complete',
      finalText: 'loop says hi',
      tokensIn: 12,
      tokensOut: 7,
      costUsd: 0.05,
      errorMessage: null,
      stepCount: 1,
      servedAccount: 'gateway-acct-9',
      ...engineResult,
    };
  });
  const resolveLoopApproval = vi.fn(async () => true);
  const listPendingLoopApprovals = vi.fn(async () => []);
  const assembleHarnessRolePrompt = vi.fn(() => ({
    text: 'ROLE PROMPT',
    meta: { runId: 'run-test' },
  }));
  const assembleOperatorRolePrompt = vi.fn(() => ({
    text: 'OPERATOR ROLE PROMPT',
    sections: [],
  }));
  const dispatchProjectedTool = vi.fn(async () => ({
    ok: true,
    result: { content: [{ type: 'text', text: '{"ok":true}' }] },
  }));
  const withWorkspace = vi.fn(async (_workspaceId: string, run: (tx: unknown) => Promise<unknown>) =>
    run(ROUTE_WORKSPACE_TX),
  );

  vi.doMock('../../agent-tools', () => ({}));
  vi.doMock('@papercusp/agent-mcp', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@papercusp/agent-mcp')>();
    return {
      ...actual,
      dispatchProjectedTool,
      lookupByMcpName: (name: string) => ROUTE_TOOL_REGISTRY.find((tool) => tool.expose?.mcp?.name === name),
    };
  });
  vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
  vi.doMock('../../memory/injection', () => ({ buildMemoryContextBlock: vi.fn(async () => null) }));
  vi.doMock('../../harness-registry', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../harness-registry')>();
    return { ...actual, loadHarnessRegistry: vi.fn(async () => ({ projects: [] })) };
  });
  vi.doMock('../../operator-notes', () => ({ projectDirForSlug: vi.fn(async () => '/tmp/proj') }));
  vi.doMock('@papercusp/orchestrator/role-prompt', () => ({
    assembleRolePrompt: assembleHarnessRolePrompt,
  }));
  vi.doMock('../../prompt-assembly', () => ({
    assembleRolePrompt: assembleOperatorRolePrompt,
  }));
  vi.doMock('../../agent-chats-data', () => ({
    readFeatureLockState: vi.fn(async () => null),
    rowToChat: (row: Record<string, unknown>) => row,
  }));
  vi.doMock('@papercusp/db-org', async (orig) => {
    const actual = await vi.importActual<Record<string, unknown>>('@papercusp/db-org');
    return {
      ...(await orig<typeof import('@papercusp/db-org')>()),
      ...actual,
      // The route reads and writes agent_chats through `harnessQuery(slug, sql =>
      // sql.unsafe(text, params))` — this double is the ONLY thing standing between the
      // route and a live pool. Left real (the `...actual` spread above), harnessQuery hits
      // the PAPERCUSP_FORBID_REAL_PG rail inside the route's own preflight catch and every
      // case here reads 500 "failed to load chat: A UNIT test tried to open a REAL Postgres
      // connection" (gate red on the frozen candidate, WI-212675). Same contract as the
      // legacy double below: the chat SELECT answers `chatRow`, the cost aggregate answers
      // a zero total, and every other statement (the transcript UPDATEs the assertions
      // below read) lands on `updates` / `updateArgs`.
      harnessQuery: async (
        _slug: string,
        fn: (sql: { unsafe: (text: string, params?: unknown[]) => Promise<unknown[]> }) => unknown,
      ) =>
        fn({
          unsafe: async (text: string, params: unknown[] = []) => {
            const q = text.trim();
            if (/^SELECT \* FROM agent_chats/.test(q)) return [chatRow];
            if (/^SELECT COALESCE\(SUM\(/.test(q)) return [{ total: 0 }];
            updates.push(q);
            updateArgs.push(params);
            return [];
          },
        }),
      getLegacyClient: () => ({
        prepare: (sql: string) => ({
          get: async () => (/^SELECT \* FROM agent_chats/.test(sql.trim()) ? chatRow : { total: 0 }),
          run: async (...args: unknown[]) => { updates.push(sql.trim()); updateArgs.push(args); },
        }),
      }),
      withWorkspace,
    };
  });
  vi.doMock('../../agent-loop/chat-engine', () => ({
    runLoopChatTurn,
    resolveLoopChatModel: ({ model, effort }: { model?: string; effort?: string }) => {
      const base = model ?? 'claude-sonnet-4-6';
      return effort ? `${base.split(':')[0]}:${effort}` : base;
    },
  }));
  vi.doMock('../../agent-loop/approval-store', () => ({
    resolveLoopApproval,
    listPendingLoopApprovals,
  }));
  // Keep this route test focused on the route's real selector and executable
  // tool list without booting the full agent-tools registration graph. The
  // actual capability-toolset implementation still runs against this fixture
  // registry, so omitting the explicit canonical task names regresses here.
  vi.doMock('../../agent-loop/capability-toolset', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../agent-loop/capability-toolset')>();
    return {
      ...actual,
      capabilityToolNames: (opts: Parameters<typeof actual.capabilityToolNames>[0] = {}) =>
        actual.capabilityToolNames({ ...opts, registry: () => ROUTE_TOOL_REGISTRY }),
      capabilityToolset: (opts: Parameters<typeof actual.capabilityToolset>[0]) =>
        actual.capabilityToolset({ ...opts, registry: () => ROUTE_TOOL_REGISTRY }),
    };
  });

  const routes = (await import('../routes/agent-chats/index')).default as RouteDefinition<undefined>[];
  return {
    routes,
    mocks: {
      assembleHarnessRolePrompt,
      assembleOperatorRolePrompt,
      runLoopChatTurn,
      dispatchProjectedTool,
      withWorkspace,
      workspaceTx: ROUTE_WORKSPACE_TX,
      resolveLoopApproval,
      listPendingLoopApprovals,
      updates,
      updateArgs,
    },
  };
}

function findRoute(routes: RouteDefinition<undefined>[], method: string, path: string) {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`route not found: ${method} ${path}`);
  return r;
}

describe('POST messages { engine: "loop" } — the owned-loop lane', () => {
  it('uses the private channel callback with the real route persistence and no ambient dispatcher', async () => {
    vi.stubEnv('PAPERCUSP_DISTRIBUTION_PROFILE', 'vm-release');
    const history = [{ role: 'assistant', content: 'previous answer', ts: '2026-01-01T00:00:00Z' }];
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow, transcript: history });
    const { createHostedCustomerChannelHttpHandler } = await import('../../workspace-host/hosted-customer-loop-ports');
    const { createHostedPrincipal } = await import('../../auth/hosted-principal');
    const controller = new AbortController();
    const principal = createHostedPrincipal({ workspaceId: 'control-workspace', userId: 'customer-user',
      activeOrganizationId: 'customer-org', selectedWorkspaceId: 'customer-workspace',
      sessionId: 'authenticated-session', sessionVersion: 1, permissions: ['workspace:operate'] });
    const handler = createHostedCustomerChannelHttpHandler({ workspaceId: 'default', projectDir: '/tmp/proj',
      customerWorkspaceId: 'customer-workspace', transform: () => { throw new Error('unexpected process'); },
      dispatchDeps: {}, lookupTool: () => ({ ...fakeProjected('capability:bash'),
        capabilities: ['capability:bash'], needsWorkspaceTx: false }),
      createModelPort: () => ({ async *stream() { yield { type: 'text_delta', text: 'unused mock engine' }; } }) });
    const response = await handler(postReq({ content: 'customer turn', engine: 'loop', model: 'sonnet', account: 'forged-account' }), {
      channelId: 'private', sessionHost: {
        customerInvocationSignal: (_id, signal) => signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        resolveCustomerPrincipal: async () => ({ ok: true, principal }),
      },
    });
    expect(response?.status).toBe(200);
    const stream = await drainSse(response!.body, 8_000);
    expect(stream.closed).toBe(true);
    expect(stream.text).toContain('event: done');
    expect(mocks.runLoopChatTurn).toHaveBeenCalledTimes(1);
    const opts = mocks.runLoopChatTurn.mock.calls[0][0];
    expect(opts.transcript).toEqual([...history, expect.objectContaining({ role: 'user', content: 'customer turn' })]);
    expect(opts.system).toContain('ROLE PROMPT');
    expect(opts.sessions).toBeDefined();
    expect(opts.port.stream).toBeTypeOf('function');
    expect(opts.tools.map((tool: { name: string }) => tool.name)).toEqual(['capability:bash']);
    expect(opts.tools[0].needsApproval).toBe(true);
    expect(opts).not.toHaveProperty('account');
    expect(mocks.dispatchProjectedTool).not.toHaveBeenCalled();
    expect(mocks.updateArgs).toHaveLength(2);
    expect(JSON.parse(mocks.updateArgs[1][0] as string).at(-1)).toMatchObject({ role: 'assistant',
      content: 'loop says hi', account_route: 'auto' });
    // Constructing a private factory never opens the default mounted route.
    const mounted = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/messages');
    expect((await mounted.handler(postReq({ content: 'customer turn', engine: 'loop', model: 'sonnet' }), ctxFor(CHAT)) as Response).status).toBe(403);
    expect(mocks.updateArgs).toHaveLength(2);
  });

  it.each(['workspace', 'cwd', 'authorization', 'model', 'signal'])(
    'refuses private %s authority before transcript writes or engine execution', async reason => {
      const { mocks } = await loopLaneRoutes({ ...baseRow });
      const { createAgentChatMessagesRoute } = await import('../routes/agent-chats');
      const signal = new AbortController().signal;
      const bind = vi.fn(async () => {
        if (reason === 'authorization') throw new Error('private-secret');
        return { modelPort: reason === 'model' ? undefined : { async *stream() {} }, tools: [],
          signal: reason === 'signal' ? AbortSignal.abort() : signal };
      });
      const route = createAgentChatMessagesRoute({ workspaceId: reason === 'workspace' ? 'foreign' : 'default',
        projectDir: reason === 'cwd' ? '/foreign' : '/tmp/proj', bind: bind as never });
      const res = await route.handler(postReq({ content: 'customer turn', engine: 'loop', model: 'sonnet' }), ctxFor(CHAT)) as Response;
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'hosted_native_loop_unavailable' });
      expect(mocks.updateArgs).toEqual([]);
      expect(mocks.runLoopChatTurn).not.toHaveBeenCalled();
      expect(mocks.dispatchProjectedTool).not.toHaveBeenCalled();
      expect(bind).toHaveBeenCalledTimes(['workspace', 'cwd'].includes(reason) ? 0 : 1);
    },
  );

  it('cancels stalled private authorization before acquiring persistence authority', async () => {
    const { mocks } = await loopLaneRoutes({ ...baseRow });
    const { createAgentChatMessagesRoute } = await import('../routes/agent-chats');
    const controller = new AbortController();
    const bind = vi.fn(() => new Promise<never>(() => {}));
    const route = createAgentChatMessagesRoute({ workspaceId: 'default', projectDir: '/tmp/proj', bind });
    const request = new Request(postReq({ content: 'customer turn', engine: 'loop', model: 'sonnet' }), { signal: controller.signal });
    const pending = route.handler(request, ctxFor(CHAT));
    await vi.waitFor(() => expect(bind).toHaveBeenCalledTimes(1));
    controller.abort();
    expect((await pending as Response).status).toBe(403);
    expect(mocks.updateArgs).toEqual([]);
    expect(mocks.runLoopChatTurn).not.toHaveBeenCalled();
  });

  it('refuses connector-stamped customer native turns before operator execution or transcript writes', async () => {
    const { operatorHttpRequestHeaders } = await import('../../workspace-host/hosted-operator-http');
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow });
    const messages = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/messages');
    const request = new Request(postReq({ content: 'customer turn', engine: 'loop', model: 'sonnet' }), {
      headers: operatorHttpRequestHeaders({ 'content-type': 'application/json' }, {
        userId: 'customer-user', hostedSessionId: 'customer-session',
      }),
    });
    const res = await messages.handler(request, ctxFor(CHAT)) as Response;
    // Drain the unexpected old SSE path too, so a failing regression leaves no stream behind.
    const { text, closed } = await drainSse(res.body, 8_000);
    expect(closed).toBe(true);
    expect(res.status).toBe(403);
    expect(JSON.parse(text)).toMatchObject({ error: 'hosted_native_loop_unavailable' });
    expect(mocks.runLoopChatTurn).not.toHaveBeenCalled();
    expect(mocks.dispatchProjectedTool).not.toHaveBeenCalled();
    expect(mocks.updates).toEqual([]);
  });

  it.each(['', 'off'])('refuses bare native turns on a VM release host with peer policy %j before operator execution', async (peerPolicy) => {
    vi.stubEnv('PAPERCUSP_DISTRIBUTION_PROFILE', 'vm-release');
    vi.stubEnv('PAPERCUSP_LOOPBACK_PEER_UID_POLICY', peerPolicy);
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow });
    const messages = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/messages');
    const res = await messages.handler(
      postReq({ content: 'customer turn', engine: 'loop', model: 'sonnet' }), ctxFor(CHAT),
    ) as Response;
    const { text, closed } = await drainSse(res.body, 8_000);
    expect(closed).toBe(true);
    expect(res.status).toBe(403);
    expect(JSON.parse(text)).toMatchObject({ error: 'hosted_native_loop_unavailable' });
    expect(mocks.runLoopChatTurn).not.toHaveBeenCalled();
    expect(mocks.updates).toEqual([]);
  });

  it('routes to runLoopChatTurn with the assembled system + transcript, streams, persists, closes', async () => {
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow });
    const messages = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/messages');
    const res = (await messages.handler(
      postReq({
        content: 'hello loop',
        engine: 'loop',
        model: 'sonnet',
        effort: 'high',
        account: 'acct-7',
      }),
      ctxFor(CHAT),
    )) as Response;
    expect(res.status).toBe(200);
    const { text, closed } = await drainSse(res.body, 8_000);
    expect(closed).toBe(true);
    expect(text).toContain('text_delta');
    expect(text).toContain('loop says hi');
    expect(text).toContain('event: provenance');
    expect(text).toContain('\"model\":\"sonnet:high\"');
    expect(text).toContain('\"accountRoute\":\"acct-7\"');
    expect(text).toContain('\"servedAccount\":\"gateway-acct-9\"');

    expect(mocks.runLoopChatTurn).toHaveBeenCalledTimes(1);
    const opts = mocks.runLoopChatTurn.mock.calls[0][0] as {
      system: string;
      transcript: Array<{ role: string; content: string }>;
      model?: string;
      effort?: string;
      account?: string;
      chatId: string;
      priority?: string;
      ownerId?: string;
    };
    // systemText = persona + context sections, NO history block, NO user turn.
    expect(opts.system).toContain('ROLE PROMPT');
    expect(opts.system).not.toContain('## User');
    // The transcript handed to the engine ends with the just-appended user turn.
    expect(opts.transcript.at(-1)).toMatchObject({ role: 'user', content: 'hello loop' });
    expect(opts.model).toBe('sonnet:high');
    expect(opts.effort).toBe('high');
    expect(opts.account).toBe('acct-7');
    expect(opts.chatId).toBe(CHAT);
    expect(opts.priority).toBe('interactive');
    expect(opts.ownerId).toBe(`agent-loop-${CHAT}`);
    expect((mocks.runLoopChatTurn.mock.calls[0][0] as { deferTerminalEvent?: boolean }).deferTerminalEvent).toBe(true);
    expect((mocks.runLoopChatTurn.mock.calls[0][0] as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name).sort()).toEqual([
      'capability:bash',
      'capability:read',
      'tasks:ops',
      'tasks:todo_write',
      'tasks:update_plan',
    ]);

    // Persistence: user turn first (preflight), then the assistant turn with totals.
    expect(mocks.updates.length).toBeGreaterThanOrEqual(2);
    const finalUpdate = mocks.updateArgs.at(-1)!;
    const transcript = JSON.parse(finalUpdate[0] as string) as Array<{ role: string; content: string; tokens_in?: number }>;
    expect(transcript.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'loop says hi',
      engine: 'loop',
      model: 'sonnet:high',
      account_route: 'acct-7',
      account_served: 'gateway-acct-9',
      tokens_in: 12,
      tokens_out: 7,
    });
    expect(finalUpdate[1]).toBe(12); // total_input_tokens increment
    expect(finalUpdate[2]).toBe(7); // total_output_tokens increment
    expect(finalUpdate[3]).toBe(5); // cost cents (0.05 USD)
  });

  it('dispatches owned-loop tools with a principal, workspace transaction and chat-scoped identity', async () => {
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow }, {
      toolCall: { name: 'tasks:ops', args: { op: 'view' } },
    });
    const messages = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/messages');
    const res = (await messages.handler(
      postReq({ content: 'view the canonical task list', engine: 'loop' }),
      ctxFor(CHAT),
    )) as Response;
    expect(res.status).toBe(200);
    const { closed } = await drainSse(res.body, 8_000);
    expect(closed).toBe(true);

    expect(mocks.withWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.withWorkspace).toHaveBeenCalledWith('default', expect.any(Function));
    expect(mocks.dispatchProjectedTool).toHaveBeenCalledOnce();
    const [, name, args, dispatchCtx, deps] = mocks.dispatchProjectedTool.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(name).toBe('tasks:ops');
    expect(args).toEqual({ op: 'view' });
    expect(dispatchCtx).toMatchObject({
      workspaceId: 'default',
      harnessSlug: SLUG,
      role: 'worker',
      runId: CHAT,
      spawnId: `agent-loop-${CHAT}`,
      uiClientId: 'pui:local',
      tx: mocks.workspaceTx,
      principal: { slug: 'pui:local', workspaceId: 'default' },
    });
    expect((dispatchCtx.principal as { capabilities: Set<string> }).capabilities.has('*')).toBe(true);
    expect(deps).toMatchObject({
      computeQuotaWindow: expect.any(Function),
      recordInvocation: expect.any(Function),
    });
  });

  it('rejects an unsupported loop model before user-turn persistence or streaming', async () => {
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow });
    const messages = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/messages');
    // OpenRouter is now executable; use a provider the router actually refuses.
    const model = 'unsupported-test-provider/model:max';
    const res = (await messages.handler(
      postReq({ content: 'must not run', engine: 'loop', model }),
      ctxFor(CHAT),
    )) as Response;

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ engine: 'loop', model });
    expect(mocks.runLoopChatTurn).not.toHaveBeenCalled();
    expect(mocks.updates).toHaveLength(0);
  });

  it('assembles an operator chat from the operator prompt stack, not the blueprint stack', async () => {
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow, role: 'operator' });
    const messages = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/messages');
    const res = (await messages.handler(
      postReq({ content: 'run the native operator loop', engine: 'loop' }),
      ctxFor(CHAT),
    )) as Response;
    expect(res.status).toBe(200);
    const { closed } = await drainSse(res.body, 8_000);
    expect(closed).toBe(true);

    expect(mocks.assembleOperatorRolePrompt).toHaveBeenCalledWith({
      role: 'operator',
      profile: 'pui-loop',
      projectDir: '/tmp/proj',
      toolNames: [
        'capability:read',
        'capability:bash',
        'tasks:ops',
        'tasks:todo_write',
        'tasks:update_plan',
      ],
    });
    expect(mocks.assembleHarnessRolePrompt).not.toHaveBeenCalled();
    expect(mocks.runLoopChatTurn.mock.calls[0][0].system).toContain('OPERATOR ROLE PROMPT');
  });

  it('an engine errorMessage persists a failure-marker turn and still closes the stream', async () => {
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow }, {
      errorMessage: 'gateway exploded',
      finalText: '',
      stopReason: 'error',
    });
    const messages = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/messages');
    const res = (await messages.handler(
      postReq({ content: 'hello loop', engine: 'loop' }),
      ctxFor(CHAT),
    )) as Response;
    const { text, closed } = await drainSse(res.body, 8_000);
    expect(closed).toBe(true);
    expect(text).toContain('event: error');
    expect(text).toContain('gateway exploded');
    expect(text).not.toContain('event: done');
    const finalUpdate = mocks.updateArgs.at(-1)!;
    const transcript = JSON.parse(finalUpdate[0] as string) as Array<{ role: string; content: string; error?: boolean }>;
    expect(transcript.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'That turn did not complete. Try asking again.',
      error: true,
      engine: 'loop',
      model: 'claude-sonnet-4-6',
      account_route: 'auto',
    });
    expect(transcript.at(-1)!.content).not.toContain('gateway exploded');
  });

  it('a retry with the same trailing user turn does not append it twice', async () => {
    const pendingUser = { role: 'user', content: 'retry me', ts: '2026-08-25T00:00:00Z' };
    const { routes, mocks } = await loopLaneRoutes({
      ...baseRow,
      transcript: [pendingUser],
    });
    const messages = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/messages');
    const res = (await messages.handler(
      postReq({ content: 'retry me', engine: 'loop' }),
      ctxFor(CHAT),
    )) as Response;
    const { text, closed } = await drainSse(res.body, 8_000);
    expect(closed).toBe(true);
    expect(text).toContain('event: done');
    expect(mocks.updates).toHaveLength(1);
    const persisted = JSON.parse(mocks.updateArgs[0][0] as string) as Array<{ role: string; content: string }>;
    expect(persisted.filter((turn) => turn.role === 'user')).toEqual([pendingUser]);
    expect(persisted.at(-1)).toMatchObject({ role: 'assistant', content: 'loop says hi' });
  });

  it('empty final output becomes a persisted visible terminal error, never done', async () => {
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow }, {
      finalText: '',
      errorMessage: null,
    });
    // Suppress the mock's text delta too by replacing its implementation.
    mocks.runLoopChatTurn.mockImplementationOnce(async () => ({
      stopReason: 'complete',
      finalText: '',
      tokensIn: 1,
      tokensOut: 0,
      costUsd: 0,
      errorMessage: null,
      stepCount: 1,
    }));
    const messages = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/messages');
    const res = (await messages.handler(
      postReq({ content: 'answer me', engine: 'loop' }),
      ctxFor(CHAT),
    )) as Response;
    const { text, closed } = await drainSse(res.body, 8_000);
    expect(closed).toBe(true);
    expect(text).toContain('event: error');
    expect(text).toContain('completed without assistant content');
    expect(text).not.toContain('event: done');
    const persisted = JSON.parse(mocks.updateArgs.at(-1)![0] as string) as Array<{ role: string; content: string; error?: boolean }>;
    expect(persisted.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'That turn did not complete. Try asking again.',
      error: true,
    });
  });

  it('without engine:"loop" the legacy lane is used (runLoopChatTurn untouched)', async () => {
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow });
    const messages = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/messages');
    // The legacy lane needs the agent_chats:chat tool registered; with
    // '../../agent-tools' mocked empty the lookup fails and the route 500s —
    // which is exactly the discriminator needed: the loop engine must NOT run.
    const res = (await messages.handler(
      postReq({ content: 'hello legacy' }),
      ctxFor(CHAT),
    )) as Response;
    expect(mocks.runLoopChatTurn).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
  });
});

describe('approval routes', () => {
  it('POST approvals/:callId resolves a pending approval', async () => {
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow });
    const route = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/approvals/:callId');
    const res = (await route.handler(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      }),
      ctxFor(CHAT, { callId: 'call-7' }),
    )) as Response;
    expect(res.status).toBe(200);
    expect(mocks.resolveLoopApproval).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: CHAT, callId: 'call-7', approved: true, workspaceId: 'default' }),
    );
  });

  it('POST approvals/:callId → 404 when nothing is pending', async () => {
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow });
    mocks.resolveLoopApproval.mockResolvedValueOnce(false);
    const route = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/approvals/:callId');
    const res = (await route.handler(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: false, reason: 'nope' }),
      }),
      ctxFor(CHAT, { callId: 'gone' }),
    )) as Response;
    expect(res.status).toBe(404);
  });

  it('POST approvals/:callId → 400 without a boolean `approved`', async () => {
    const { routes } = await loopLaneRoutes({ ...baseRow });
    const route = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/approvals/:callId');
    const res = (await route.handler(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'no decision' }),
      }),
      ctxFor(CHAT, { callId: 'c' }),
    )) as Response;
    expect(res.status).toBe(400);
  });

  it('GET approvals returns the pending list', async () => {
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow });
    mocks.listPendingLoopApprovals.mockResolvedValueOnce([
      { chatId: CHAT, callId: 'c1', toolName: 'capability:bash' },
    ]);
    const route = findRoute(routes, 'GET', '/harness/:slug/agent-chats/:chatId/approvals');
    const res = (await route.handler(
      new Request('http://localhost/x'),
      ctxFor(CHAT),
    )) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approvals: Array<{ callId: string }> };
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0].callId).toBe('c1');
  });
});
