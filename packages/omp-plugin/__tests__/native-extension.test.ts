import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerNativeMcp, type NativeExtensionApi } from '../src/native-extension';

type Tool = Parameters<NativeExtensionApi['registerTool']>[0];
let http: HttpServer;
let shutdown: (() => Promise<void>) | undefined;
let tools: Tool[];
let calls: Record<string, unknown>[];
let nativeCall: Parameters<NativeExtensionApi['on']>[1] | undefined;
let observeOriginal: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  tools = []; calls = []; shutdown = undefined; nativeCall = undefined;
  observeOriginal = vi.fn(async () => undefined);
  const server = new Server({ name: 'native-call-fixture', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo',
    inputSchema: { type: 'object' as const, additionalProperties: true } }] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    calls.push(request.params);
    return { content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
  await server.connect(transport);
  http = createServer((request, response) => {
    void transport.handleRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  await registerNativeMcp({ registerTool: tool => { tools.push(tool); },
    on: (name, handler) => {
      if (name === 'session_shutdown') shutdown = handler as () => Promise<void>;
      else nativeCall = handler as typeof nativeCall;
    } }, {
    papercuspNativeMcp: { version: 1, mode: 'http',
      servers: { 'papercusp-su': { url: `http://127.0.0.1:${address.port}/mcp` } } },
  }, { observe: observeOriginal, close: () => {} });
  // Closing the SDK server also releases its SSE stream.
  const close = shutdown!;
  shutdown = async () => { await close(); await server.close(); };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await shutdown?.();
  http.closeAllConnections();
  await new Promise<void>(resolve => http.close(() => resolve()));
});

describe('owned OMP native MCP call identity', () => {
  it('awaits the parent with a detached original native input, including built-ins', async () => {
    let release!: () => void;
    observeOriginal.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const event = { toolCallId: 'shell-call', toolName: 'bash', input: { command: 'original' } };
    let finished = false;
    const result = nativeCall!(event, { sessionManager: { getSessionId: () => 'native-session' } })
      .then(value => { finished = true; return value; });
    event.input.command = 'rewritten';
    await Promise.resolve(); expect(finished).toBe(false);
    expect(observeOriginal).toHaveBeenCalledWith({ nativeSessionId: 'native-session', callId: 'shell-call',
      tool: 'bash', arguments: { command: 'original' } });
    release(); await expect(result).resolves.toBeUndefined();
  });

  it('blocks rather than executing when the private host refuses an observation', async () => {
    observeOriginal.mockRejectedValue(new Error('host no longer owns this input'));
    await expect(nativeCall!({ toolCallId: 'call', toolName: 'bash', input: {} },
      { sessionManager: { getSessionId: () => 'native-session' } })).resolves.toMatchObject({ block: true });
  });

  it('sends the native callback call and live session on the SDK wire, outside model arguments', async () => {
    const session = randomUUID();
    const args = { threadId: 'model-supplied-session', callId: 'model-supplied-call', value: 7 };
    const controller = new AbortController();
    await tools[0]!.execute('native-call-1', args, controller.signal, undefined,
      { sessionManager: { getSessionId: () => session } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.arguments).toEqual(args);
    expect(calls[0]!._meta).toMatchObject({ threadId: session, callId: 'native-call-1' });
  });

  it('reads each callback context again after a native session change', async () => {
    let session = randomUUID();
    const first = session;
    const context = { sessionManager: { getSessionId: () => session } };
    await tools[0]!.execute('call-a', {}, undefined, undefined, context);
    session = randomUUID();
    await tools[0]!.execute('call-b', {}, undefined, undefined, context);
    expect(calls.map(call => call._meta)).toEqual([
      expect.objectContaining({ threadId: first, callId: 'call-a' }),
      expect.objectContaining({ threadId: session, callId: 'call-b' }),
    ]);
  });

  it.each([
    { call: '', session: randomUUID() },
    { call: 'call', session: '' },
    { call: 'invalid call', session: randomUUID() },
    { call: 'call', session: 'invalid session' },
    { call: 'c'.repeat(257), session: randomUUID() },
    { call: 'call', session: 's'.repeat(129) },
  ])('does not invent a partial native identity from environment or arguments: $call/$session', async value => {
    vi.stubEnv('PAPERCUSP_NATIVE_SESSION_ID', 'inherited-parent');
    vi.stubEnv('CODEX_SESSION_ID', 'unrelated-codex');
    await tools[0]!.execute(value.call, { threadId: 'argument-session', callId: 'argument-call' }, undefined, undefined,
      { sessionManager: { getSessionId: () => value.session } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!._meta ?? {}).not.toHaveProperty('threadId');
    expect(calls[0]!._meta ?? {}).not.toHaveProperty('callId');
  });

  it('keeps a legacy callback unbound when native context is unavailable', async () => {
    await tools[0]!.execute('call', {});
    expect(calls[0]!._meta ?? {}).not.toHaveProperty('threadId');
    expect(calls[0]!._meta ?? {}).not.toHaveProperty('callId');
  });
});
