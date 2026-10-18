import { it, expect, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer, type Server } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { cleanupScopedNativeFixtureDatabase } from '../vitest-shims/scoped-native-fixture-cleanup';
import { createOrgTestDb, type OrgTestDb } from '../../../packages/operator-core/test/_org-test-db';

const privateDatabase = vi.hoisted(() => ({ sql: undefined as unknown as OrgTestDb['adminSql'] }));
// Keep the native workflow on a fully migrated, disposable database. The
// maintained handlers, checkpoint writer and terminal-state SQL stay real.
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: privateDatabase.sql }),
}));

const homeAllocation = vi.hoisted(() => ({ key: '', path: '' }));
vi.mock('@papercusp/orchestrator/session-launch-dirs', async (original) => {
  const actual = await original<typeof import('@papercusp/orchestrator/session-launch-dirs')>();
  return { ...actual, codexHomeForSessionKey: (key: string | number) =>
    key === homeAllocation.key ? homeAllocation.path : actual.codexHomeForSessionKey(key) };
});

const listen = (s: Server) => new Promise<number>((resolve, reject) => {
  s.once('error', reject); s.listen(0, '127.0.0.1', () => resolve((s.address() as any).port));
});
const stop = (s: Server) => new Promise<void>((resolve, reject) => s.close(e => e ? reject(e) : resolve()));

