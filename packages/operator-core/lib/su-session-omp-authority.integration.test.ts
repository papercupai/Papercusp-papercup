/** Installed OMP + owned extension + actual engine + canonical MCP dispatch.
 * Private migrated PG and a deterministic provider keep every authority check
 * real without contacting a workspace operator or a provider account. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type BuildOptions } from 'esbuild';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { expect, it, vi } from 'vitest';
import { SU_SESSION_PROTOCOL_VERSION, SU_SESSION_SCHEMA } from '@papercusp/chat-protocol';
import { lookupByMcpName, type ProjectedTool } from '@papercusp/tooldef';
import { verifyNativeRuntimeBearer } from '@papercusp/agent-mcp/provisioning';
import { startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import { nativeBuilds } from '../../omp-plugin/build-native.mjs';
import { sqlMiningFixture } from '../test/_sql-mining-fixture';
import { startSuRpcEngine, type SuRpcEngine } from './su-session-rpc-engine';
import { startSuStdioPeer, type RpcFrame } from './su-session-stdio-peer';
import type { SuNativeToolCall } from './su-session-stdio-peer';
import { resolveAgentBinarySync } from './agent-bin-detect';
import { nativeInstalledPerUseTurns } from './agent-tools/per-use-chokepoint';
import { _configureSuSessionRoutingForTest, localSuSessionHostOwner } from './su-session-owner-routing';
import { publishReport } from './report-library';
import { flushPendingTelemetry } from './projected-tool-deps';
import { drainDetached } from './detached-imports';
import { flushFallbackObservations } from './degradation/fallback-observations';
import { activeWorkspaceId } from './workspace-registry';
import { classifyOwnerNativeSession } from './adv-sessions';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';

let authorityDb: Awaited<ReturnType<typeof sqlMiningFixture>> | undefined;
let authorityRoot = '';
const issuedBearers: string[] = [];
const children = vi.hoisted(() => new Map<string, ChildProcess>());
const nativeStderr = vi.hoisted(() => ({ text: '' }));
vi.mock('./task-manager/managed-spawn', () => ({ managedSpawn: async (binary: string, args: string[], _spec: unknown,
  options: { spawnOptions: object }) => {
  const child = spawn(binary, args, options.spawnOptions), taskId = randomUUID();
  child.stderr?.on('data', chunk => { nativeStderr.text = (nativeStderr.text + chunk).slice(-3000); });
  children.set(taskId, child); return { child, taskId };
} }));
vi.mock('./task-manager/control', () => ({ killTask: async (id: string) => {
  children.get(id)?.kill('SIGKILL'); return { ok: true };
} }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => { if (!authorityDb) throw new Error('Private PG unavailable'); return { sql: authorityDb.db.adminSql }; },
  getOrgPgApp: () => { if (!authorityDb) throw new Error('Private PG unavailable'); return { sql: authorityDb.db.appSql }; },
  createDedicatedOrgPg: () => { throw new Error('No inherited pools'); },
  getOrgPgListener: () => { throw new Error('No inherited listeners'); },
  getOrgPgLosslessBigint: () => { throw new Error('No inherited pools'); },
  getHarnessPg: () => { throw new Error('No inherited pools'); },
  withWorkspace: async (workspace: string, callback: (tx: unknown) => Promise<unknown>) => {
    if (!authorityDb) throw new Error('Private PG unavailable');
    return authorityDb.db.appSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`; return callback(tx);
    });
  },
}));
vi.mock('@papercusp/agent-mcp/provisioning', async original => {
  const actual = await original<typeof import('@papercusp/agent-mcp/provisioning')>();
  return { ...actual, provisionNativeRuntimeBearer: async (input: Parameters<typeof actual.provisionNativeRuntimeBearer>[0]) => {
    const issued = await actual.provisionNativeRuntimeBearer(input); issuedBearers.push(issued.bearer); return issued;
  } };
});
vi.mock('./agent-tools/operator-tool-catalogue', () => ({
  loadOperatorToolCatalogue: async () => { await import('./agent-tools/reports/get'); },
}));
vi.mock('./memory/mcp-prelude', () => ({ buildMcpPrelude: async () => null }));
vi.mock('./workspace-registry', async original => ({
  ...await original<typeof import('./workspace-registry')>(), activeWorkspaceId: () => 'sql-mining-test',
}));
vi.mock('./superuser-token', async original => ({
  ...await original<typeof import('./superuser-token')>(), readSuperuserToken: () => 'private-fixture-operator-token',
}));
vi.mock('./cupboard/identity-activation-gate-io', () => ({ admitNativeIdentityInference: async () => ({ ok: true }) }));
vi.mock('./su-session-persistence', async original => ({
  ...await original<typeof import('./su-session-persistence')>(),
  persistSuSessionDescriptor: async () => true, bindSuSessionToAdvSession: async () => ({ status: 'bound' }),
  readDurableSuSession: async () => null,
}));
vi.mock('./su-session-commands', async original => ({
  ...await original<typeof import('./su-session-commands')>(), loadSuOwnerTurnReceipts: async () => [],
}));
vi.mock('../../../apps/operator/scripts/psu-launcher.mjs', async original => ({
  ...await original<typeof import('../../../apps/operator/scripts/psu-launcher.mjs')>(),
  assertLaunchPersona: () => {}, resolveOmpSessionModel: (selector: string) => selector,
  writeOmpSessionConfigDir: () => {
    if (!authorityRoot) throw new Error('Private OMP config unavailable');
    return relative(homedir(), authorityRoot);
  },
  prepareSuLaunch: (boot: BootstrapSuResult) => ({ env: { ...boot.envelopeEnv }, args: [], modelArgs: [], model: 'native-authority-fixture/proof' }),
}));

it('joins actual OMP root input, built-in shell execution and exact MCP calls with PG possession and changing resource ACL', async () => {
  const binary = resolveAgentBinarySync('omp');
  nativeStderr.text = '';
  expect(binary, 'installed OMP required; no protocol peer substitution').toBeTruthy();
  const root = mkdtempSync(join(tmpdir(), 'omp-engine-authority-')), agentDir = join(root, 'agent');
  authorityRoot = root;
  mkdirSync(agentDir);
  const workspaceId = 'sql-mining-test', harness = 'mining-test', owner = 'su-private-omp-authority';
  const canonical = 'reports:get', nativeName = 'mcp__papercusp_su_reports_get';
  const calls = ['native-authority-1', 'native-authority-2'];
  const shellCall = 'native-authority-shell', sentinel = 'omp-native-shell-sentinel';
  const shellArgs = { command: `printf '%s' '${sentinel}'` };
  const rewrittenCall = 'native-authority-rewritten-shell';
  const originalSentinel = 'omp-original-command-must-not-execute', executedSentinel = 'omp-rewritten-command-executed';
  const originalArgs = { command: `printf '%s' '${originalSentinel}'` };
  const executedArgs = { command: `printf '%s' '${executedSentinel}'` };
  const hookLog = join(root, 'native-shell-hooks.jsonl');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const principal = { kind: 'system' as const, slug: 'system:superuser', workspaceId,
    authMethod: 'bearer-token' as const, trust: 'trusted' as const, capabilities: new Set(['*']) };
  const resolvePrincipal = vi.fn(async () => principal), readOwner = vi.fn(async () => localSuSessionHostOwner());
  const frames: RpcFrame[] = [], errors: string[] = [], results: unknown[] = [], handlers: unknown[] = [];
  const originalHookCalls: SuNativeToolCall[] = [];
  const shellSessions: Array<{ type: unknown; toolCallId: unknown; nativeId: string | null | undefined }> = [];
  const servers = new Set<McpServer>();
  let engine: SuRpcEngine | undefined, pg: DedicatedNativePg | undefined, nativeId = '', advSessionId = 0;
  let reportTool: ProjectedTool | undefined, originalFn: ProjectedTool['fn'] | undefined;
  let receivedCalls = 0;
  let phase = 'private-pg';
  const savedAdmin = process.env.PAPERCUSP_TEST_PG_ADMIN_URL, savedHome = process.env.PAPERCUSP_HOME;
  process.env.PAPERCUSP_HOME = root;
  writeFileSync(join(root, 'superuser-token'), 'private-fixture-operator-token', { mode: 0o600 });
  const actualHost = await vi.importActual<typeof import('./endpoint-route/routes/transport/_mcp-host')>('./endpoint-route/routes/transport/_mcp-host');
  const http = createServer(async (request, response) => {
    try {
      const server = new McpServer({ name: 'papercusp-su', version: '1' }, actualHost.mcpHostServerOptions());
      servers.add(server);
      const setHandler = server.server.setRequestHandler.bind(server.server);
      server.server.setRequestHandler = (schema, handler) => setHandler(schema, async (message, extra) => {
        const enriched = { ...extra, requestInfo: { ...extra.requestInfo,
          headers: request.headers, url: new URL(request.url!, `http://${request.headers.host}`) } };
        if (message.method !== 'tools/call') return handler(message, enriched);
        try {
        const index = receivedCalls++;
        const callId = String(message.params?._meta?.callId);
        expect(message.params?._meta).toMatchObject({ threadId: nativeId, callId: calls[index] });
        expect(request.headers['x-papercusp-native-runtime']).toBeUndefined();
        expect(frames).toContainEqual(expect.objectContaining({ type: 'message_start', message: expect.objectContaining({
          role: 'user', content: [{ type: 'text', text: 'Exercise private OMP authority twice.' }] }) }));
        expect(frames.some(frame => frame.type === 'agent_start')).toBe(true);
        expect(frames.some(frame => frame.type === 'agent_end')).toBe(false);
        const nativeCall = frames.filter(frame => frame.type === 'message_end' && (frame.message as RpcFrame)?.role === 'assistant')
          .flatMap(frame => (frame.message as RpcFrame).content as RpcFrame[]).find(block => block.id === callId);
        expect(nativeCall).toMatchObject({ type: 'toolCall', name: nativeName, arguments: message.params?.arguments });
        const built = await actualHost.tryBuildSpawnContext({ ...enriched, _meta: message.params?._meta });
        const bindingDiagnostic = built.kind === 'ok' ? { workspaceId: built.ctx.workspaceId,
          harnessSlug: built.ctx.harnessSlug, uiClientId: built.ctx.uiClientId, advSessionId: built.ctx.advSessionId,
          origin: built.ctx.requestOrigin } : built;
        expect(built, JSON.stringify(bindingDiagnostic)).toMatchObject({ kind: 'ok', ctx: { workspaceId, harnessSlug: harness, uiClientId: owner, advSessionId,
          requestOrigin: { nativeSession: { binding: 'bound', valueFingerprint: hash(nativeId), callIdFingerprint: hash(callId) } } } });
        const result = await handler(message, enriched);
        const text = JSON.stringify(result);
        expect(text, text.slice(0, 2000)).toContain(index === 0 ? 'private canonical OMP body' : 'access_denied');
        if (index > 0) expect(text).not.toContain('private canonical OMP body');
        results.push(result);
        if (built.kind !== 'ok') throw new Error('Missing native spawn');
        expect((await actualHost.retainNativeRequestPrincipalForDispatch(built.ctx, canonical, message.params?.arguments, '')).authenticatedPrincipal)
          .toBeUndefined(); // The same call cannot claim the capability twice.
        return result;
        } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); throw error; }
      });
      actualHost.registerMcpHost(server);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport); await transport.handleRequest(request, response);
    } catch (error) { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  try {
    pg = await startDedicatedNativePg({ baseDir: root, settings: { max_connections: '120', fsync: 'off', synchronous_commit: 'off' } });
    process.env.PAPERCUSP_TEST_PG_ADMIN_URL = pg.getConnectionUri();
    authorityDb = await sqlMiningFixture();
    const db = authorityDb.db;
    expect(new URL(db.adminDsn).port).toBe(String(pg.port));
    const [row] = await db.adminSql`INSERT INTO harness_shared.adv_sessions (workspace_id,mode,coord_owner_id,agent)
      VALUES (${workspaceId},'console',${owner},'omp') RETURNING id`;
    advSessionId = Number(row!.id);
    expect(activeWorkspaceId(), 'engine native-link lookup must use this private workspace').toBe(workspaceId);
    const report = await publishReport(db.adminSql, { workspaceId, title: 'Private OMP ACL fixture',
      bodyMd: 'private canonical OMP body', visibility: 'workspace' }, { authorOwnerId: 'another-author' });
    await import('./agent-tools/reports/get');
    reportTool = lookupByMcpName(canonical); if (!reportTool) throw new Error('Production report reader missing');
    originalFn = reportTool.fn; const realFn = originalFn;
    reportTool.fn = async (input, ctx) => {
      expect(ctx.principal).toStrictEqual(principal); handlers.push(ctx.principal);
      expect(ctx.requestOrigin?.nativeSession).toMatchObject({ binding: 'bound', carrier: 'meta:threadId', candidateAdvSessionId: advSessionId });
      const result = await realFn(input, ctx);
      await db.adminSql`UPDATE harness_shared.report_library SET visibility='owner' WHERE workspace_id=${workspaceId} AND report_id=${report.reportId}`;
      return result;
    };
    _configureSuSessionRoutingForTest({ readOwner });
    http.listen(0, '127.0.0.1'); await once(http, 'listening');
    const address = http.address(); if (!address || typeof address === 'string') throw new Error('Private MCP unavailable');
    const url = new URL(`http://127.0.0.1:${address.port}/api/mcp`);
    for (const [key, value] of Object.entries({ superuser: '1', workspace: workspaceId, harness, client: owner, tools: canonical, ctx_tier: 'full' })) url.searchParams.set(key, value);
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
      'papercusp-su': { url: url.href, headers: { Authorization: 'Bearer private-fixture-operator-token' } },
    } }));
    phase = 'owned-extension-build';
    const checkout = fileURLToPath(new URL('../../../', import.meta.url));
    const recipe = nativeBuilds(checkout, root + '/').find((option: BuildOptions) => option.format === 'esm');
    if (!recipe) throw new Error('Production native extension recipe missing'); await build(recipe);
    const provider = join(root, 'local-provider.ts');
    writeFileSync(provider, `import { appendFileSync } from 'node:fs';
    export default function(pi) {
      let turn = 0;
      // Native extension callbacks supply the session and original input. This
      // private observation log is test evidence, never a capture authority.
      const record = (event, ctx, returnedInput) => appendFileSync(${JSON.stringify(hookLog)},
        JSON.stringify({ event, nativeId: ctx.sessionManager.getSessionId(), returnedInput }) + '\\n');
      pi.on('tool_call', (event, ctx) => {
        if (![${JSON.stringify(shellCall)}, ${JSON.stringify(rewrittenCall)}].includes(event.toolCallId)) return;
        const input = event.toolCallId === ${JSON.stringify(rewrittenCall)} ? ${JSON.stringify(executedArgs)} : undefined;
        record(event, ctx, input);
        if (input) return { input };
      });
      pi.on('tool_result', (event, ctx) => {
        if ([${JSON.stringify(shellCall)}, ${JSON.stringify(rewrittenCall)}].includes(event.toolCallId)) record(event, ctx);
      });
      pi.registerProvider('native-authority-fixture', {
        api: 'native-authority-fixture-api', apiKey: 'local-only', baseUrl: 'http://unused.invalid',
        models: [{ id: 'proof', name: 'Local authority', reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
        streamSimple(model) {
          if (++turn > 5) throw new Error('Unexpected inference');
          const content = turn <= 2 ? [{ type: 'toolCall', id: 'native-authority-' + turn,
            name: ${JSON.stringify(nativeName)}, arguments: ${JSON.stringify({ id: report.reportId })} }]
            : turn === 3 ? [{ type: 'toolCall', id: ${JSON.stringify(shellCall)}, name: 'bash',
              arguments: ${JSON.stringify(shellArgs)} }]
            : turn === 4 ? [{ type: 'toolCall', id: ${JSON.stringify(rewrittenCall)}, name: 'bash',
              arguments: ${JSON.stringify(originalArgs)} }] : [{ type: 'text', text: 'Complete' }];
          const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: turn <= 4 ? 'toolUse' : 'stop', timestamp: Date.now() };
          return { async *[Symbol.asyncIterator]() { yield { type: 'start', partial: message };
            if (turn <= 4) yield { type: 'toolcall_end', contentIndex: 0, toolCall: content[0], partial: message };
            yield { type: 'done', reason: message.stopReason, message }; }, result: async () => message };
        },
      });
    }`);
    const promptFile = join(root, 'su.md'); writeFileSync(promptFile, 'Private offline OMP authority.\n'.repeat(100));
    const boot = { status: 'ok', specificationRevision: 'fixture-spec', stateRevision: 'fixture-state', compositionSource: 'blueprint',
      agent: 'omp', sessionId: advSessionId, nativeSessionId: null, workspaceId, harnessSlug: harness, planSlug: null,
      codexHome: null, coordExtPath: null, cwd: root, promptFile, envelopeEnv: { PAPERCUSP_SID: owner, PAPERCUSP_WORKSPACE: workspaceId } } satisfies BootstrapSuResult;
    phase = 'actual-engine';
    engine = startSuRpcEngine(boot, { operation: 'created', backend: 'omp', advSessionId, ownerId: owner,
      workspaceId, harnessSlug: harness, planSlug: null, nativeSession: null }, {
      agentChatId: 'private-omp-authority', startupTimeoutMs: 30_000, deliveryTimeoutMs: 15_000,
      resolveRequestPrincipal: resolvePrincipal, servedAccountReader: async () => null,
      peerFactory: options => {
        const nativeArgs = [...options.args];
        const ownedIndex = nativeArgs.findIndex(arg => arg.endsWith('/native-extension.mjs'));
        expect(ownedIndex, 'production HTTP launch must select its owned extension').toBeGreaterThan(0);
        expect(nativeArgs[ownedIndex - 1]).toBe('-e');
        // Build the selected package-owned artifact from current sources into
        // the private root; do not load a stale installed dist generation.
        nativeArgs[ownedIndex] = join(root, 'native-extension.mjs');
        const profile = JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8'));
        expect(profile.papercuspNativeMcp).toMatchObject({ version: 1, mode: 'http',
          servers: { 'papercusp-su': { url: url.href } } });
        expect(profile.mcpServers).not.toHaveProperty('papercusp-su');
        return startSuStdioPeer({ ...options, binary: binary!,
        onNativeToolCall: async call => {
          try {
          expect(options.onNativeToolCall, 'production original-hook host callback required').toBeTypeOf('function');
          await options.onNativeToolCall!(call);
          originalHookCalls.push(structuredClone(call));
          expect(frames.some(frame => frame.type === 'tool_execution_start' && frame.toolCallId === call.callId)).toBe(false);
          } catch (error) { errors.push('native-hook: ' + String(error)); throw error; }
        },
        args: [...nativeArgs, '--no-extensions', '--no-skills', '--no-rules', '--no-session', '--extension', provider],
        env: { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: join(root, 'sessions') },
        onMessage: frame => {
          if ([shellCall, rewrittenCall].includes(String(frame.toolCallId)) && ['tool_execution_start', 'tool_execution_end'].includes(String(frame.type))) {
            const current = engine?.nativeSession();
            shellSessions.push({ type: frame.type, toolCallId: frame.toolCallId, nativeId: current?.backend === 'omp' ? current.ompThreadId : null });
          }
          frames.push(frame); options.onMessage(frame);
        },
      }); },
    });
    await engine.ready;
    const native = engine.nativeSession(); if (native.backend !== 'omp') throw new Error('Unexpected backend');
    nativeId = native.ompThreadId!;
    // The engine links OMP through its own native column. A stale generic id
    // or Codex launch alias must never lend authority to this OMP child.
    const [linked] = await db.adminSql`SELECT session_id, omp_thread_id FROM harness_shared.adv_sessions WHERE id=${advSessionId}`;
    expect(linked).toMatchObject({ session_id: null, omp_thread_id: nativeId });
    const bindingInput = { workspaceId, ownerId: owner, sessionId: nativeId };
    for (const explicit of [false, true]) {
      const incarnation = explicit ? { advSessionId } : {};
      await expect(classifyOwnerNativeSession({ ...bindingInput, ...incarnation }))
        .resolves.toMatchObject({ binding: 'bound', advSessionId });
      await db.adminSql`UPDATE harness_shared.adv_sessions SET session_id='unrelated-legacy-id', child_launch_session_id='unrelated-launch-id' WHERE id=${advSessionId}`;
      for (const sessionId of ['unrelated-legacy-id', 'unrelated-launch-id']) {
        await expect(classifyOwnerNativeSession({ ...bindingInput, ...incarnation, sessionId }))
          .resolves.toMatchObject({ binding: 'foreign' });
      }
      await expect(classifyOwnerNativeSession({ ...bindingInput, ...incarnation }))
        .resolves.toMatchObject({ binding: 'bound', advSessionId });
      await db.adminSql`UPDATE harness_shared.adv_sessions SET session_id=NULL, child_launch_session_id=NULL WHERE id=${advSessionId}`;
    }
    expect(issuedBearers).toHaveLength(1);
    const possession = { workspaceId, ownerId: owner, advSessionId, provider: 'omp' as const };
    expect(await verifyNativeRuntimeBearer(issuedBearers[0]!, possession)).toBe(true);
    expect(await verifyNativeRuntimeBearer(issuedBearers[0]!, { ...possession, advSessionId: advSessionId + 1 })).toBe(false);
    phase = 'owner-input';
    const host = engine.adapter.host;
    await host.startCommand({ schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION,
      issuedAt: new Date().toISOString(), target: host.descriptor().identity, type: 'owner_turn', commandId: 'omp-authority',
      turnId: 'owner-omp-authority', content: 'Exercise private OMP authority twice.' }).terminal;
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'agent_end')).toBe(true), { timeout: 20_000 });
    expect(errors).toEqual([]); expect(results).toHaveLength(2); expect(handlers).toHaveLength(2);
    expect(originalHookCalls).toStrictEqual([
      ...calls.map(callId => ({ nativeSessionId: nativeId, callId, tool: nativeName, arguments: { id: report.reportId } })),
      { nativeSessionId: nativeId, callId: shellCall, tool: 'bash', arguments: shellArgs },
      { nativeSessionId: nativeId, callId: rewrittenCall, tool: 'bash', arguments: originalArgs },
    ]);
    // These are real built-in execution events from the installed process,
    // not a canonical MCP dispatch or a protected capture/funding receipt.
    expect(shellSessions).toEqual([shellCall, rewrittenCall].flatMap(toolCallId => [
      { type: 'tool_execution_start', toolCallId, nativeId }, { type: 'tool_execution_end', toolCallId, nativeId },
    ]));
    const shellStart = frames.findIndex(frame => frame.type === 'tool_execution_start' && frame.toolCallId === shellCall);
    const shellEnd = frames.findIndex(frame => frame.type === 'tool_execution_end' && frame.toolCallId === shellCall);
    const rootStart = frames.findIndex(frame => frame.type === 'message_start' && (frame.message as RpcFrame)?.role === 'user');
    const agentStart = frames.findIndex(frame => frame.type === 'agent_start');
    const agentEnd = frames.findIndex(frame => frame.type === 'agent_end');
    const shellRequest = frames.findIndex(frame => frame.type === 'message_end' && (frame.message as RpcFrame)?.role === 'assistant'
      && ((frame.message as RpcFrame).content as RpcFrame[]).some(block => block.id === shellCall));
    expect(rootStart).toBeGreaterThanOrEqual(0); expect(agentStart).toBeGreaterThanOrEqual(0);
    expect(shellRequest).toBeGreaterThan(Math.max(rootStart, agentStart));
    expect(((frames[shellRequest]!.message as RpcFrame).content as RpcFrame[]).find(block => block.id === shellCall))
      .toStrictEqual({ type: 'toolCall', id: shellCall, name: 'bash', arguments: shellArgs });
    expect(shellStart).toBeGreaterThan(shellRequest); expect(shellEnd).toBeGreaterThan(shellStart);
    expect(agentEnd).toBeGreaterThan(shellEnd);
    expect(frames[shellStart]).toMatchObject({ toolName: 'bash', args: shellArgs });
    expect(frames[shellEnd]).toMatchObject({ toolName: 'bash', isError: false });
    const shellResult = frames[shellEnd]!.result as RpcFrame;
    expect(shellResult.content).toEqual([{ type: 'text',
      text: expect.stringMatching(new RegExp(`^${sentinel}\\n\\nWall time: \\d+(?:\\.\\d+)? seconds$`)) }]);
    const shellMessage = frames.find(frame => frame.type === 'message_end' && (frame.message as RpcFrame)?.role === 'toolResult'
      && (frame.message as RpcFrame).toolCallId === shellCall)?.message as RpcFrame | undefined;
    expect(shellMessage).toMatchObject({ toolCallId: shellCall, toolName: 'bash', isError: false, content: shellResult.content });
    const rewrittenRequest = frames.findIndex(frame => frame.type === 'message_end' && (frame.message as RpcFrame)?.role === 'assistant'
      && ((frame.message as RpcFrame).content as RpcFrame[]).some(block => block.id === rewrittenCall));
    const rewrittenStart = frames.findIndex(frame => frame.type === 'tool_execution_start' && frame.toolCallId === rewrittenCall);
    const rewrittenEnd = frames.findIndex(frame => frame.type === 'tool_execution_end' && frame.toolCallId === rewrittenCall);
    expect(rewrittenRequest).toBeGreaterThan(shellEnd);
    // OMP bakes hook revisions into its assistant message before emitting
    // message_end. Only the original native tool_call hook below sees the
    // pre-rewrite input; the downstream message cannot certify that input.
    expect(((frames[rewrittenRequest]!.message as RpcFrame).content as RpcFrame[]).find(block => block.id === rewrittenCall))
      .toStrictEqual({ type: 'toolCall', id: rewrittenCall, name: 'bash', arguments: executedArgs });
    expect(rewrittenStart).toBeGreaterThan(rewrittenRequest); expect(rewrittenEnd).toBeGreaterThan(rewrittenStart);
    expect(agentEnd).toBeGreaterThan(rewrittenEnd);
    expect(frames[rewrittenStart]).toMatchObject({ toolName: 'bash', args: executedArgs });
    expect(frames[rewrittenEnd]).toMatchObject({ toolName: 'bash', isError: false });
    const rewrittenResult = frames[rewrittenEnd]!.result as RpcFrame;
    expect(rewrittenResult.content).toEqual([{ type: 'text',
      text: expect.stringMatching(new RegExp(`^${executedSentinel}\\n\\nWall time: \\d+(?:\\.\\d+)? seconds$`)) }]);
    expect(JSON.stringify(rewrittenResult)).not.toContain(originalSentinel);
    expect(frames.find(frame => frame.type === 'message_end' && (frame.message as RpcFrame)?.role === 'toolResult'
      && (frame.message as RpcFrame).toolCallId === rewrittenCall)?.message)
      .toMatchObject({ toolCallId: rewrittenCall, toolName: 'bash', isError: false, content: rewrittenResult.content });
    const hookRows = readFileSync(hookLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(hookRows).toHaveLength(4);
    expect(hookRows).toMatchObject([
      { nativeId, event: { type: 'tool_call', toolName: 'bash', toolCallId: shellCall, input: shellArgs } },
      { nativeId, event: { type: 'tool_result', toolName: 'bash', toolCallId: shellCall, input: shellArgs,
        isError: false, content: shellResult.content } },
      { nativeId, event: { type: 'tool_call', toolName: 'bash', toolCallId: rewrittenCall, input: originalArgs }, returnedInput: executedArgs },
      { nativeId, event: { type: 'tool_result', toolName: 'bash', toolCallId: rewrittenCall, input: executedArgs,
        isError: false, content: rewrittenResult.content } },
    ]);
    expect(hookRows[0]).not.toHaveProperty('returnedInput');
    expect(hookRows[2].event.input).not.toEqual(hookRows[3].event.input);
    expect(readOwner).toHaveBeenCalledTimes(2); expect(resolvePrincipal.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify({ frames, descriptor: host.descriptor(), config: readFileSync(join(agentDir, 'mcp.json'), 'utf8'), provider: readFileSync(provider, 'utf8') }))
      .not.toContain(issuedBearers[0]);
    expect(await nativeInstalledPerUseTurns.resolveRequestPrincipal({ workspaceId, advSessionId, ownerId: owner,
      nativeSessionFingerprint: hash(nativeId), callIdFingerprint: hash(calls[1]!), toolName: canonical,
      arguments: { id: report.reportId }, runtimeBearer: '' })).toBeNull();
  } catch (error) {
    const diagnostic = frames.filter(frame => ['message_end', 'tool_execution_end', 'notice', 'extension_ui_request', 'auto_compaction_end'].includes(String(frame.type)))
      .slice(-12).map(frame => ({ type: frame.type, method: frame.method, toolCallId: frame.toolCallId,
        toolName: frame.toolName, args: frame.args, message: JSON.stringify(frame.message)?.slice(0, 800),
        result: JSON.stringify(frame.result)?.slice(0, 800), error: frame.error, isError: frame.isError }));
    throw new Error(`Private OMP authority failed at ${phase}; errors=${JSON.stringify(errors)}; results=${results.length}; hookCalls=${originalHookCalls.length}; stderr=${JSON.stringify(nativeStderr.text)}; native=${JSON.stringify(diagnostic).slice(-10000)}`, { cause: error });
  } finally {
    try {
      if (engine) { await engine.close(); engine.adapter.dispose(); }
      expect([...children.values()].every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
      children.clear();
      await Promise.allSettled([...servers].map(server => server.close()));
      http.closeAllConnections(); if (http.listening) await new Promise<void>(resolve => http.close(() => resolve()));
      if (reportTool && originalFn) reportTool.fn = originalFn;
      _configureSuSessionRoutingForTest(); await flushPendingTelemetry(); await drainDetached();
      if (authorityDb) expect((await flushFallbackObservations({ sql: authorityDb.db.adminSql })).failed).toBe(0);
      await authorityDb?.cleanup(); authorityDb = undefined;
    } finally {
      if (savedAdmin === undefined) delete process.env.PAPERCUSP_TEST_PG_ADMIN_URL; else process.env.PAPERCUSP_TEST_PG_ADMIN_URL = savedAdmin;
      if (savedHome === undefined) delete process.env.PAPERCUSP_HOME; else process.env.PAPERCUSP_HOME = savedHome;
      await pg?.stop(); authorityRoot = ''; rmSync(root, { recursive: true, force: true });
    }
  }
}, 120_000);
