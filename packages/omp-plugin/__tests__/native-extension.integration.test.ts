/** Real installed OMP executes the owned extension against a private MCP
 * server. Inference is deterministic and local; no provider credential or
 * workspace service participates. This proves a carrier, not authorization. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type BuildOptions } from 'esbuild';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { expect, it } from 'vitest';
import { nativeBuilds } from '../build-native.mjs';

type Frame = Record<string, unknown>;

it('carries the actual installed OMP session and each native call ID over MCP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-native-carrier-'));
  const calls: Frame[] = [];
  const frames: Frame[] = [];
  const observedAtCall: Frame[][] = [];
  const servers = new Set<Server>();
  const http = createServer((request, response) => {
    const server = new Server({ name: 'native-carrier', version: '1' }, { capabilities: { tools: {} } });
    servers.add(server);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo',
      description: 'Local identity proof', inputSchema: { type: 'object' as const,
        properties: { value: { type: 'string' } }, required: ['value'] }, annotations: { readOnlyHint: true } }] }));
    server.setRequestHandler(CallToolRequestSchema, async message => {
      calls.push(message.params);
      observedAtCall.push([...frames]);
      return { content: [{ type: 'text', text: String(message.params.arguments?.value) }] };
    });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    response.on('close', () => { void server.close(); servers.delete(server); });
    void server.connect(transport).then(() => transport.handleRequest(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  let child: ChildProcessWithoutNullStreams | undefined;
  let stderr = '';
  try {
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    const agentDir = join(root, 'agent');
    await mkdir(agentDir);
    // Reuse the production bundle recipe, building ONLY into this private root.
    const checkout = fileURLToPath(new URL('../../../', import.meta.url));
    const recipe = nativeBuilds(checkout, `${root}/`).find((value: BuildOptions) => value.format === 'esm');
    if (!recipe) throw new Error('owned extension build recipe missing');
    await build(recipe);
    await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ papercuspNativeMcp: {
      version: 1, mode: 'http', servers: { 'papercusp-su': { url: `http://127.0.0.1:${address.port}/mcp` } },
    } }));
    const provider = join(root, 'local-provider.ts');
    await writeFile(provider, `export default function(pi) {
      let turn = 0;
      pi.registerProvider('native-carrier-fixture', {
        api: 'native-carrier-fixture-api', apiKey: 'local-only', baseUrl: 'http://unused.invalid',
        models: [{ id: 'proof', name: 'Local proof', reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
        streamSimple(model) {
          if (++turn > 3) throw new Error('Unexpected inference turn');
          const content = turn <= 2
            ? [{ type: 'toolCall', id: 'native-call-' + turn, name: 'mcp__papercusp_su_echo', arguments: { value: 'proof-' + turn } }]
            : [{ type: 'text', text: 'Complete' }];
          const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: turn <= 2 ? 'toolUse' : 'stop', timestamp: Date.now() };
          return { async *[Symbol.asyncIterator]() {
            yield { type: 'start', partial: message };
            if (turn <= 2) yield { type: 'toolcall_end', contentIndex: 0, toolCall: content[0], partial: message };
            yield { type: 'done', reason: message.stopReason, message };
          }, result: async () => message };
        },
      });
    }`);
    child = spawn(process.env.PAPERCUSP_OMP_BINARY || 'omp', ['--mode', 'rpc', '--no-extensions', '--no-skills',
      '--no-rules', '--no-session', '--extension', join(root, 'native-extension.mjs'), '--extension', provider,
      '--model', 'native-carrier-fixture/proof'], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8',
        PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: join(root, 'sessions'),
        // A stale parent identity must never replace the live callback context.
        PAPERCUSP_NATIVE_SESSION_ID: 'inherited-parent', CODEX_SESSION_ID: 'unrelated-codex',
      },
    });
    let stdout = '';
    let launchError: Error | undefined;
    child.on('error', error => { launchError = error; });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (part: string) => {
      stdout += part;
      let newline: number;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline).trim(); stdout = stdout.slice(newline + 1);
        if (line) frames.push(JSON.parse(line));
      }
    });
    child.stderr.on('data', (part: string) => { stderr = (stderr + part).slice(-4000); });
    const waitFor = async (read: () => Frame | undefined) => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const value = read();
        if (value) return value;
        if (launchError || child!.exitCode !== null || child!.signalCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`OMP native carrier did not progress: ${launchError?.message ?? stderr}`);
    };
    await waitFor(() => frames.find(frame => frame.type === 'ready'));
    child.stdin.write(`${JSON.stringify({ id: 'state', type: 'get_state' })}\n`);
    const state = await waitFor(() => frames.find(frame => frame.type === 'response' && frame.id === 'state'));
    expect(state.success).toBe(true);
    const nativeSessionId = (state.data as Frame).sessionId;
    expect(nativeSessionId).toEqual(expect.any(String));
    expect(nativeSessionId).not.toBe('inherited-parent');
    // OMP mounts extension MCP tools as xd devices. dumpTools is the separate
    // top-level inventory and cannot establish this server's call population.
    const prompt = ((state.data as Frame).systemPrompt as string[]).join('\n');
    const routes = prompt.split(/^## MCP Tool Routes\r?$/m).slice(1)
      .flatMap(section => section.split(/^#{1,2} /m, 1)[0]!.match(/xd:\/\/[^`\s]+/g) ?? []);
    expect(routes).toContain('xd://mcp__papercusp_su_echo');
    child.stdin.write(`${JSON.stringify({ id: 'proof', type: 'prompt', message: 'Run the two local calls.' })}\n`);
    await waitFor(() => frames.find(frame => frame.type === 'agent_end'));
    expect(frames.filter(frame => frame.type === 'tool_execution_end').map(frame => frame.isError)).toEqual([false, false]);
    expect(calls.map(call => call.arguments)).toEqual([{ value: 'proof-1' }, { value: 'proof-2' }]);
    expect(calls.map(call => call._meta)).toEqual([
      expect.objectContaining({ threadId: nativeSessionId, callId: 'native-call-1' }),
      expect.objectContaining({ threadId: nativeSessionId, callId: 'native-call-2' }),
    ]);
    // An attached host must independently see the accepted root input and
    // exact model call. MCP metadata alone cannot grant retained authority.
    // Check the installed runtime's actual order at the HTTP boundary, not a
    // protocol peer or a reconstruction after agent_end.
    for (const [index, observed] of observedAtCall.entries()) {
      const input = observed.find(frame => frame.type === 'message_start'
        && (frame.message as Frame)?.role === 'user');
      expect(input, JSON.stringify(observed)).toMatchObject({ message: { role: 'user',
        content: [{ type: 'text', text: 'Run the two local calls.' }] } });
      const assistant = observed.filter(frame => frame.type === 'message_end'
        && (frame.message as Frame)?.role === 'assistant');
      const nativeCalls = assistant.flatMap(frame => (frame.message as Frame).content as Frame[])
        .filter(block => block.type === 'toolCall');
      expect(nativeCalls, JSON.stringify(observed)).toContainEqual({ type: 'toolCall',
        id: `native-call-${index + 1}`, name: 'mcp__papercusp_su_echo',
        arguments: calls[index]!.arguments });
      expect(observed.some(frame => frame.type === 'agent_start')).toBe(true);
      expect(observed.some(frame => frame.type === 'agent_end')).toBe(false);
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null && child.pid) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child!.kill('SIGKILL'), 3000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await Promise.allSettled([...servers].map(server => server.close()));
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
