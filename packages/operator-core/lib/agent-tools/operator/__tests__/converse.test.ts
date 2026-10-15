/**
 * operator:converse — handler coverage (P-019 of production-readiness-test-coverage).
 *
 * The operator brain's converse loop was effectively untested: the prior
 * converse-mcp-url.test.ts mocked the WRONG modules (`@/lib/operator-converse-prompt`
 * instead of the `./converse-prompt` the tool imports, and `@/lib/superuser-token`
 * while the tool read the token from disk via a local copy) and asserted the
 * retired mcp-remote stdio `args` shape — so it ran the real prompt builder, then
 * failed on the empty-output retry's console.error.
 *
 * This file drives the handler directly with a mocked runAgentChat stream and a
 * mock ctx, covering: the mcpUrl/state-channel shape, the budget gate, the
 * single empty-output retry, the no-retry-once-committed path, and server-side
 * <spawn>-tag dispatch. All collaborators are mocked at their real import paths;
 * parseOperatorTurn is left real so the <spawn> parsing is exercised end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const principalMocks = vi.hoisted(() => ({
  resolveBearer: vi.fn(async () => ({
    kind: 'pi' as const,
    slug: 'pi:portal-test',
    workspaceId: 'ws-real',
    capabilities: new Set(['chat:write', 'operator:read']),
    authMethod: 'bearer-token' as const,
    trust: 'trusted' as const,
  })),
}));
const customerPiMocks = vi.hoisted(() => ({
  spawnTransform: vi.fn(() => false),
  start: vi.fn(async (args: { sessionId: string; expiresAt: Date }) => ({
    sessionId: args.sessionId,
    bearer: 'pi-customer-token',
  })),
  end: vi.fn(async (_workspaceId: string, _sessionId: string) => undefined),
}));
vi.mock('@papercusp/papercusp-shared/agent', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  agentSpawnTransformConfigured: () => customerPiMocks.spawnTransform(),
}));
vi.mock('@papercusp/agent-mcp/provisioning', () => ({
  startPiSession: (args: { sessionId: string; expiresAt: Date }) => customerPiMocks.start(args),
  endPiSession: (workspaceId: string, sessionId: string) => customerPiMocks.end(workspaceId, sessionId),
}));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveBearer: principalMocks.resolveBearer,
    lookupByMcpName: (name: string) => ({
      capabilities: name === 'chat:ask_choice'
        ? ['chat:write']
        : name === 'voice:delegate_deep'
          ? ['operator:read']
          : name === 'docs:search' || name === 'docs:get'
            ? ['docs:read']
          : ['not-granted'],
      inputSchema: { type: 'object', properties: {} },
    }),
  };
});

vi.mock('../../../agent-chat-stream', () => ({
  runAgentChat: vi.fn(),
  // The real resolver honours an explicit per-call backend first (P-005: the
  // papercup pin carries its backend); everything else in this suite runs the
  // default claude-code brain.
  resolveBackend: vi.fn((o: { backend?: string | null }) => o?.backend ?? 'claude-code'),
}));
const { getMemoryBackendMock, rememberConversationMock } = vi.hoisted(() => {
  const rememberConversationMock = vi.fn(async () => ({ ids: [], storedEvents: 0 }));
  return {
    getMemoryBackendMock: vi.fn(() => ({
      name: 'fake',
      available: vi.fn(async () => ({ ok: true })),
      rememberConversation: rememberConversationMock,
    })),
    rememberConversationMock,
  };
});
vi.mock('../../../memory/backend', () => ({ getMemoryBackend: getMemoryBackendMock }));
// converse reads the superuser token from disk via a local readFileSync; stub
// just that one read so mcpConfig is built without depending on the real token
// file existing. Everything else passes through to the real fs.
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readFileSync: ((p: any, ...rest: any[]) =>
      String(p).includes('superuser-token')
        ? 'fake-superuser-token-0123456789'
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (actual.readFileSync as any)(p, ...rest)) as typeof actual.readFileSync,
  };
});
// WI-10004897: the papercup failover judges the alternate's login from local credential
// files. Pin that verdict so these tests never depend on the host's real ~/.claude/~/.codex.
const agentBackendCredentialVerdictMock = vi.hoisted(() =>
  vi.fn((_backend: string): unknown => ({ usable: true, basis: 'refreshable' })),
);
vi.mock('../../../agent-auth-detect', async (orig) => ({
  ...(await orig<typeof import('../../../agent-auth-detect')>()),
  agentBackendCredentialVerdict: (backend: string) => agentBackendCredentialVerdictMock(backend),
}));
vi.mock('../../../operator-budget', () => ({
  recordSpend: vi.fn(),
  checkBudget: vi.fn(async () => ({ state: null, exceeded: false })),
  shouldBypassOperatorBudget: (uiClientId?: string | null) =>
    typeof uiClientId === 'string' && uiClientId.startsWith('llm-testing/'),
}));
// The tool imports buildOperatorPrompt from './converse-prompt' (the agent-tools
// copy) and destructures { systemPromptText, userPromptText } — mock that path
// with the correct object shape.
vi.mock('../converse-prompt', () => ({
  buildOperatorPrompt: vi.fn(async () => ({
    systemPromptText: 'sys',
    userPromptText: 'usr',
  })),
}));
vi.mock('../../../system-principal', () => ({
  readSystemPrincipal: vi.fn(async () => ({
    workspaceId: 'ws-real',
    capabilities: new Set(['tasks:read']),
    slug: 'system:operator',
    kind: 'system',
  })),
}));
vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-real'),
}));
vi.mock('../../../self-url', () => ({ selfUrl: vi.fn(() => 'http://localhost:3070') }));
vi.mock('../../../agent-config', () => ({
  readAgentConfig: vi.fn(async () => ({ models: {} })),
  surfaceBackend: vi.fn(async () => undefined),
  surfaceModel: vi.fn(async () => undefined),
}));
vi.mock('../../../operator-mcp-tools', () => ({
  ALL_AGENT_MCP_TOOLS: ['tasks:read', 'mcp__agentmcp__chat:ask_choice'],
  INTERACTIVE_CHAT_TOOLS: ['mcp__agentmcp__chat:ask_choice'],
  canonicalToolName: (n: string) => n.replace(/^mcp__agentmcp__/, ''),
}));
// P-005: the public-trust door list comes from the projected-tool registry;
// stub it so the handler test never loads the catalog.
vi.mock('../../../agent-loop/capability-toolset', () => ({
  OWNED_LOOP_TOOL_SELECTION: { prefixes: ['capability:'] },
  capabilityToolNames: vi.fn(() => ['capability:read', 'tasks:ops']),
}));
// The <spawn>-tag dispatch goes through the durable nursery spawn engine
// (fleet/operator-spawn), dynamically imported by the handler — mock the module
// so the test asserts the dispatch contract without touching PG / processes.
vi.mock('../../../fleet/operator-spawn', () => ({
  spawnAgentInHarness: vi.fn(async () => ({
    ok: true,
    spawnId: 's-mock',
    harness: 'demo',
    projectDir: '/tmp/demo',
    error: null,
  })),
}));
vi.mock('../../../operator-sentinel-handoff', () => ({
  dispatchSentinelHandoff: vi.fn(async () => ({ status: 'filed', workItemId: 'WI-101', tier: 'low', nudged: true })),
}));
vi.mock('../../../operator-sentinel-handoff-deps', () => ({
  defaultSentinelHandoffDeps: vi.fn(() => ({})),
}));
vi.mock('../../../papercup/papercup-deep-delegate', () => ({
  delegateDeep: vi.fn(async () => ({ ok: true, workItemId: 'WI-301', spawnId: 's-deep', spawned: true })),
}));
vi.mock('../../../papercup/papercup-deep-delegate-deps', () => ({
  defaultDeepDelegateDeps: vi.fn(() => ({})),
}));

import { runAgentChat } from '../../../agent-chat-stream';
import { spawnAgentInHarness } from '../../../fleet/operator-spawn';
import { dispatchSentinelHandoff } from '../../../operator-sentinel-handoff';
import { delegateDeep } from '../../../papercup/papercup-deep-delegate';
import { activeWorkspaceId } from '../../../workspace-registry';
import { checkBudget } from '../../../operator-budget';
import { configureAgentSpawnTransform } from '@papercusp/papercusp-shared/agent';
import tool from '../converse';
import { buildOperatorPrompt } from '../converse-prompt';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGen = AsyncGenerator<any, void, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = (input: unknown, ctx: unknown) => (tool as any).handler(input, ctx);

interface McpConfig {
  mcpServers: { agentmcp: { type: string; url: string; headers: Record<string, string> } };
}
const mcpUrlOf = (cfg: McpConfig | undefined): string | null =>
  cfg?.mcpServers?.agentmcp?.url ?? null;

function makeCtx() {
  return {
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    emit: vi.fn(),
    workspaceId: 'ws-real',
    role: 'operator',
    runId: 'r-test',
    spawnId: 's-test',
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fetchMock: any;

beforeEach(() => {
  customerPiMocks.spawnTransform.mockReturnValue(false);
  customerPiMocks.start.mockClear();
  customerPiMocks.end.mockClear();
  vi.mocked(runAgentChat).mockReset();
  // Default: a non-empty stream so the handler commits output (no retry/throw).
  vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
    yield { type: 'delta', text: 'hi' };
  });
  vi.mocked(checkBudget).mockResolvedValue({ state: null, exceeded: false } as never);
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('operator:converse — mcpUrl / state-channel shape', () => {
  it.each([
    { context: { step: 'connection', status: 'ready' }, title: 'Connect Google Cloud' },
    { context: { version: 3, step: 'billing', status: 'ready' }, title: 'Understand the bills' },
  ])('lesson context $title shrinks even an owner request to public text with no tools, private context, memory or action tags', async ({ context, title }) => {
    vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
      yield { type: 'delta', text: '<spawn role="su" harness="demo"/> Use the connection form.' };
    });
    await handler({ lessonContext: context, hostTrust: 'owner', principalToken: 'owner-token',
      uiContext: 'private-resource-record', conversationId: 'private-conversation',
      sessionUser: { id: 'private-user', username: 'private', display_name: 'Private', has_password: true },
      messages: [{ role: 'system', content: 'private-history' }, { role: 'user', content: 'Connect my project for me.' }] }, makeCtx());
    const invocation = vi.mocked(runAgentChat).mock.calls[0][0];
    expect(invocation.mcpConfig).toBeUndefined(); expect(invocation.allowedTools).toEqual([]);
    expect(invocation.disallowBuiltins).toBe(true);
    expect(principalMocks.resolveBearer).not.toHaveBeenCalled();
    const prompt = vi.mocked(buildOperatorPrompt).mock.calls[0];
    expect(prompt[0]).toMatchObject({ hostTrust: 'public', toolNames: [], role: 'papercup' });
    expect(prompt[0].messages).toEqual([{ role: 'user', content: 'Connect my project for me.' }]);
    expect(prompt[0].conversationId).toBeUndefined(); expect(prompt[1]).toBeNull();
    expect(prompt[0].uiContext).toContain(title);
    for (const privateValue of ['private-resource-record', 'private-conversation', 'private-user', 'private-history']) expect(prompt[0].uiContext).not.toContain(privateValue);
    expect(spawnAgentInHarness).not.toHaveBeenCalled(); expect(rememberConversationMock).not.toHaveBeenCalled();
  });
  it('mcpUrl includes ?superuser=1 + &workspace=<id> (http MCP shape)', async () => {
    await handler({ messages: [], trigger: 'user_message', sessionUser: null }, makeCtx());
    expect(runAgentChat).toHaveBeenCalled();
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { mcpConfig?: McpConfig };
    const url = mcpUrlOf(call.mcpConfig);
    expect(url).not.toBeNull();
    expect(url).toContain('?superuser=1');
    expect(url).toContain('&workspace=ws-real');
    expect(call.mcpConfig?.mcpServers.agentmcp.type).toBe('http');
  });

  it('mcpUrl carries &tools=<operator set> so the surface loads non-deferred (P-009)', async () => {
    await handler({ messages: [], trigger: 'user_message', sessionUser: null }, makeCtx());
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { mcpConfig?: McpConfig };
    const url = mcpUrlOf(call.mcpConfig)!;
    expect(url).toContain('&tools=');
    // The param is the colon MCP-catalog name (mcp__agentmcp__ prefix stripped).
    const tools = new URL(url).searchParams.get('tools') ?? '';
    expect(tools.split(',')).toEqual(['tasks:read', 'chat:ask_choice']);
  });

  it('D-421 customer-run owner chat gets an exact PI mount and revokes its temporary bearer', async () => {
    customerPiMocks.spawnTransform.mockReturnValue(true);
    await handler(
      { messages: [], trigger: 'user_message', role: 'papercup', hostTrust: 'owner', sessionUser: null },
      { ...makeCtx(), role: 'papercup' },
    );

    const call = vi.mocked(runAgentChat).mock.calls[0][0] as {
      allowedTools?: string[];
      mcpConfig?: McpConfig;
    };
    const url = mcpUrlOf(call.mcpConfig)!;
    expect(url).toContain('/api/mcp?principal=pi&workspace=ws-real');
    expect(url).not.toContain('superuser');
    expect(call.mcpConfig?.mcpServers.agentmcp.headers.Authorization).toBe('Bearer pi-customer-token');
    expect(new URL(url).searchParams.get('tools')?.split(',')).toEqual([
      'capability:read',
      'tasks:ops',
      'chat:ask_choice',
      'voice:delegate_deep',
      'docs:search',
      'docs:get',
    ]);
    expect(call.allowedTools).toEqual([
      'mcp__agentmcp__capability:read',
      'mcp__agentmcp__tasks:ops',
      'mcp__agentmcp__chat:ask_choice',
      'mcp__agentmcp__voice:delegate_deep',
      'mcp__agentmcp__docs:search',
      'mcp__agentmcp__docs:get',
    ]);
    expect(customerPiMocks.start).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-real',
      allowedTools: ['capability:read', 'tasks:ops', 'chat:ask_choice', 'voice:delegate_deep', 'docs:search', 'docs:get'],
      capabilities: ['chat:write', 'docs:read', 'not-granted', 'operator:read'],
      expiresAt: expect.any(Date),
    }));
    const sessionId = customerPiMocks.start.mock.calls[0]?.[0]?.sessionId;
    const expiresAt = customerPiMocks.start.mock.calls[0]?.[0]?.expiresAt;
    expect(sessionId).toMatch(/^operator-converse-/);
    expect(expiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(expiresAt?.getTime()).toBeLessThan(Date.now() + 31 * 60 * 1000);
    expect(customerPiMocks.end).toHaveBeenCalledWith('ws-real', sessionId);
  });

  it('spawns with disableToolSearch so the shrunk surface loads non-deferred (P-009)', async () => {
    await handler({ messages: [], trigger: 'user_message', sessionUser: null }, makeCtx());
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { disableToolSearch?: boolean };
    expect(call.disableToolSearch).toBe(true);
  });

  it('spawns with disallowBuiltins so the brain has NO Bash/Task/file tools (P-008)', async () => {
    await handler({ messages: [], trigger: 'user_message', sessionUser: null }, makeCtx());
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { disallowBuiltins?: boolean };
    expect(call.disallowBuiltins).toBe(true);
  });

  it('mcpUrl workspace comes from ctx.workspaceId, NOT the process-global (voice-card state-channel keying, P-003)', async () => {
    // The dispatch ctx carries the REQUEST's workspace (resolved in-ALS by the
    // route); activeWorkspaceId() inside the handler runs outside the request
    // scope and resolves the process-global. The two diverging mis-keyed the
    // state channel and killed every voice disambiguation card (found live
    // 2026-06-07). Pin ctx-first precedence.
    const { readSystemPrincipal } = await import('../../../system-principal');
    vi.mocked(readSystemPrincipal).mockResolvedValueOnce({
      workspaceId: 'ws-window',
      capabilities: new Set(['tasks:read']),
      slug: 'system:operator',
      kind: 'system',
    } as never);
    vi.mocked(activeWorkspaceId).mockReturnValue('ws-global');
    await handler(
      { messages: [], trigger: 'user_message', sessionUser: null },
      { ...makeCtx(), workspaceId: 'ws-window' },
    );
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { mcpConfig?: McpConfig };
    const url = mcpUrlOf(call.mcpConfig)!;
    expect(url).toContain('&workspace=ws-window');
    expect(url).not.toContain('ws-global');
    // The principal lookup must target the same request workspace — the
    // implicit default resolves the ALS-lost global and yields a tool-less
    // brain (principal/comparison workspace mismatch).
    expect(vi.mocked(readSystemPrincipal)).toHaveBeenCalledWith('operator', 'ws-window');
    vi.mocked(activeWorkspaceId).mockReturnValue('ws-real');
  });

  it("ctx.workspaceId='*' (superuser wildcard) falls through to activeWorkspaceId()", async () => {
    const { readSystemPrincipal } = await import('../../../system-principal');
    vi.mocked(readSystemPrincipal).mockResolvedValueOnce({
      workspaceId: 'ws-real',
      capabilities: new Set(['tasks:read']),
      slug: 'system:operator',
      kind: 'system',
    } as never);
    await handler(
      { messages: [], trigger: 'user_message', sessionUser: null },
      { ...makeCtx(), workspaceId: '*' },
    );
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { mcpConfig?: McpConfig };
    expect(mcpUrlOf(call.mcpConfig)!).toContain('&workspace=ws-real');
  });

  it('&tools= keeps chat:ask_choice on surface="tui" (inline cards, Phase 2a)', async () => {
    // sentinel-tui-shared-backend-and-cards-2026-06-22 Phase 2a: the pui renders
    // inline terminal cards from the state-channel snapshot, so chat:ask_choice
    // is no longer dropped on the TUI surface (it stays identical to desktop).
    await handler(
      { messages: [], trigger: 'user_message', surface: 'tui', sessionUser: null },
      makeCtx(),
    );
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { mcpConfig?: McpConfig };
    const tools = new URL(mcpUrlOf(call.mcpConfig)!).searchParams.get('tools') ?? '';
    expect(tools.split(',')).toEqual(['tasks:read', 'chat:ask_choice']);
  });

  it('workspaceId is URL-encoded in the mcpUrl', async () => {
    const wonky = 'ws with space/slash';
    const { readSystemPrincipal } = await import('../../../system-principal');
    // converse only reads principal.workspaceId; cast past the full
    // SystemPrincipal shape (which is in flux from the capability work).
    vi.mocked(readSystemPrincipal).mockResolvedValue({ workspaceId: wonky } as never);
    // ctx.workspaceId is the authoritative source (request-scoped) — the
    // wonky value rides the ctx, not the process-global.
    await handler(
      { messages: [], trigger: 'user_message', sessionUser: null },
      { ...makeCtx(), workspaceId: wonky },
    );
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { mcpConfig?: McpConfig };
    expect(mcpUrlOf(call.mcpConfig)).toContain('&workspace=ws%20with%20space%2Fslash');
  });
});

describe('operator:converse — loop behaviors (P-019)', () => {
  it.each(['authorized', 'wrong-workspace', 'absent'] as const)(
    'public provenance records its selected catalog without credentials: %s', async (kind) => {
      if (kind !== 'absent') principalMocks.resolveBearer.mockResolvedValueOnce({
        kind: 'pi', slug: 'pi:private-fixture', workspaceId: kind === 'authorized' ? 'ws-real' : 'other-workspace',
        capabilities: new Set(['docs:read']), authMethod: 'bearer-token', trust: 'trusted',
      });
      const ctx = makeCtx();
      await handler({ messages: [], trigger: 'user_message', role: 'papercup', hostTrust: 'public',
        ...(kind !== 'absent' ? { principalToken: 'secret-public-fixture' } : {}) }, ctx);
      const invocation = vi.mocked(runAgentChat).mock.calls[0][0];
      const provenance = ctx.emit.mock.calls.find(([event]) => event === 'provenance')![1];
      const names = kind === 'authorized' ? ['docs:search', 'docs:get'] : [];
      expect(provenance.toolContext).toEqual({ toolNames: names,
        authorization: kind === 'authorized' ? 'granted' : 'unavailable',
        promptHash: expect.stringMatching(/^[a-f0-9]{32}$/) });
      expect(invocation.allowedTools).toEqual(names.map((name) => `mcp__agentmcp__${name}`));
      expect(vi.mocked(buildOperatorPrompt).mock.calls.at(-1)![0].toolNames).toEqual(invocation.allowedTools);
      expect(JSON.stringify(provenance)).not.toMatch(/secret-public-fixture|private-fixture|other-workspace/);
    });

  it('budget exceeded → throws + never invokes the model', async () => {
    vi.mocked(checkBudget).mockResolvedValue({
      state: { capUsd: 5 },
      exceeded: true,
      todaySpendUsd: 5.5,
      capUsd: 5,
    } as never);
    await expect(
      handler({ messages: [], sessionUser: null }, makeCtx()),
    ).rejects.toThrow(/budget reached/i);
    expect(runAgentChat).not.toHaveBeenCalled();
  });

  it('llm-testing client id bypasses the owner-facing daily budget cap', async () => {
    vi.mocked(checkBudget).mockResolvedValue({
      state: { capUsd: 5 },
      exceeded: true,
      todaySpendUsd: 5.5,
      capUsd: 5,
    } as never);
    await handler(
      { messages: [], sessionUser: null, uiClientId: 'llm-testing/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
      makeCtx(),
    );
    expect(checkBudget).not.toHaveBeenCalled();
    expect(runAgentChat).toHaveBeenCalledTimes(1);
  });

  it('llm-testing client id skips post-turn conversation capture', async () => {
    await handler(
      {
        messages: [{ role: 'user', content: 'seeded benchmark prompt' }],
        uiClientId: 'llm-testing/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        sessionUser: {
          id: 'user-1',
          username: 'owner',
          display_name: 'Owner',
          has_password: true,
        },
      },
      makeCtx(),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(getMemoryBackendMock).not.toHaveBeenCalled();
    expect(rememberConversationMock).not.toHaveBeenCalled();
  });

  it('ordinary session-user turns still capture the conversation after streaming', async () => {
    await handler(
      {
        messages: [{ role: 'user', content: 'ordinary prompt' }],
        uiClientId: 'desktop-client',
        sessionUser: {
          id: 'user-1',
          username: 'owner',
          display_name: 'Owner',
          has_password: true,
        },
      },
      makeCtx(),
    );
    await vi.waitFor(() => expect(rememberConversationMock).toHaveBeenCalledTimes(1));

    expect(getMemoryBackendMock).toHaveBeenCalledTimes(1);
    expect(rememberConversationMock).toHaveBeenCalledWith(
      [
        { role: 'user', content: 'ordinary prompt' },
        { role: 'assistant', content: 'hi' },
      ],
      expect.objectContaining({
        scope: 'user-1',
        metadata: expect.objectContaining({ workspace_id: 'ws-real' }),
      }),
    );
  });

  it('empty output on every attempt → retries once, then throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
      /* empty stream */
    });
    await expect(
      handler({ messages: [], sessionUser: null }, makeCtx()),
    ).rejects.toThrow(/no output/i);
    expect(runAgentChat).toHaveBeenCalledTimes(2); // MAX_BRAIN_ATTEMPTS
    errSpy.mockRestore();
  });

  it('empty first attempt, output on the retry → succeeds without throwing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
      n += 1;
      if (n === 1) return; // empty first attempt
      yield { type: 'delta', text: 'hello' };
      yield { type: 'result', costUsd: 0.02 };
    });
    const res = await handler({ messages: [], sessionUser: null }, makeCtx());
    expect(runAgentChat).toHaveBeenCalledTimes(2);
    const out = res.data;
    expect(out.assembled).toBe('hello');
    expect(out.totalCost).toBeCloseTo(0.02);
    errSpy.mockRestore();
  });

  it('output on the first attempt → no retry; the delta is emitted', async () => {
    const ctx = makeCtx();
    vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
      yield { type: 'delta', text: 'hi there' };
    });
    await handler({ messages: [], sessionUser: null }, ctx);
    expect(runAgentChat).toHaveBeenCalledTimes(1);
    // Chat-protocol frame (papercup-chat P-004): the wire event carries its type.
    expect(ctx.emit).toHaveBeenCalledWith('delta', { type: 'delta', text: 'hi there' });
  });

  it('a <spawn> tag in the turn dispatches through the nursery spawn engine', async () => {
    // Re-pin the workspace mocks: the URL-encoding test above swaps them to a
    // wonky id and vi.clearAllMocks() does not restore implementations.
    vi.mocked(activeWorkspaceId).mockReturnValue('ws-real');
    const { readSystemPrincipal } = await import('../../../system-principal');
    vi.mocked(readSystemPrincipal).mockResolvedValue({ workspaceId: 'ws-real' } as never);
    vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
      yield {
        type: 'delta',
        text: 'on it <spawn role="worker" harness="demo" feature="F-1" chunk="F-1.c1">',
      };
    });
    await handler({ messages: [], sessionUser: null }, makeCtx());
    expect(spawnAgentInHarness).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnAgentInHarness).mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws-real',
      harness: 'demo',
      role: 'worker',
      featureId: 'F-1',
      chunkId: 'F-1.c1',
      parentRole: 'operator',
    });
    // The retired plugin route must NOT be fetched anymore.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Uses the CURRENT wire spelling `<handoff>` — what the prompts now emit, so the
  // dispatch wiring is exercised on the tag that actually ships. The legacy
  // `<handoff_to_mug>` spelling stays covered at the parse+shape layer by
  // operator-sentinel-handoff.test.ts and by the 3-spelling block in
  // operator-converse-tags.test.ts.
  it('role=sentinel dispatches <handoff>; the <delegate_deep> TAG is inert (retired for the tool, D-007 §3); never spawn', async () => {
    vi.mocked(activeWorkspaceId).mockReturnValue('ws-real');
    const { readSystemPrincipal } = await import('../../../system-principal');
    vi.mocked(readSystemPrincipal).mockResolvedValue({ workspaceId: 'ws-real' } as never);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
      yield {
        type: 'delta',
        text:
          '<say>On it.</say>' +
          '<handoff summary="ship the export flow" harness="papercup">' +
          '<delegate_deep summary="compare the migration strategies" brief="Need the safer recommendation." harness="papercup">' +
          '<spawn role="worker" harness="demo" feature="F-1">',
      };
    });

    await handler(
      { messages: [], trigger: 'user_message', role: 'papercup', sessionUser: null },
      { ...makeCtx(), role: 'papercup' },
    );

    expect(dispatchSentinelHandoff).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchSentinelHandoff).mock.calls[0][0]).toMatchObject({
      summary: 'ship the export flow',
      harness: 'papercup',
    });
    // PARITY op-delegate-deep: the tag path no longer dispatches — the papercup
    // toolset carries voice:delegate_deep (called with wait:true) instead.
    expect(delegateDeep).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('<delegate_deep>'))).toBe(true);
    expect(spawnAgentInHarness).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('role=papercup runs the QUICK pin — gpt-5.6-luna:low ON codex — with voice:delegate_deep in its toolset (D-007 §3)', async () => {
    delete process.env.PAPERCUP_CHAT_MODEL;
    delete process.env.PAPERCUP_CHAT_BACKEND;
    vi.mocked(activeWorkspaceId).mockReturnValue('ws-real');
    const ctx = makeCtx();
    await handler(
      { messages: [], trigger: 'user_message', role: 'papercup', sessionUser: null },
      { ...ctx, role: 'papercup' },
    );
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as {
      model?: string;
      backend?: string;
      allowedTools?: string[];
      mcpConfig?: McpConfig;
    };
    expect(call.model).toBe('gpt-5.6-luna:low');
    expect(call.backend).toBe('codex');
    expect(call.allowedTools).toContain('mcp__agentmcp__voice:delegate_deep');
    expect(call.allowedTools).toContain('mcp__agentmcp__chat:ask_choice');
    // Owner trust (default): the mount is the superuser one, tools= carries the deep tool.
    const tools = new URL(mcpUrlOf(call.mcpConfig)!).searchParams.get('tools') ?? '';
    expect(tools.split(',')).toContain('voice:delegate_deep');
    // The provenance frame announces what actually runs (D-008).
    expect(ctx.emit).toHaveBeenCalledWith('provenance', { type: 'provenance', engine: 'codex', model: 'gpt-5.6-luna:low' });
    // The operator role is untouched by the pin.
    vi.mocked(runAgentChat).mockClear();
    await handler({ messages: [], trigger: 'user_message', sessionUser: null }, makeCtx());
    const op = vi.mocked(runAgentChat).mock.calls[0][0] as { model?: string; allowedTools?: string[] };
    expect(op.model).toBe('anthropic/claude-opus-4-7');
    expect(op.allowedTools).not.toContain('mcp__agentmcp__voice:delegate_deep');
  });

  // WI-10003608: avi-test's codex account was capped until Oct 3 and the retry re-ran
  // the same capped backend, so every portal turn died twice.
  const CODEX_CAP =
    'codex exited 1: You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase ' +
    'more credits or try again at Oct 3rd, 2026 5:30 PM.';
  const papercupTurn = () => {
    delete process.env.PAPERCUP_CHAT_MODEL;
    delete process.env.PAPERCUP_CHAT_BACKEND;
    vi.mocked(activeWorkspaceId).mockReturnValue('ws-real');
    const ctx = { ...makeCtx(), role: 'papercup' };
    return { ctx, run: () => handler({ messages: [], trigger: 'user_message', role: 'papercup', sessionUser: null }, ctx) };
  };
  const callOf = (i: number) => vi.mocked(runAgentChat).mock.calls[i][0] as { model?: string; backend?: string };

  it('papercup: a capped codex account fails the retry over to claude-code and re-announces provenance', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
      n += 1;
      if (n === 1) {
        yield { type: 'error', message: CODEX_CAP };
        return;
      }
      yield { type: 'delta', text: 'answered on claude' };
    });
    const { ctx, run } = papercupTurn();
    const res = await run();
    expect(runAgentChat).toHaveBeenCalledTimes(2);
    expect(callOf(0)).toMatchObject({ model: 'gpt-5.6-luna:low', backend: 'codex' });
    expect(callOf(1)).toMatchObject({ model: 'sonnet:low', backend: 'claude-code' });
    const provenance = ctx.emit.mock.calls.filter(([name]) => name === 'provenance').map(([, data]) => data);
    expect(provenance).toEqual([
      { type: 'provenance', engine: 'codex', model: 'gpt-5.6-luna:low' },
      { type: 'provenance', engine: 'claude-code', model: 'sonnet:low' },
    ]);
    expect(res.data.assembled).toBe('answered on claude');
    errSpy.mockRestore();
  });

  it('papercup: a transient rate limit keeps the same-backend retry', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
      n += 1;
      if (n === 1) {
        yield { type: 'error', message: 'codex exited 1: 429 Too Many Requests — retry after 30s' };
        return;
      }
      yield { type: 'delta', text: 'ok' };
    });
    const { run } = papercupTurn();
    await run();
    expect(runAgentChat).toHaveBeenCalledTimes(2);
    expect(callOf(1)).toMatchObject({ model: 'gpt-5.6-luna:low', backend: 'codex' });
    errSpy.mockRestore();
  });

  it('papercup: when the alternate also fails, the turn error names BOTH backends in order (WI-10004897)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
      n += 1;
      yield {
        type: 'error',
        message:
          n === 1
            ? CODEX_CAP
            : 'claude-code exited 1: API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
      };
    });
    const { run } = papercupTurn();
    // The first backend's cause (the cap) used to be dropped; only the 401 reached the user.
    await expect(run()).rejects.toThrow(
      /codex, model gpt-5\.6-luna:low: .*usage limit.*; then claude-code, model sonnet:low: .*401/,
    );
    expect(runAgentChat).toHaveBeenCalledTimes(2);
    expect(agentBackendCredentialVerdictMock).toHaveBeenCalledWith('claude-code');
    errSpy.mockRestore();
  });

  it('papercup: a failover whose alternate login has expired with no refresh token is skipped and named (WI-10004897)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    agentBackendCredentialVerdictMock.mockReturnValueOnce({ usable: false, reason: 'expired-no-refresh' });
    vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
      yield { type: 'error', message: CODEX_CAP };
    });
    const { ctx, run } = papercupTurn();
    await expect(run()).rejects.toThrow(
      /codex, model gpt-5\.6-luna:low: .*usage limit.*; failover to claude-code \(model sonnet:low\) skipped: .*expired and has no refresh token/,
    );
    // Neither a doomed spawn on the dead alternate nor a same-backend re-run of the cap.
    expect(runAgentChat).toHaveBeenCalledTimes(1);
    const provenance = ctx.emit.mock.calls.filter(([name]) => name === 'provenance');
    expect(provenance).toHaveLength(1);
    errSpy.mockRestore();
  });

  it('papercup: under the D-421 customer-identity spawn transform the local probe is NOT consulted and the failover runs', async () => {
    // The brain runs as the customer account there; this process cannot read its login, so a
    // local verdict would say `absent` for every alternate and wrongly skip every failover.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    agentBackendCredentialVerdictMock.mockReturnValue({ usable: false, reason: 'absent' });
    // converse's seam mock reads this switch, not the real transform configuration below.
    customerPiMocks.spawnTransform.mockReturnValue(true);
    configureAgentSpawnTransform((request) => ({
      command: request.command,
      args: [...request.args],
      cwd: request.cwd,
      env: request.env,
    }));
    try {
      let n = 0;
      vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
        n += 1;
        if (n === 1) {
          yield { type: 'error', message: CODEX_CAP };
          return;
        }
        yield { type: 'delta', text: 'answered on claude' };
      });
      const { run } = papercupTurn();
      const res = await run();
      expect(agentBackendCredentialVerdictMock).not.toHaveBeenCalled();
      expect(callOf(1)).toMatchObject({ model: 'sonnet:low', backend: 'claude-code' });
      expect(res.data.assembled).toBe('answered on claude');
    } finally {
      configureAgentSpawnTransform(undefined);
      customerPiMocks.spawnTransform.mockReturnValue(false);
      agentBackendCredentialVerdictMock.mockReturnValue({ usable: true, basis: 'refreshable' });
      errSpy.mockRestore();
    }
  });

  it('the operator role never fails over — only the papercup chat pin pairs backends', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
      yield { type: 'error', message: CODEX_CAP };
    });
    await expect(handler({ messages: [], sessionUser: null }, makeCtx())).rejects.toThrow(/no output/i);
    expect(runAgentChat).toHaveBeenCalledTimes(2);
    expect(callOf(1).model).toBe(callOf(0).model);
    expect(callOf(1).backend).toBe(callOf(0).backend);
    errSpy.mockRestore();
  });

  it('publishes redacted public manual returns, omits other tools and never observes owner returns', async () => {
    vi.mocked(runAgentChat).mockImplementation(async function* (opts): AnyGen {
      yield { type: 'tool_call', name: 'docs:get', input: {}, callId: 'docs-get-1' };
      opts.onToolResult?.({ name: 'docs:get', output: JSON.stringify({ marker: 'PUBLIC-ORCHARD', token: 'secret-fixture' }), isError: false, callId: 'docs-get-1' });
      yield { type: 'tool_call', name: 'docs:search', input: {}, callId: 'docs-search-1' };
      opts.onToolResult?.({ name: 'docs:search', output: 'public manual unavailable', isError: true, callId: 'docs-search-1' });
      opts.onToolResult?.({ name: 'documents:read', output: 'PRIVATE-FIXTURE', isError: false });
      yield { type: 'delta', text: 'hi' };
    });
    const publicCtx = { ...makeCtx(), role: 'papercup' };
    await handler({ messages: [], trigger: 'user_message', role: 'papercup', hostTrust: 'public',
      principalToken: 'portal-user-bearer', sessionUser: null }, publicCtx);
    const returns = publicCtx.emit.mock.calls.filter(([name]) => name === 'tool_result');
    expect(returns).toHaveLength(2);
    expect(publicCtx.emit.mock.calls.filter(([name]) => name === 'tool_call').map(([, data]) => data.callId))
      .toEqual(['docs-get-1', 'docs-search-1']);
    expect(returns[0][1]).toMatchObject({ name: 'docs:get', ok: true, callId: 'docs-get-1' });
    expect(returns[0][1].summary).toContain('PUBLIC-ORCHARD');
    expect(returns[0][1].summary).not.toContain('secret-fixture');
    expect(returns[1][1]).toMatchObject({ name: 'docs:search', ok: false, callId: 'docs-search-1' });
    expect(JSON.stringify(returns)).not.toContain('PRIVATE-FIXTURE');
    const ownerCtx = makeCtx();
    await handler({ messages: [], trigger: 'user_message', hostTrust: 'owner', sessionUser: null }, ownerCtx);
    expect(vi.mocked(runAgentChat).mock.calls.at(-1)?.[0].onToolResult).toBeUndefined();
    expect(ownerCtx.emit.mock.calls.some(([name]) => name === 'tool_result')).toBe(false);
  });

  it('hostTrust=public: NO superuser mount, doors + card + deep tool; tool-less without the boundary bearer (D-007 §2)', async () => {
    vi.mocked(activeWorkspaceId).mockReturnValue('ws-real');
    // Fail-closed: no principalToken ⇒ no mcpConfig at all, allowedTools empty —
    // even though the disk superuser token IS readable in this process.
    await handler(
      { messages: [], trigger: 'user_message', role: 'papercup', hostTrust: 'public', sessionUser: null },
      { ...makeCtx(), role: 'papercup' },
    );
    const bare = vi.mocked(runAgentChat).mock.calls[0][0] as { mcpConfig?: McpConfig; allowedTools?: string[] };
    expect(bare.mcpConfig).toBeUndefined();
    expect(bare.allowedTools).toEqual([]);
    // With the boundary's bearer: a plain mount, never superuser=1, never the disk token.
    vi.mocked(runAgentChat).mockClear();
    await handler(
      {
        messages: [],
        trigger: 'user_message',
        role: 'papercup',
        hostTrust: 'public',
        principalToken: 'portal-user-bearer',
        sessionUser: null,
      },
      { ...makeCtx(), role: 'papercup' },
    );
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { mcpConfig?: McpConfig; allowedTools?: string[] };
    const url = mcpUrlOf(call.mcpConfig)!;
    expect(url).not.toContain('superuser');
    expect(url).toContain('/api/mcp?principal=pi&workspace=ws-real');
    expect(call.mcpConfig?.mcpServers.agentmcp.headers.Authorization).toBe('Bearer portal-user-bearer');
    const tools = new URL(url).searchParams.get('tools') ?? '';
    expect(tools.split(',')).toEqual(['chat:ask_choice', 'voice:delegate_deep']);
    expect(call.allowedTools).not.toContain('tasks:read'); // the owner working set never crosses
  });

  // cup-lexicon-full-rename-2026-07-09 P-006 (dual-accept, leader-mandated amendment):
  // a live session may still hold the OLD prompt text (instructing it to emit
  // `<handoff_to_queen>`) in-context for the rest of its lifetime — the parser must
  // keep accepting the old tag until no such session remains. Drop once confirmed
  // clear (Slice H / P-010 cleanup sweep).
  it('role=sentinel dual-accepts the legacy <handoff_to_queen> tag', async () => {
    vi.mocked(activeWorkspaceId).mockReturnValue('ws-real');
    const { readSystemPrincipal } = await import('../../../system-principal');
    vi.mocked(readSystemPrincipal).mockResolvedValue({ workspaceId: 'ws-real' } as never);
    vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
      yield {
        type: 'delta',
        text: '<say>On it.</say><handoff_to_queen summary="ship the export flow" harness="papercup">',
      };
    });

    await handler(
      { messages: [], trigger: 'user_message', role: 'papercup', sessionUser: null },
      { ...makeCtx(), role: 'papercup' },
    );

    expect(dispatchSentinelHandoff).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchSentinelHandoff).mock.calls[0][0]).toMatchObject({
      summary: 'ship the export flow',
      harness: 'papercup',
    });
  });
});

describe('operator:converse — per-surface tool filtering (tui-operator-surface)', () => {
  it('keeps chat:ask_choice in allowedTools on surface="tui" (inline cards, Phase 2a)', async () => {
    // The pui now renders inline terminal cards + answers via /card-response
    // (sentinel-tui-shared-backend-and-cards-2026-06-22 Phase 2a), so the TUI
    // surface keeps chat:ask_choice — identical to the desktop surface.
    await handler(
      { messages: [], trigger: 'user_message', surface: 'tui', sessionUser: null },
      makeCtx(),
    );
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { allowedTools?: string[] };
    expect(call.allowedTools).toContain('tasks:read');
    expect(call.allowedTools).toContain('mcp__agentmcp__chat:ask_choice');
  });

  it('keeps chat:ask_choice on the default (desktop) surface', async () => {
    await handler({ messages: [], trigger: 'user_message', sessionUser: null }, makeCtx());
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { allowedTools?: string[] };
    expect(call.allowedTools).toContain('mcp__agentmcp__chat:ask_choice');
  });
});
