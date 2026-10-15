import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectedTool, DispatchProjectedDeps } from '@papercusp/tooldef';
import { buildLoopbackIdentitySpawn } from '@papercusp/papercusp-shared/agent';
import { createHostedPrincipal } from '../auth/hosted-principal';
import type { HostedPrincipalResolver, HostedPrincipalResolution } from '../auth/hosted-principal-resolver';
import type { ModelPort, ModelRequest } from '../agent-loop/model-port';
import { beginSyncEnrolment, completeSyncEnrolment, finishSyncEnrolment } from '../task-manager/enroll-sync';
import { notifyTaskKillRequested } from '../task-manager/kill-notify';
import { bindHostedCustomerChannelLoopPorts, bindHostedCustomerLoopPorts,
  createHostedCustomerChannelOwnedLoopPort, createHostedCustomerChannelHttpHandler } from './hosted-customer-loop-ports';
import { HostedWorkspaceHostSessionAdapter, type HostedHostOutboundEnvelope } from './hosted-session-host';

vi.mock('../task-manager/enroll-sync', () => ({
  beginSyncEnrolment: vi.fn(() => ({ taskId: 'testcustomertask', enrolled: true })),
  completeSyncEnrolment: vi.fn(), finishSyncEnrolment: vi.fn(),
}));

let root: string, project: string;
beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'customer-loop-ports-'));
  project = join(root, 'project'); mkdirSync(project);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

async function fixture(options: { tool?: Partial<ProjectedTool>; deps?: DispatchProjectedDeps;
  modelFactory?: (session: unknown, signal?: AbortSignal) => ModelPort | Promise<ModelPort> } = {}) {
  let current = createHostedPrincipal({ workspaceId: 'control-workspace', userId: 'customer-user',
    activeOrganizationId: 'customer-org', selectedWorkspaceId: 'customer-workspace',
    sessionId: 'authenticated-session', sessionVersion: 1, permissions: ['workspace:operate'] });
  const resolve: HostedPrincipalResolver = vi.fn(async () => ({ ok: true, principal: current } as HostedPrincipalResolution));
  const localHandler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'operator-local' }] }));
  const tool: ProjectedTool = { pluginName: 'fixture', description: 'shell',
    capabilities: ['capability:bash'], expose: { mcp: { name: 'capability:bash' } },
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, cmd: { type: 'string' },
      cwd: { type: 'string' }, timeout: { type: 'number' }, run_in_background: { type: 'boolean' },
      integration_env: { type: 'object' } }, additionalProperties: false },
    agentRoles: ['worker'], fn: localHandler, ...options.tool };
  // REAL wrapper/process/dispatcher, same UID test transport. No customer OS acceptance claim.
  const transform = vi.fn(buildLoopbackIdentitySpawn({ transportCommand: '/bin/bash', transportArgs: ['-c'],
    identity: 'test-customer', nodePath: process.execPath, remoteHome: root,
    spawnRoot: join(root, 'spawns'), localHome: root, baseEnv: process.env, remotePath: ['/usr/bin', '/bin'] }));
  const controller = new AbortController();
  const modelStream = vi.fn(async function* (_request: ModelRequest) { yield { type: 'text_delta' as const, text: 'model' }; });
  const modelFactory = vi.fn(options.modelFactory ?? (() => ({ stream: modelStream })));
  const telemetry = vi.fn();
  const ports = await bindHostedCustomerLoopPorts({ resolvePrincipal: resolve, sessionHeaders: new Headers(),
    customerWorkspaceId: 'customer-workspace', projectDir: project, transform,
    signal: controller.signal, lookupTool: () => tool, dispatchDeps: { recordInvocation: telemetry, ...options.deps },
    createModelPort: modelFactory });
  return { ports, resolve, tool, transform, controller, modelFactory, modelStream, localHandler, telemetry,
    change: (patch: Partial<typeof current>) => { current = { ...current, ...patch }; } };
}

const request: ModelRequest = { model: 'fixture/model', messages: [] };
async function consume(port: ModelPort, req = request) {
  const events = []; for await (const event of port.stream(req)) events.push(event); return events;
}
function commandResult(result: unknown): unknown {
  // flattenDispatchResult parses a single JSON text item. A dispatcher advisory
  // makes it plain text instead; both carry the same first command receipt.
  return typeof result === 'string' ? JSON.parse(result.split('\n')[0]) : result;
}