it('enforces the scoped boundary through the actual launcher and final managed PTY', async () => {
  // The actual sandbox replaces /dev/shm; fixtures must survive that mount.
  const cwd = mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'psu-native-boundary-physical-'));
  const resultPath = join(cwd, 'native-result');
  const calls = [0, 0, 0];
  const servers = calls.map((_, i) => createServer((_req, res) => { calls[i]++; res.end(`endpoint-${i}`); }));
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  try {
    const [gateway, operator, forbidden] = await Promise.all(servers.map(listen));
    const codexHome = join(cwd, 'codex-home'); mkdirSync(codexHome);
    const env = hermeticEnv({ PAPERCUSP_AGENT: 'codex', CODEX_HOME: codexHome,
      PAPERCUSP_SID: `test-scoped-native-${process.pid}`, PAPERCUSP_PSU_HEADLESS: '1', PAPERCUSP_PSU_PTY: '1',
      PAPERCUSP_MCP_PROXY: '0', PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${operator}`,
      PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify({ baseURL: `http://127.0.0.1:${gateway}`, token: 'a'.repeat(64) }) });
    const reach = (port: number, extra = '') => `/usr/bin/curl --silent --show-error --fail --max-time 3 ${extra} http://127.0.0.1:${port}`;
    const script = [
      'set -e', `${reach(gateway)} > ${quote(resultPath)}`, `printf '\\n' >> ${quote(resultPath)}`,
      `${reach(operator)} >> ${quote(resultPath)}`, `printf '\\n' >> ${quote(resultPath)}`,
      `if ${reach(forbidden)}; then exit 41; fi`,
      `if ${reach(gateway, "--noproxy '*' ")}; then exit 42; fi`,
      `printf 'BOUNDARY_VERIFIED\\n' >> ${quote(resultPath)}`,
    ].join('\n');
    const launcher = fileURLToPath(new URL('../scripts/psu-launcher.mjs', import.meta.url));
    // This fixture runs the production runWrapper, not a replacement spawn.
    // Native work is only the local shell/socket check, with no model calls.
    const fixture = join(cwd, 'launcher-fixture.mjs');
    writeFileSync(fixture, `import { runWrapper } from ${JSON.stringify(launcher)};\nrunWrapper({wrapperBin:'/bin/sh',args:${JSON.stringify(['-c', script])},cwd:${JSON.stringify(cwd)},preserveCwd:true,envelopeEnv:process.env,reportSessionEndedImpl:async()=>{},onSpawn:()=>{}});\n`);
    const child = spawn(process.execPath, [fixture], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Final native PTY boundary fixture exceeded 20 seconds')); }, 20_000);
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('close', c => { clearTimeout(timer); resolve(c); });
    });
    expect(code, output).toBe(0);
    expect(existsSync(resultPath), output).toBe(true);
    expect(readFileSync(resultPath, 'utf8')).toBe('endpoint-0\nendpoint-1\nBOUNDARY_VERIFIED\n');
    expect(calls[0]).toBe(1);
    expect(calls[2]).toBe(0);
  } finally {
    await Promise.all(servers.map(s => s.listening ? stop(s) : Promise.resolve()));
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);

it.each(['direct', 'metered'] as const)('delivers frozen context and a scoped work-item workflow through installed Codex and maintained handlers (%s)', async route => {
  const fixtureRoot = mkdtempSync('/tmp/psu-native-frozen-context-');
  const cwd = join(fixtureRoot, 'checkout');
  const codexHome = join(cwd, 'codex-home');
  const frozenMarker = `FROZEN_CONTEXT_${randomUUID()}`;
  const roleMarker = `FROZEN_ROLE_${randomUUID()}`;
  const ambientMarker = `AMBIENT_OUTSIDE_${randomUUID()}`;
  const owner = `test-scoped-frozen-${randomUUID()}`;
  const providerCalls: Record<string, unknown>[] = [], reads: unknown[] = [], errors: unknown[] = [];
  let workflowIndex = 0, discoveryCount = 0;
  const workflowRequestIndexes: number[] = [];
  const workflowCalls: Array<{ name: string; args: unknown; result: unknown }> = [];
  const checkpointMarker = `NATIVE_CHECKPOINT_${randomUUID()}`;
  const completionMarker = `NATIVE_COMPLETION_${randomUUID()}`;
  const own = { id: `F-native-${randomUUID()}`, harness: 'fixture' };
  const neighbor = `F-neighbor-${randomUUID()}`;
  const priorWorkspace = process.env.PAPERCUSP_WORKSPACE_ID;
  let db: OrgTestDb | undefined;
  let clearConfinement: (() => void) | undefined;
  const requestPaths: string[] = [];
  const mcpMethods: unknown[] = [];
  const hosts: McpServer[] = [];
  const dependencyPreflight: Array<{ name: string; status: number | null; signal: string | null; error?: string; path: string }> = [];
  let probe: Client | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let server: Server | undefined;
  let metered: { stop: () => Promise<void> } | undefined;
  let revokeProvider: (() => void) | undefined;
  const admissionEvidence: Array<{ target: string; bodySha256: string; openBeforeSend: number }> = [];
  const countedInputs: Record<string, unknown>[] = [];
  const gatewayErrors: string[] = [];
  const admissionStages: Record<string, unknown>[] = [];
  let firstNativeAdmissionRequest: Record<string, unknown> | undefined;
  let rejectedNativeAdmissionRequest: Record<string, unknown> | undefined;
  let readReservations: (() => Promise<unknown>) | undefined;
  try {
  mkdirSync(cwd);
  // Match installed SRT's bounded `which` precondition before allocating the
  // database. File existence alone cannot establish that its child probe works.
  const preflightEnv = hermeticEnv({ HOME: codexHome });
  for (const name of ['codex', 'node', 'srt', 'bwrap', 'socat']) {
    const result = spawnSync('which', [name], { env: preflightEnv, encoding: 'utf8', timeout: 1_000 });
    dependencyPreflight.push({ name, status: result.status, signal: result.signal,
      error: result.error?.message, path: result.stdout?.trim() ?? '' });
    expect(result.status, JSON.stringify(dependencyPreflight)).toBe(0);
    expect(result.stdout?.trim(), JSON.stringify(dependencyPreflight)).toBeTruthy();
  }
  homeAllocation.key = owner; homeAllocation.path = codexHome;
  const { writeSuCodexHome } = await import('../../../packages/operator-core/lib/role-codex-home');
  const { restoreBenchmarkContext } = await import('../../../packages/operator-core/lib/external-bench/reproducibility/context');
  const { currentProtocolFixture } = await import('../../../packages/operator-core/lib/external-bench/reproducibility/_protocol-test-fixture');
  const { currentBenchAssignmentId } = await import('../../../packages/operator-core/lib/external-bench/current-su');
  const { codexCliResponsesBody, codexCliResponsesCompletionSse } = await import('../../../packages/operator-core/lib/inference-gateway/codex-cli-bridge');
  const sourceRead = (await import('../../../packages/operator-core/lib/agent-tools/capability/read')).default;
  const { dispatchProjectedTool, lookupByMcpName } = await import('@papercusp/agent-mcp');
  const { checkSessionConfinement, setSessionConfinementResolver } = await import(
    '../../../packages/operator-core/lib/capability-envelope/session-confinement-port');
  await import('../../../packages/operator-core/lib/agent-tools/work_items/get');
  await import('../../../packages/operator-core/lib/agent-tools/work_items/checkpoint');
  await import('../../../packages/operator-core/lib/agent-tools/work_items/complete');
  db = await createOrgTestDb(); privateDatabase.sql = db.adminSql;
  process.env.PAPERCUSP_WORKSPACE_ID = 'native-frozen-private';
  const { saveHarnessRegistry } = await import('../../../packages/operator-core/lib/harness-registry');
  await saveHarnessRegistry({ projects: [{ slug: own.harness, path: cwd }] }, 'native-frozen-private');
  await db.adminSql`INSERT INTO harness_shared.work_items
    (workspace_id, harness_slug, feature_id, item_kind, title, status, taken_by, taken_at, created_ts, updated_ts)
    VALUES ('native-frozen-private', ${own.harness}, ${own.id}, 'feature', 'Private native workflow', 'wip', ${owner}, now(), ${Date.now()}, ${Date.now()}),
      ('native-frozen-private', ${own.harness}, ${neighbor}, 'feature', 'Untouched neighboring assignment', 'wip', ${owner}, now(), ${Date.now()}, ${Date.now()})`;
  const confinement = { denyTools: [], denyOutside: ['work_items:get', 'work_items:checkpoint', 'work_items:complete'],
    denyWorkItemsOutside: { ...own, checkout: cwd }, denyAmbientContext: true as const,
    reason: 'private native benchmark assignment', imposedBy: 'fixture host' };
  setSessionConfinementResolver(context => context.uiClientId === owner ? confinement : undefined);
  clearConfinement = () => setSessionConfinementResolver(undefined);
  const toolContext = { workspaceId: 'native-frozen-private', harnessSlug: own.harness, projectDir: cwd,
    uiClientId: owner, isSuperuser: true, role: 'operator', signal: new AbortController().signal,
    log: vi.fn(), progress: vi.fn(), emit: vi.fn(), runId: owner, spawnId: owner, parentSpawnId: null };
  const workflow = [
    { name: 'work_items_get', args: { ...own, threadLimit: 0 } },
    { name: 'work_items_checkpoint', args: { ...own, checkpoint: checkpointMarker } },
    { name: 'work_items_get', args: { ...own, threadLimit: 0 } },
    { name: 'work_items_checkpoint', args: { ...own, id: neighbor, checkpoint: 'MUST_NOT_WRITE' } },
    { name: 'work_items_complete', args: { ...own, state: 'done', assumptions: 'none',
      changeKinds: ['no-code-change'], changeKindReason: 'sandbox fixture close; no code is changed', completion: {
      summary: completionMarker, testsRun: 'manual read of restored frozen fixture', testResult: 'pass',
      verifiedHow: 'manual', filesChanged: [] } } },
  ];
  const snapshotRoot = join(fixtureRoot, 'protocol'); mkdirSync(snapshotRoot);
  const snapshot = JSON.stringify({ entries: [{ key: 'permitted:fixture', text: frozenMarker }] });
  for (const name of ['corpus.json', 'memory.json']) writeFileSync(join(snapshotRoot, name), snapshot);
  const config = currentProtocolFixture(owner, 120_000);
  for (const arm of config.arms) { arm.model = 'gpt-6-sol'; arm.effort = 'medium'; }
  config.priceSchedule.rates[0].model = 'gpt-6-sol';
  config.context = { ...config.context, corpusRef: 'corpus.json', memoryRef: 'memory.json',
    corpusHash: createHash('sha256').update(snapshot).digest('hex'), memoryHash: createHash('sha256').update(snapshot).digest('hex') };
  const restored = restoreBenchmarkContext({ snapshotRoot, checkout: cwd, context: config.context,
    binding: { workspaceId: 'native-frozen-private', runId: owner, preregHash: 'a'.repeat(64),
      assignmentId: currentBenchAssignmentId(owner, config.arms[0].id, config.taskIds[0], config.seeds[0]), harnessSlug: 'fixture' } });
  // This server scripts the native protocol only. It is never a provider bill,
  // task-quality measurement or pilot result. Work-item calls below execute
  // the maintained dispatcher/handlers and are checked against private SQL.
  server = createServer(async (req, res) => {
    try {
      requestPaths.push(`${req.method} ${req.url}`);
      if (req.url?.startsWith('/mcp')) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const message = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        mcpMethods.push({ method: message?.method, tool: message?.params?.name, path: req.url });
        const host = new McpServer({ name: 'frozen-source-fixture', version: '1' }); hosts.push(host);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        host.registerTool('capability_read', { inputSchema: { file_path: z.string(), byte_offset: z.number(), byte_limit: z.number() },
          annotations: { readOnlyHint: true } }, async args => {
          reads.push(args);
          return await sourceRead.handler(args as never, { projectDir: cwd } as never) as {
            content: Array<{ type: 'text'; text: string }>;
          };
        });
        const identity = { id: z.string(), harness: z.string() };
        const inputs = {
          work_items_get: { ...identity, threadLimit: z.number().optional() },
          work_items_checkpoint: { ...identity, checkpoint: z.string() },
          work_items_complete: { ...identity, state: z.literal('done'), assumptions: z.literal('none'),
            completion: z.object({ summary: z.string(), testsRun: z.string(), testResult: z.string(),
              verifiedHow: z.literal('manual'), filesChanged: z.array(z.string()) }) },
        };
        for (const name of Object.keys(inputs) as Array<keyof typeof inputs>) {
          host.registerTool(name, { inputSchema: inputs[name] }, async (args: Record<string, unknown>): Promise<CallToolResult> => {
            const canonical = name.replace('work_items_', 'work_items:');
            const tool = lookupByMcpName(canonical);
            if (!tool) throw new Error(`Maintained workflow tool is absent: ${canonical}`);
            const result = await dispatchProjectedTool(tool, canonical, args, toolContext as never, {
              checkCapabilityEnvelope: async input => checkSessionConfinement(input),
            });
            workflowCalls.push({ name, args, result });
            return result.ok ? { ...result.result, content: result.result?.content ?? [] } as CallToolResult : {
              isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result.error) }],
            };
          });
        }
        await host.connect(transport); await transport.handleRequest(req, res, message); return;
      }
      // The real launcher also posts operator lifecycle events. They are
      // distinct from Responses generation and must never advance its script.
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString()); providerCalls.push(request);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (workflowIndex <= workflow.length) {
        // Responses-lite carries the real definitions in an input item. A
        // code-mode model advertises its executor rather than direct MCP calls.
        const tools = [...(request.tools ?? []), ...(request.input ?? []).flatMap(
          (item: Record<string, unknown>) => Array.isArray(item.tools) ? item.tools : [],
        )] as Array<Record<string, unknown>>;
        const step = workflowIndex === 0 ? { name: 'capability_read', args: {
          file_path: restored.memoryPath, byte_offset: 0, byte_limit: Buffer.byteLength(snapshot),
        } } : workflow[workflowIndex - 1];
        const namespace = tools.find(entry =>
          entry.type === 'namespace' && (entry.tools as Array<Record<string, unknown>>)?.some(tool => tool.name === step.name));
        const direct = tools.find(tool => tool.type === 'function' && typeof tool.name === 'string' &&
          tool.name.endsWith(`__${step.name}`));
        const executor = tools.find(entry => entry.type === 'namespace' &&
          (entry.tools as Array<Record<string, unknown>>)?.some(tool => tool.type === 'custom' && tool.name === 'exec'));
        const needsDiscovery = !namespace && !direct && !executor;
        if (needsDiscovery) {
          const discovery = tools.find(tool => tool.type === 'tool_search' && tool.execution === 'client');
          const schema = discovery?.parameters as { properties?: Record<string, unknown>; required?: string[] } | undefined;
          if (!schema?.properties?.query || !schema.properties.limit || schema.required?.some(key => key !== 'query') ||
              discoveryCount >= workflow.length + 1) throw new Error(`Installed native runtime cannot discover ${step.name}`);
        } else { workflowRequestIndexes.push(providerCalls.length - 1); workflowIndex++; }
        const callId = needsDiscovery ? `local-discovery-${++discoveryCount}` :
          workflowIndex === 1 ? 'frozen-read' : `workflow-${workflowIndex - 1}`;
        const item = needsDiscovery ? { id: `ts_${callId}`, type: 'tool_search_call', execution: 'client', call_id: callId,
          status: 'completed', arguments: { query: 'capability_read work_items_get work_items_checkpoint work_items_complete', limit: 8 } } :
          executor ? { id: `fc_${callId}`, type: 'custom_tool_call', call_id: callId,
          namespace: executor.name, name: 'exec', status: 'completed', input:
            `const selected = ALL_TOOLS.find(tool => tool.name.endsWith(${JSON.stringify(`__${step.name}`)}));\n` +
            `if (!selected) throw new Error('Workflow tool is absent from the actual native executor registry');\n` +
            `text(await tools[selected.name](${JSON.stringify(step.args)}));`,
        } : { id: `fc_${callId}`, type: 'function_call', call_id: callId,
          ...(namespace ? { namespace: namespace.name } : {}),
          name: direct?.name ?? step.name, arguments: JSON.stringify(step.args), status: 'completed' };
        const body = { ...codexCliResponsesBody({ model: 'gpt-6-sol', text: '', inputTokens: 0, outputTokens: 0 }), output: [item] };
        const event = (type: string, payload: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
        res.end(event('response.output_item.added', { output_index: 0, item: { ...item,
          ...(executor ? { input: '' } : { arguments: needsDiscovery ? {} : '' }), status: 'in_progress' } }) +
          event('response.output_item.done', { output_index: 0, item }) + event('response.completed', { response: body }));
      } else {
        res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: 'gpt-6-sol', text: 'FROZEN_NATIVE_RECEIPT', inputTokens: 0, outputTokens: 0 })));
      }
    } catch (error) { errors.push(String(error)); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
    const port = await listen(server);
    const baseURL = `http://127.0.0.1:${port}`;
    let nativeGateway: { baseURL: string; token: string; outputTokenLimit?: number } = { baseURL, token: 'a'.repeat(64) };
    if (route === 'metered') {
      const { currentBenchGatewayController, currentBenchProviderAuthenticator, currentBenchOpenAiInputReader,
        currentBenchOpenAiInputContract } = await import('../../../packages/operator-core/lib/external-bench/current-su');
      const { registerLearningLoop, getLearningSpendPositions, reserveLearningSpend } = await import('../../../packages/operator-core/lib/learning-governor/store');
      const { makeBearerCredentialResolver } = await import('../../../packages/operator-core/lib/inference-gateway/credential-store');
      const { startGatewayService } = await import('../../../packages/operator-core/lib/inference-gateway/launch');
      const loopId = `native-workflow:${owner}`, preregHash = 'a'.repeat(64), workspaceId = 'native-frozen-private';
      const key = join(fixtureRoot, 'private-provider-key');
      writeFileSync(key, 'PRIVATE_OFFLINE_PROVIDER_CREDENTIAL', { mode: 0o600 });
      const account = { id: 'private-native-provider', provider: 'codex' as const, credentialRef: `token:${key}` };
      const inputTokens = 100_000;
      config.priceSchedule.rates[0].inputTokenCeiling = inputTokens;
      config.priceSchedule.rates[0].cacheWriteUsdPerMillion = 1.25;
      config.priceSchedule.rates[0].inputTokenCeilingSourceSha256 = currentBenchOpenAiInputContract('gpt-6-sol', inputTokens);
      // The aggregate resource allowance must cover the bounded multi-request
      // workflow. The native client's existing per-request output control is
      // separately tighter; no monetary/assignment cap is increased.
      const maxRequests = workflow.length + 2 + workflow.length + 1, outputLimit = 4096;
      const resources = { inputTokens: inputTokens * maxRequests, outputTokens: outputLimit * maxRequests,
        requestsPerArm: maxRequests, usdPerArm: 3,
        maxOpenUsd: config.maxInFlightUsd, wallClockMs: 120_000, wallClockMsPerArm: 120_000,
        armIds: config.arms.map(arm => currentBenchAssignmentId(owner, arm.id, 't1', 1)) };
      await registerLearningLoop(db.adminSql, { workspaceId, loopId, budgetKind: 'lifetime', budgetUsd: 60,
        enabled: true, meta: { reservationBinding: preregHash, reservationResourceBudget: resources } });
      readReservations = () => getLearningSpendPositions(db!.adminSql, { workspaceId, loopId, includeReservations: true });
      const reader = currentBenchOpenAiInputReader({ model: 'gpt-6-sol', inputTokens }, { fetch: async (target, init) => {
        expect(String(target)).toBe('https://api.openai.com/v1/responses/input_tokens');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer PRIVATE_OFFLINE_PROVIDER_CREDENTIAL');
        countedInputs.push(JSON.parse(String(init?.body)));
        return Response.json({ object: 'response.input_tokens', input_tokens: 1000 });
      } });
      const auth = currentBenchProviderAuthenticator({ workspaceId, preregHash, protocol: config,
        armId: 'papercusp', taskId: 't1', seed: 1, readNativeInputCeiling: async (attempt, credential) => {
          const result = await reader.read(attempt, credential);
          admissionStages.push({ stage: 'input-proof', accepted: result !== null });
          return result;
        } }, {
        readAccount: async (_workspace, id) => id === account.id ? account : null,
        credentialResolver: (_provider, ref) => makeBearerCredentialResolver(ref),
      });
      revokeProvider = () => { auth.revoke(); reader.revoke(); };
      const controller = currentBenchGatewayController({ workspaceId, loopId, token: 'a'.repeat(64), preregHash,
        protocol: config, resources, outputTokenLimit: outputLimit, armId: 'papercusp', taskId: 't1', seed: 1,
        authenticateProvider: async attempt => {
          const result = await auth.authenticateProvider(attempt);
          admissionStages.push({ stage: 'provider-authentication', accepted: result !== null });
          return result;
        } }, { enabled: async () => true, getSql: async () => db!.adminSql,
        reserve: async (sql, input) => {
          const result = await reserveLearningSpend(sql, input);
          admissionStages.push({ stage: 'reservation', ok: result.ok,
            ...(!result.ok ? { reason: result.reason } : {}) });
          return result;
        }, log: () => {} });
      expect(resources.outputTokens).toBeGreaterThan(outputLimit);
      expect(controller.gateway.carryTrial.outputTokenLimit).toBe(outputLimit);
      expect(resources.inputTokens).toBe(inputTokens * maxRequests);
      expect(resources.usdPerArm).toBe(config.arms[0].generationBudget.maxUsd);
      const hosted = await controller.startNativeGateway(message => { gatewayErrors.push(message); }, options =>
        startGatewayService({ ...options, carryTrial: { ...options.carryTrial!, authorizeAttempt: async attempt => {
          const body = JSON.parse(attempt.body);
          firstNativeAdmissionRequest ??= body;
          admissionStages.push({ stage: 'controller-input', model: body.model, reasoning: body.reasoning,
            outputLimit: body.max_output_tokens, fields: Object.keys(body), transport: attempt.transport,
            clientMetadata: body.client_metadata, promptCacheOptions: body.prompt_cache_options,
            toolShapes: (body.tools ?? []).map((tool: Record<string, unknown>) => ({ type: tool.type, name: tool.name,
              keys: Object.keys(tool), tools: Array.isArray(tool.tools) ? tool.tools.map((child: Record<string, unknown>) =>
                ({ type: child.type, name: child.name, keys: Object.keys(child) })) : undefined })),
            nativeSessionId: attempt.nativeSessionId, nativeTurnId: attempt.nativeTurnId,
            inputShapes: Array.isArray(body.input) ? body.input.map((item: Record<string, unknown>) =>
              ({ type: item.type, role: item.role, keys: Object.keys(item) })) : typeof body.input });
          const result = await options.carryTrial!.authorizeAttempt(attempt);
          if (result === null) rejectedNativeAdmissionRequest = body;
          admissionStages.push({ stage: 'controller-output', accepted: result !== null });
          return result;
        } }, resolveAccounts: async () => [{ accountId: account.id,
          credentialRef: account.credentialRef, source: 'env' }], resolveLocalBackends: async () => [],
          observePool: () => () => {}, refreshIntervalMs: 0, poolReloadIntervalMs: 0, localBackendReloadIntervalMs: 0,
          fetchImpl: async (target, init) => {
            const body = typeof init?.body === 'string' ? init.body : new TextDecoder().decode(init?.body as Uint8Array);
            const positions = await getLearningSpendPositions(db!.adminSql, { workspaceId, loopId, includeReservations: true });
            expect(positions.census?.status).toBe('complete');
            if (positions.census?.status !== 'complete') throw new Error('Native send has no complete reservation census');
            const bodySha256 = createHash('sha256').update(body).digest('hex');
            expect(positions.census.reservations.some(row => row.status === 'open' &&
              JSON.parse(row.note!).nativeGatewayAttempt.bodySha256 === bodySha256)).toBe(true);
            admissionEvidence.push({ target: String(target), bodySha256, openBeforeSend: positions.positions.openAttempts });
            expect(new Headers(init?.headers).get('authorization')).toBe('Bearer PRIVATE_OFFLINE_PROVIDER_CREDENTIAL');
            return fetch(`${baseURL}/v1/responses`, init);
          } }));
      metered = hosted; nativeGateway = hosted.nativeGateway;
    }
    const home = writeSuCodexHome({ sessionKey: owner, sid: owner, mcpUrl: `${baseURL}/mcp`, token: 'offline-fixture',
      model: 'gpt-6-sol:medium', promptText: `${roleMarker}\n${restored.contextText}`, headless: true, trustDir: cwd, denyAmbientContext: true });
    expect(home.codexHome).toBe(codexHome);
    probe = new Client({ name: 'native-fixture-preflight', version: '1' });
    await probe.connect(new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`)),
      { timeout: 5_000, signal: AbortSignal.timeout(5_000) });
    expect((await probe.listTools(undefined, { timeout: 5_000, signal: AbortSignal.timeout(5_000) }))
      .tools.map(tool => tool.name).sort()).toEqual(['capability_read', 'work_items_checkpoint', 'work_items_complete', 'work_items_get']);
    await probe.close(); probe = undefined;
    // The child must read the exact delivered AGENTS file and restored bytes.
    // Keep fixture-only provider and tool choices in CLI overrides, so a
    // replacement of the managed prompt cannot make this assertion pass.
    const overrides = { ...(route === 'direct' ? { model_provider: 'frozen_fixture',
      'model_providers.frozen_fixture.name': 'Offline native fixture',
      'model_providers.frozen_fixture.base_url': `${baseURL}/v1`,
      'model_providers.frozen_fixture.wire_api': 'responses',
      'model_providers.frozen_fixture.requires_openai_auth': false,
      'model_providers.frozen_fixture.supports_websockets': false,
      'model_providers.frozen_fixture.request_max_retries': 0,
      'model_providers.frozen_fixture.stream_max_retries': 0 } : {}),
      'model_providers.papercusp-codex-gateway.request_max_retries': 0,
      'model_providers.papercusp-codex-gateway.stream_max_retries': 0,
      'features.apps': false, 'features.hooks': false, web_search: 'disabled' };
    const args = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
      ...Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]), 'Read the frozen assignment context.'];
    const env = hermeticEnv({ PAPERCUSP_AGENT: 'codex', CODEX_HOME: codexHome, PAPERCUSP_SID: owner,
      PAPERCUSP_PSU_HEADLESS: '1', PAPERCUSP_PSU_PTY: '1', PAPERCUSP_MCP_PROXY: '0',
      PAPERCUSP_OPERATOR_URL: baseURL,
      PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify(nativeGateway) });
    const launcher = fileURLToPath(new URL('../scripts/psu-launcher.mjs', import.meta.url));
    const fixture = join(cwd, 'launcher-fixture.mjs');
    writeFileSync(fixture, `import { runWrapper } from ${JSON.stringify(launcher)};\nrunWrapper({wrapperBin:'codex',args:${JSON.stringify(args)},cwd:${JSON.stringify(cwd)},preserveCwd:true,envelopeEnv:process.env,reportSessionEndedImpl:async()=>{},onSpawn:()=>{}});\n`);
    writeFileSync(join(snapshotRoot, 'ambient.txt'), ambientMarker);
    child = spawn(process.execPath, [fixture], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout!.on('data', b => { output += b; }); child.stderr!.on('data', b => { output += b; });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child!.kill('SIGKILL'); reject(new Error(`Frozen native workflow exceeded 80 seconds: ${output.slice(-2000)}`)); }, 80_000);
      child!.once('error', e => { clearTimeout(timer); reject(e); });
      child!.once('close', c => { clearTimeout(timer); resolve(c); });
    });
    const inputShapes = (value: unknown, path = 'input'): unknown[] => {
      if (typeof value === 'string') {
        const index = value.indexOf('capability_read');
        return [{ path, length: value.length, ...(/\.(type|name|role)$/.test(path) ? { value } : {}), ...(index < 0 ? {} :
          { toolExcerpt: value.slice(Math.max(0, index - 300), index + 500) }) }];
      }
      if (Array.isArray(value)) return value.flatMap((entry, i) => inputShapes(entry, `${path}[${i}]`));
      if (value && typeof value === 'object') return [{ path, keys: Object.keys(value) },
        ...Object.entries(value).filter(([key]) => !['parameters', 'format'].includes(key))
          .flatMap(([key, entry]) => inputShapes(entry, `${path}.${key}`))];
      return [];
    };
    const diagnostics = JSON.stringify({ output: output.slice(-5000), errors, gatewayErrors, admissionEvidence, admissionStages,
      firstNativeAdmissionRequest, rejectedNativeAdmissionRequest, discoveryCount, workflowRequestIndexes,
      countedInputCount: countedInputs.length, reservations: await readReservations?.(), requestPaths, mcpMethods, workflowCalls,
      dependencyPreflight, executablePath: env.PATH, discoveryRoot: env.PAPERCUSP_PSU_PTY_DIR,
      inputShapes: inputShapes(providerCalls[0]?.input),
      providerRequestKeys: providerCalls.map(request => Object.keys(request)),
      toolShapes: (providerCalls[0]?.tools as Array<Record<string, unknown>> | undefined)?.map(tool =>
        ({ type: tool.type, name: tool.name, keys: Object.keys(tool) })) });
    expect(code, diagnostics).toBe(0); expect(errors, diagnostics).toEqual([]);
    expect(providerCalls, diagnostics).toHaveLength(workflow.length + 2 + discoveryCount); expect(reads).toHaveLength(1);
    expect(reads[0]).toEqual({ file_path: restored.memoryPath, byte_offset: 0, byte_limit: Buffer.byteLength(snapshot) });
    expect(JSON.stringify(providerCalls[0])).toContain(roleMarker);
    expect(JSON.stringify(providerCalls[0])).toContain(frozenMarker);
    expect(JSON.stringify(providerCalls)).not.toContain(ambientMarker);
    const afterRead = providerCalls[workflowRequestIndexes[1]];
    expect(JSON.stringify(afterRead)).toContain('frozen-read');
    expect(JSON.stringify(afterRead)).toContain(Buffer.from(snapshot).toString('base64'));
    expect(workflowCalls.map(call => call.name)).toEqual(workflow.map(step => step.name));
    expect(workflowCalls.map(call => (call.result as { ok: boolean }).ok), diagnostics).toEqual([true, true, true, false, true]);
    expect(JSON.stringify(workflowCalls[2].result), diagnostics).toContain(checkpointMarker);
    expect(JSON.stringify(providerCalls[workflowRequestIndexes[4]]), diagnostics).toContain(checkpointMarker);
    expect(JSON.stringify(providerCalls[workflowRequestIndexes[5]]), diagnostics).toContain('capability_denied');
    const rows = await db.adminSql`SELECT feature_id, status, terminal_owner, terminal_completion_ref,
        payload -> '_completionEvidence' AS completion_evidence
      FROM harness_shared.work_items WHERE workspace_id = 'native-frozen-private' ORDER BY feature_id`;
    const terminalDiagnostics = JSON.stringify({ rows, nativeWorkflow: workflowCalls.map(call => ({
      name: call.name, ok: (call.result as { ok: boolean }).ok,
    })) });
    expect(rows.find(row => row.feature_id === own.id), terminalDiagnostics).toMatchObject({
      status: 'done', terminal_owner: owner, terminal_completion_ref: null,
      completion_evidence: { summary: completionMarker, testResult: 'pass', verifiedHow: 'manual' },
    });
    expect(rows.find(row => row.feature_id === neighbor), terminalDiagnostics).toMatchObject({
      status: 'wip', terminal_completion_ref: null, completion_evidence: null,
    });
    const { workItemScope } = await import('../../../packages/operator-core/lib/carry-note');
    const notes = await db.adminSql`SELECT scope FROM harness_shared.carry_notes
      WHERE workspace_id = 'native-frozen-private' AND scope = ${workItemScope(own.harness, neighbor)}`;
    expect(notes).toHaveLength(0);
    expect(output).toContain('FROZEN_NATIVE_RECEIPT');
    if (route === 'metered') {
      const { getLearningSpendPositions } = await import('../../../packages/operator-core/lib/learning-governor/store');
      const positions = await getLearningSpendPositions(db.adminSql, { workspaceId: 'native-frozen-private',
        loopId: `native-workflow:${owner}`, includeReservations: true });
      expect(admissionEvidence, diagnostics).toHaveLength(providerCalls.length);
      expect(countedInputs, diagnostics).toHaveLength(providerCalls.length);
      expect(admissionEvidence.every(row => row.target === 'https://api.openai.com/v1/responses')).toBe(true);
      expect(providerCalls.every(request => request.max_output_tokens === 4096)).toBe(true);
      expect(countedInputs.map(request => request.input)).toEqual(providerCalls.map(request => request.input));
      expect(countedInputs.map(request => request.tools)).toEqual(providerCalls.map(request => request.tools));
      if (discoveryCount > 0) {
        expect(countedInputs.some(request => JSON.stringify(request.input).includes('tool_search_output'))).toBe(true);
      } else expect(JSON.stringify(countedInputs[0])).toContain('additional_tools');
      expect(positions.census?.status).toBe('complete');
      if (positions.census?.status !== 'complete') throw new Error('Missing final native reservation census');
      expect(positions.census.reservations).toHaveLength(providerCalls.length);
      expect(positions.census.reservations.every(row => row.status === 'open' && row.usedUsd === 0 &&
        JSON.parse(row.note!).nativeGatewayAttemptResult.outcome === 'response-completed')).toBe(true);
      expect(positions.positions.openAttempts).toBe(providerCalls.length);
      // Scripted usage is not a bill. Retain exposure rather than refunding it.
      expect(positions.positions.unsettledUsd).toBeGreaterThan(0);
      expect(JSON.stringify(positions)).not.toContain('PRIVATE_OFFLINE_PROVIDER_CREDENTIAL');
    }
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    try {
      await probe?.close();
      await metered?.stop(); revokeProvider?.();
      await Promise.allSettled(hosts.map(host => host.close()));
      if (server?.listening) await stop(server);
    } finally {
      clearConfinement?.();
      if (priorWorkspace === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
      else process.env.PAPERCUSP_WORKSPACE_ID = priorWorkspace;
      await cleanupScopedNativeFixtureDatabase(db);
      rmSync(fixtureRoot, { recursive: true, force: true }); homeAllocation.key = ''; homeAllocation.path = '';
    }
  }
}, 150_000);

it('starts the installed Codex runtime through the actual launcher without inference', async () => {
  const cwd = mkdtempSync('/tmp/psu-native-codex-');
  const codexHome = join(cwd, 'codex-home'); mkdirSync(codexHome);
  const env = hermeticEnv({ PAPERCUSP_AGENT: 'codex', CODEX_HOME: codexHome,
    PAPERCUSP_SID: `test-scoped-codex-${process.pid}`, PAPERCUSP_PSU_HEADLESS: '1', PAPERCUSP_PSU_PTY: '1',
    PAPERCUSP_MCP_PROXY: '0', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:32002',
    PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify({ baseURL: 'http://127.0.0.1:32001', token: 'a'.repeat(64) }) });
  try {
    const launcher = fileURLToPath(new URL('../scripts/psu-launcher.mjs', import.meta.url));
    const fixture = join(cwd, 'launcher-fixture.mjs');
    writeFileSync(fixture, `import { runWrapper } from ${JSON.stringify(launcher)};\nrunWrapper({wrapperBin:'codex',args:['--version'],cwd:${JSON.stringify(cwd)},preserveCwd:true,envelopeEnv:process.env,reportSessionEndedImpl:async()=>{},onSpawn:()=>{}});\n`);
    const child = spawn(process.execPath, [fixture], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Installed Codex PTY fixture exceeded 20 seconds')); }, 20_000);
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('close', c => { clearTimeout(timer); resolve(c); });
    });
    expect(code, output).toBe(0);
    expect(output).toMatch(/codex-cli \d+\.\d+/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}, 30_000);