async function withRunningCustomerCommand(
  action: (f: Awaited<ReturnType<typeof fixture>>, pending: ReturnType<Awaited<ReturnType<typeof fixture>>['ports']['dispatch']>) => Promise<void>,
) {
  const f = await fixture();
  const marker = join(project, 'running-command-pid');
  const pending = f.ports.dispatch('capability:bash', { command: 'printf "%s" "$$" > running-command-pid; exec sleep 30' });
  let pid: number | undefined;
  try {
    // Local enrollment means the transport was spawned, not that the customer
    // payload is ready. Exercise cancellation AFTER observing the real payload.
    await vi.waitFor(() => {
      expect(existsSync(marker)).toBe(true);
      pid = Number(readFileSync(marker, 'utf8'));
      expect(Number.isSafeInteger(pid) && pid! > 0).toBe(true);
    });
    await action(f, pending);
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    f.controller.abort();
    if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already reaped */ } }
    await pending;
  }
}

async function boundedCommandStop<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('customer command shutdown exceeded 2s')), 2_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

describe('private customer loop port composition', () => {
  it('binds an actual relay HTTP request to the native factory without header or ambient authority', async () => {
    vi.stubEnv('PAPERCUSP_DISTRIBUTION_PROFILE', 'vm-release');
    const f = await fixture();
    const requests: ModelRequest[] = [];
    const modelFactory = vi.fn((): ModelPort => ({ async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        yield { type: 'tool_call', id: 'http-command', name: 'capability:bash', input: { command: 'printf native-http' } };
        yield { type: 'stop', reason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
      } else {
        yield { type: 'text_delta', text: 'http customer done' };
        yield { type: 'stop', reason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
      }
    } }));
    const events: unknown[] = [];
    const input = { role: 'worker', prompt: 'fixture route prompt', model: 'openrouter/fixture/model',
      runId: 'http-native-run', featureId: null, chunkId: null, workspaceId: 'vm-local-workspace',
      harnessSlug: 'customer-harness', projectDir: project, cwd: project, stateDir: join(project, '.papercusp'),
      emit: (event: unknown) => events.push(event) };
    let capturedPort: ReturnType<typeof createHostedCustomerChannelOwnedLoopPort> | undefined;
    const handleNativeRequest = vi.fn(async (_request: Request, port: NonNullable<typeof capturedPort>) => {
      capturedPort = port;
      return Response.json(await port.invoke(input));
    });
    const handleRequest = createHostedCustomerChannelHttpHandler({ workspaceId: 'vm-local-workspace',
      customerWorkspaceId: 'customer-workspace', projectDir: project, transform: f.transform,
      lookupTool: () => f.tool, dispatchDeps: { recordInvocation: f.telemetry }, createModelPort: modelFactory,
      flushTelemetry: async () => {}, handleNativeRequest });
    const sent: HostedHostOutboundEnvelope[] = [];
    const fetch = vi.fn(async () => new Response('ambient'));
    let adapter!: HostedWorkspaceHostSessionAdapter;
    adapter = new HostedWorkspaceHostSessionAdapter({ workspaceRoot: project,
      binding: { controlPlaneWorkspaceId: 'control-workspace', organizationId: 'customer-org',
        customerWorkspaceId: 'customer-workspace', hostId: 'host', routeLabel: 'route',
        generation: 1, transport: 'websocket', state: 'active' },
      operatorHttp: { fetch, handleRequest }, send: message => {
        sent.push(message);
        if (message.type === 'session.authorize') queueMicrotask(() => {
          // Mock authenticated control-plane ledger response, not customer acceptance.
          void adapter.accept({ ...message, type: 'session.authorized', authority: {
            controlPlaneWorkspaceId: 'control-workspace', organizationId: 'customer-org',
            customerWorkspaceId: 'customer-workspace', userId: 'customer-user',
            sessionId: 'authenticated-session', sessionVersion: 1, permissions: ['workspace:operate'],
          } });
        });
      },
    });
    try {
      await adapter.accept({ type: 'relay.open', channelId: 'http', kind: 'operator-http',
        audience: 'workspace-operator', role: 'controller', userId: 'customer-user', hostedSessionId: 'authenticated-session' });
      await adapter.accept({ type: 'relay', channelId: 'http', payload: { type: 'http.request', requestId: 'native',
        method: 'POST', path: '/api/harness/h/agent-chats/c/messages',
        headers: { 'content-type': 'application/json', 'x-papercusp-hosted-user-id': 'forged', cookie: 'stolen' },
        body: Buffer.from(JSON.stringify({ engine: 'loop', account: 'forged', ownerId: 'forged' })).toString('base64') } });
      const payloads = sent.filter(m => m.type === 'relay').map(m => m.payload as Record<string, unknown>);
      expect(payloads).toContainEqual(expect.objectContaining({ type: 'http.response', status: 200 }));
      expect(fetch).not.toHaveBeenCalled(); expect(handleNativeRequest).toHaveBeenCalledTimes(1);
      expect(modelFactory).toHaveBeenCalledWith(expect.objectContaining({ userId: 'customer-user',
        sessionId: 'authenticated-session', selectedWorkspaceId: 'customer-workspace' }), expect.any(AbortSignal));
      expect(requests).toHaveLength(2); expect(requests[0].ownerId).toBe('customer-user');
      expect(f.transform).toHaveBeenCalledTimes(1); expect(f.localHandler).not.toHaveBeenCalled();
      const result = events.find(event => (event as { type: string }).type === 'tool_result') as { result: unknown };
      expect(commandResult(result.result)).toMatchObject({ output: 'native-http', exit_code: 0 });
      // The saved port expires when the HTTP response completes even if invoke
      // omits its own signal and the channel remains connected.
      expect(await capturedPort!.invoke(input)).toEqual({ exitCode: 1, stderr: 'owned-loop customer execution host unavailable' });
      expect(requests).toHaveLength(2);
    } finally { adapter.close(); }
  });

  it('claims only native message turns and sanitizes private route errors', async () => {
    const f = await fixture();
    const handleNativeRequest = vi.fn(async (): Promise<Response> => { throw new Error('private-secret'); });
    const handler = createHostedCustomerChannelHttpHandler({ workspaceId: 'vm-local-workspace',
      customerWorkspaceId: 'customer-workspace', projectDir: project, transform: f.transform,
      lookupTool: () => f.tool, dispatchDeps: {}, createModelPort: f.modelFactory, handleNativeRequest });
    const context = { channelId: 'http', sessionHost: {
      customerInvocationSignal: vi.fn(() => f.controller.signal), resolveCustomerPrincipal: vi.fn(() => f.resolve(new Headers())) } };
    for (const [method, path, body] of [
      ['GET', '/api/harness/h/agent-chats/c/messages', undefined],
      ['POST', '/api/operator/conversations', JSON.stringify({ engine: 'loop' })],
      ['POST', '/api/harness/h/agent-chats/c/messages', JSON.stringify({ engine: 'omp' })],
      ['POST', '/api/harness/h/agent-chats/c/messages', 'invalid-json'],
    ] as const) {
      expect(await handler(new Request(`http://127.0.0.1${path}`, { method, ...(body ? { body } : {}) }), context)).toBeUndefined();
    }
    expect(handleNativeRequest).not.toHaveBeenCalled();
    const response = await handler(new Request('http://127.0.0.1/api/harness/h/agent-chats/c/messages',
      { method: 'POST', body: JSON.stringify({ engine: 'loop' }) }), context);
    expect(response?.status).toBe(403);
    expect(await response?.text()).toBe('{"error":"hosted_native_loop_unavailable"}');
    // Deliberate contract violation: the injected handler resolves a non-Response value.
    const nonResponse: unknown = undefined;
    handleNativeRequest.mockResolvedValue(nonResponse as Response);
    const malformed = await handler(new Request('http://127.0.0.1/api/harness/h/agent-chats/c/messages',
      { method: 'POST', body: JSON.stringify({ engine: 'loop' }) }), context);
    expect(malformed?.status).toBe(403);
    expect(f.transform).not.toHaveBeenCalled(); expect(f.modelFactory).not.toHaveBeenCalled();
  });

  it('composes an owned native invocation with exact channel authority and customer commands', async () => {
    vi.stubEnv('PAPERCUSP_DISTRIBUTION_PROFILE', 'vm-release');
    const f = await fixture();
    const requests: ModelRequest[] = [];
    const modelFactory = vi.fn((): ModelPort => ({ async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        yield { type: 'tool_call', id: 'customer-command', name: 'capability:bash', input: { command: 'printf native-customer' } };
        yield { type: 'stop', reason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
      } else {
        yield { type: 'text_delta', text: 'customer done' };
        yield { type: 'stop', reason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
      }
    } }));
    const sessionHost = { resolveCustomerPrincipal: vi.fn(() => f.resolve(new Headers())),
      customerInvocationSignal: vi.fn((_channel: string, signal?: AbortSignal) =>
        signal ? AbortSignal.any([signal, f.controller.signal]) : f.controller.signal) };
    const flushTelemetry = vi.fn(async () => {});
    const host = createHostedCustomerChannelOwnedLoopPort({ workspaceId: 'vm-local-workspace',
      sessionHost, channelId: 'private-channel', customerWorkspaceId: 'customer-workspace', projectDir: project,
      transform: f.transform, lookupTool: () => f.tool, dispatchDeps: { recordInvocation: f.telemetry },
      createModelPort: modelFactory, flushTelemetry });
    const input = { role: 'worker', prompt: 'run a customer command', model: 'openrouter/fixture/model',
      runId: 'native-run', featureId: null, chunkId: null, workspaceId: 'vm-local-workspace',
      harnessSlug: 'customer-harness', projectDir: project, cwd: project, stateDir: join(project, '.papercusp'), emit: vi.fn() };
    expect(await host.invoke(input)).toEqual({ exitCode: 0 });
    expect(requests).toHaveLength(2);
    expect(requests[0].tools?.map(tool => tool.name)).toEqual(['capability:bash']);
    expect(requests[0].ownerId).toBe('customer-user');
    expect(f.localHandler).not.toHaveBeenCalled();
    expect(f.transform).toHaveBeenCalledTimes(1);
    const resultEvent = input.emit.mock.calls.map(call => call[0]).find(event => event.type === 'tool_result');
    expect(commandResult(resultEvent.result)).toMatchObject({ output: 'native-customer', exit_code: 0 });
    expect(flushTelemetry).toHaveBeenCalledTimes(1);
    f.controller.abort();
    expect(await host.invoke(input)).toEqual({ exitCode: 1, stderr: 'owned-loop customer execution host unavailable' });
    expect(requests).toHaveLength(2); expect(f.transform).toHaveBeenCalledTimes(1);
  });
  it('composes the private channel authority door without admitting request labels', async () => {
    const f = await fixture();
    const principal = createHostedPrincipal({ workspaceId: 'control-workspace', userId: 'customer-user',
      activeOrganizationId: 'customer-org', selectedWorkspaceId: 'customer-workspace',
      sessionId: 'channel-session', sessionVersion: 1, permissions: ['workspace:operate'] });
    const resolve = vi.fn(async (): Promise<{ ok: true; principal: typeof principal } | { ok: false }> => ({ ok: true, principal }));
    const ports = await bindHostedCustomerChannelLoopPorts({ sessionHost: { resolveCustomerPrincipal: resolve },
      channelId: 'private-channel', customerWorkspaceId: 'customer-workspace', projectDir: project,
      transform: f.transform, signal: f.controller.signal, lookupTool: () => ({
        pluginName: 'fixture', description: 'shell', capabilities: ['capability:bash'],
        expose: { mcp: { name: 'capability:bash' } }, agentRoles: ['worker'],
        inputSchema: { type: 'object', properties: { command: { type: 'string' } }, additionalProperties: false },
        fn: f.localHandler }), dispatchDeps: {}, createModelPort: f.modelFactory });
    expect((await ports.dispatch('capability:bash', { command: 'printf channel' })).isError).not.toBe(true);
    await consume(ports.modelPort);
    expect(resolve).toHaveBeenCalledWith('private-channel', f.controller.signal);
    expect(f.modelFactory).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'channel-session' }), expect.any(AbortSignal));
    resolve.mockResolvedValue({ ok: false });
    await expect(ports.dispatch('capability:bash', { command: 'touch forbidden' })).rejects.toThrow('hosted_customer_execution_denied');
    await expect(consume(ports.modelPort)).rejects.toThrow('hosted_customer_execution_denied');
    expect(existsSync(join(project, 'forbidden'))).toBe(false);
  });
  it('uses the registry dispatcher gates and customer transport, with exact derived authority', async () => {
    const f = await fixture();
    const result = await f.ports.dispatch('capability:bash', { command: 'printf customer' });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content![0] as { text: string }).text)).toMatchObject({
      output: 'customer', exit_code: 0, task_id: 'testcustomertask', task_enrolled: true });
    expect(f.localHandler).not.toHaveBeenCalled();
    expect(f.telemetry).toHaveBeenCalledWith(expect.objectContaining({ ctx: expect.objectContaining({
      workspaceId: 'control-workspace', role: 'worker',
      principal: expect.objectContaining({ slug: 'customer-user', capabilities: new Set(['capability:bash']),
        allowedTools: new Set(['capability:bash']) }) }) }));
    expect(f.ports.toolNames).toEqual(['capability:bash']);
    expect(completeSyncEnrolment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      launchedBy: 'customer-user', sessionId: 'authenticated-session',
      detail: { customerWorkspaceId: 'customer-workspace', organizationId: 'customer-org', foreground: true } }),
    expect.any(Number), { workspaceId: 'control-workspace' });
    expect(finishSyncEnrolment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: 'exited', exitCode: 0 }));
  });

  it.each(['capability:read', 'tools:invoke', 'processes:kill'])('never falls through for %s', async name => {
    const ambient = vi.fn(); const f = await fixture({ deps: { overrideTool: ambient } });
    expect((await f.ports.dispatch(name, {})).isError).toBe(true);
    expect(f.transform).not.toHaveBeenCalled(); expect(f.localHandler).not.toHaveBeenCalled();
    expect(ambient).not.toHaveBeenCalled();
  });

  it.each([{ command: 42 }, { command: 'touch forbidden', principal: '*' },
    { command: 'touch forbidden', run_in_background: true },
    { command: 'touch forbidden', integration_env: { OPENROUTER_API_KEY: 'private' } },
    { command: 'touch forbidden', cmd: 'touch different' }, { command: 'touch forbidden', timeout: -1 }])(
    'refuses invalid or unsupported shell arguments before launch: %j', async args => {
      const f = await fixture(); expect((await f.ports.dispatch('capability:bash', args)).isError).toBe(true);
      expect(f.transform).not.toHaveBeenCalled(); expect(f.localHandler).not.toHaveBeenCalled();
      expect(existsSync(join(project, 'forbidden'))).toBe(false);
    });

  it('preserves resource authorization and role gates before the transport override', async () => {
    for (const tool of [{ authorize: async () => ({ allow: false }) }, { agentRoles: ['architect'] }]) {
      const f = await fixture({ tool });
      expect((await f.ports.dispatch('capability:bash', { command: 'touch forbidden' })).isError).toBe(true);
      expect(f.transform).not.toHaveBeenCalled(); expect(f.localHandler).not.toHaveBeenCalled();
    }
  });

  it('resolves relative cwd on the customer side and accepts the existing cmd alias', async () => {
    mkdirSync(join(project, 'sub'));
    const f = await fixture(); const result = await f.ports.dispatch('capability:bash', { cmd: 'pwd', cwd: 'sub' });
    expect(JSON.parse((result.content![0] as { text: string }).text).output).toBe(`${project}/sub\n`);
  });

  it.each(['userId', 'sessionId', 'sessionVersion', 'activeOrganizationId', 'selectedWorkspaceId', 'workspaceId'])(
    'refuses changed %s for both tools and models', async key => {
      const f = await fixture();
      f.change({ [key]: key === 'sessionVersion' ? 2 : 'foreign' });
      await expect(f.ports.dispatch('capability:bash', { command: 'touch forbidden' })).rejects.toThrow('hosted_customer_execution_denied');
      await expect(consume(f.ports.modelPort)).rejects.toThrow('hosted_customer_execution_denied');
      expect(f.transform).not.toHaveBeenCalled(); expect(f.modelFactory).not.toHaveBeenCalled();
    });

  it('creates a fresh separately bound model port on every request and drops caller account/owner labels', async () => {
    const f = await fixture();
    await consume(f.ports.modelPort, { ...request, account: 'operator-account', ownerId: 'operator-owner' });
    await consume(f.ports.modelPort);
    expect(f.modelFactory).toHaveBeenCalledTimes(2);
    expect(f.modelFactory).toHaveBeenCalledWith(expect.objectContaining({ userId: 'customer-user',
      sessionId: 'authenticated-session', activeOrganizationId: 'customer-org', selectedWorkspaceId: 'customer-workspace' }),
    expect.any(AbortSignal));
    expect(f.modelStream).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'customer-user' }));
    expect(f.modelStream.mock.calls[0][0]).not.toHaveProperty('account');
  });

  it('rechecks session changes while model admission is pending', async () => {
    let release!: (port: ModelPort) => void;
    const f = await fixture({ modelFactory: () => new Promise<ModelPort>(resolve => { release = resolve; }) });
    const pending = consume(f.ports.modelPort);
    await vi.waitFor(() => expect(f.modelFactory).toHaveBeenCalled());
    f.change({ sessionId: 'rotated-session' }); release({ stream: f.modelStream });
    await expect(pending).rejects.toThrow('hosted_customer_execution_denied');
    expect(f.modelStream).not.toHaveBeenCalled();
  });

  it('cancels stalled model admission and never starts a late port', async () => {
    let release!: (port: ModelPort) => void;
    const f = await fixture({ modelFactory: () => new Promise<ModelPort>(resolve => { release = resolve; }) });
    const pending = consume(f.ports.modelPort);
    await vi.waitFor(() => expect(f.modelFactory).toHaveBeenCalled());
    const rejected = expect(pending).rejects.toThrow('hosted_customer_model_unavailable');
    f.controller.abort(); await rejected; release({ stream: f.modelStream }); await Promise.resolve();
    expect(f.modelStream).not.toHaveBeenCalled();
  });

  it('never authorizes tools or starts model admission after invocation cancellation', async () => {
    const f = await fixture(); vi.mocked(f.resolve).mockClear(); f.controller.abort();
    await expect(consume(f.ports.modelPort)).rejects.toThrow('hosted_customer_execution_denied');
    await expect(f.ports.dispatch('capability:bash', { command: 'touch forbidden' }))
      .rejects.toThrow('hosted_customer_execution_denied');
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.modelFactory).not.toHaveBeenCalled();
    expect(f.transform).not.toHaveBeenCalled();
  });

  it('cancels a running customer command through the dispatcher signal and closes its task', async () => {
    await withRunningCustomerCommand(async (f, pending) => {
      f.controller.abort(); expect((await boundedCommandStop(pending)).isError).toBe(true);
      expect(finishSyncEnrolment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: 'killed' }));
    });
  });

  it('propagates an external task kill through the remote wrapper and removes its listener after close', async () => {
    await withRunningCustomerCommand(async (_f, pending) => {
      notifyTaskKillRequested('unrelated-task', 'SIGTERM');
      expect(finishSyncEnrolment).not.toHaveBeenCalled();
      notifyTaskKillRequested('testcustomertask', 'SIGTERM');
      expect((await boundedCommandStop(pending)).isError).toBe(true);
      expect(finishSyncEnrolment).toHaveBeenCalledTimes(1);
      notifyTaskKillRequested('testcustomertask', 'SIGTERM');
      expect(finishSyncEnrolment).toHaveBeenCalledTimes(1);
    });
  });

  it('records deadline expiry distinctly from caller cancellation', async () => {
    const f = await fixture();
    expect((await f.ports.dispatch('capability:bash', { command: 'sleep 30', timeout: 100 })).isError).toBe(true);
    expect(beginSyncEnrolment).toHaveBeenCalled();
    expect(finishSyncEnrolment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: 'timed_out' }));
  });
});
