// Real sockets, packaged adapters and an installed runtime: this proof belongs
// to the integration layer required by SPEC-UDS-005-01, not the pure unit lane.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, rm, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createTextCollector } from './child-output';

const h = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async original => ({
  ...await original<typeof import('node:os')>(), homedir: () => h.home,
}));
import { agentMcpMode, connectAgentMcp, localAgentMcpPort, prepareNativeOmpConfig } from './agent-mcp-client';
import { writeEndpointIpcDiscovery } from './endpoint-ipc-discovery';
import { startAgentMcpServer, type AgentMcpListener } from './endpoint-route/routes/transport/_mcp-uds';
import type { BuiltSpawnContext } from './endpoint-route/routes/transport/_mcp-host';
let listener: AgentMcpListener | undefined;
beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), 'native-client-'));
  vi.stubEnv('WSL_INTEROP', '');
  vi.stubEnv('WSL_DISTRO_NAME', '');
  vi.stubEnv('PAPERCUSP_IPC_TCP', '');
});
afterEach(async () => {
  await listener?.close();
  listener = undefined;
  await rm(h.home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const url = 'http://127.0.0.1:33170/api/mcp?superuser=1&workspace=fixture&client=fixture-agent';
const expectedCtx: BuiltSpawnContext = {
  workspaceId: 'fixture', harnessSlug: 'fixture', role: 'operator', uiClientId: 'fixture-agent',
  runId: 'r', spawnId: 's', parentSpawnId: null, featureId: null, chunkId: null,
  detectorSessionKey: null, isSuperuser: true,
};
async function server() {
  const witness = vi.fn();
  const fixture = { value: 'initial', writes: [] as string[] };
  const verify = vi.fn(async (extra: unknown) => {
    const headers = (extra as { requestInfo: { headers: Record<string, string> } }).requestInfo.headers;
    return headers.authorization === 'Bearer fixture-token'
      ? { kind: 'ok' as const, ctx: { ...expectedCtx } }
      : { kind: 'failed' as const, reason: 'invalid' };
  });
  const register = (host: McpServer) => {
    host.server.setRequestHandler(ListToolsRequestSchema, async () => {
      witness('list');
      return { tools: [{ name: 'echo', description: 'Read fixture row',
        annotations: { readOnlyHint: true }, inputSchema: {
        type: 'object', properties: { row: { type: 'string' } },
      } }, { name: 'fixture_set', description: 'Reversibly update this isolated fixture',
        annotations: { readOnlyHint: false }, inputSchema: {
          type: 'object', properties: { value: { type: 'string' } }, required: ['value'],
        } }] };
    });
    host.server.setRequestHandler(CallToolRequestSchema, async request => {
      if (request.params.name === 'fixture_set') {
        const value = request.params.arguments?.value;
        if (typeof value !== 'string') throw new Error('fixture_value_required');
        fixture.value = value;
        fixture.writes.push(value);
        witness('set', value);
        return { content: [{ type: 'text' as const, text: `fixture=${value}` }] };
      }
      if (request.params.name !== 'echo') throw new Error('unknown_fixture_tool');
      witness('call', request.params.arguments);
      return { content: [{ type: 'text' as const, text: 'compact-result' }],
        _meta: { retained: true, fixtureValue: fixture.value } };
    });
  };
  listener = await startAgentMcpServer({
    port: 33170,
    host: {
      verify, options: { capabilities: { tools: {} } },
      register,
    },
  });
  await writeEndpointIpcDiscovery('/tmp/ui-unused.sock', { port: 33170, agentMcp: listener.endpoint });
  return { witness, verify, fixture, register };
}

describe('owned native MCP client', () => {
  it('reconciles a dispatched unknown UDS mutation before explicit HTTP rollback, without replay', async () => {
    const { witness, fixture, register } = await server();
    const connection = await connectAgentMcp({
      url, mode: 'auto', headers: { Authorization: 'Bearer fixture-token' }, home: h.home,
    });
    // The handler changes fixture state first. Kill the actual listener before
    // its response send; SDK ConnectionClosed must not hide the unknown outcome.
    witness.mockImplementation((event: string) => {
      if (event === 'set') void listener!.close();
    });
    try {
      await expect(connection.client.callTool({
        name: 'fixture_set', arguments: { value: 'committed-before-disconnect' },
      })).rejects.toMatchObject({
        code: 'uds_outcome_unknown', outcome: 'unknown', automaticRetry: false,
      });
      expect(fixture.writes).toEqual(['committed-before-disconnect']);
      expect(witness.mock.calls).toEqual([['set', 'committed-before-disconnect']]);
      // A subsequent call is rejected without dispatch, not silently reconnected.
      await expect(connection.client.callTool({
        name: 'fixture_set', arguments: { value: 'must-not-run' },
      })).rejects.toThrow();
      expect(fixture.writes).toHaveLength(1);
    } finally { await connection.client.close(); }

    // Authoritative state reconciliation precedes rollback. Only after the
    // committed value is known do we create a fresh HTTP connection/profile;
    // the unresolved UDS mutation is never sent again.
    expect(fixture.value).toBe('committed-before-disconnect');
    const httpHosts: Array<{ host: McpServer; transport: StreamableHTTPServerTransport }> = [];
    const httpErrors: unknown[] = [];
    const http = createHttpServer(async (request, response) => {
      const host = new McpServer({ name: 'rollback-fixture', version: '1' }, { capabilities: { tools: {} } });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, enableJsonResponse: true,
      });
      httpHosts.push({ host, transport });
      try {
        expect(request.headers.authorization).toBe('Bearer fixture-token');
        register(host);
        await host.connect(transport);
        await transport.handleRequest(request, response);
      } catch (error) {
        httpErrors.push(error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('missing_http_rollback_port');
    const rollbackUrl = `http://127.0.0.1:${address.port}/api/mcp`;
    try {
      const rolledBack = await connectAgentMcp({
        url: rollbackUrl, mode: 'http', headers: { Authorization: 'Bearer fixture-token' }, home: h.home,
      });
      try {
        expect(rolledBack.transportKind).toBe('http');
        expect(await rolledBack.client.callTool({ name: 'echo', arguments: { row: 'after-reconcile' } }))
          .toMatchObject({ _meta: { fixtureValue: 'committed-before-disconnect' } });
      } finally { await rolledBack.client.close(); }
      expect(fixture.writes).toEqual(['committed-before-disconnect']);
      expect(witness.mock.calls.filter(call => call[0] === 'set')).toEqual([
        ['set', 'committed-before-disconnect'],
      ]);
      expect(httpErrors).toEqual([]);
    } finally {
      await Promise.allSettled(httpHosts.map(async ({ host, transport }) => {
        await host.close(); await transport.close();
      }));
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    }
  });

  it('discovers, initializes, lists and calls the actual listener without HTTP', async () => {
    const { witness, verify, fixture } = await server();
    const connection = await connectAgentMcp({
      url, mode: 'uds', headers: { Authorization: 'Bearer fixture-token' }, home: h.home,
    });
    try {
      expect(connection.transportKind).toBe('uds');
      expect(connection.generation).toBe(listener!.endpoint.generation);
      expect((await connection.client.listTools()).tools[0].name).toBe('echo');
      expect(await connection.client.callTool({ name: 'echo', arguments: { row: 'a,b' } }))
        .toMatchObject({ content: [{ text: 'compact-result' }], _meta: { retained: true } });
      expect(witness.mock.calls).toEqual([['list'], ['call', { row: 'a,b' }]]);
      expect(fixture).toEqual({ value: 'initial', writes: [] });
      expect(verify).toHaveBeenCalledTimes(3);
    } finally { await connection.client.close(); }
  });

  it('does not fall back to HTTP after a discovered UDS credential rejection', async () => {
    const { witness } = await server();
    await expect(connectAgentMcp({
      url, mode: 'auto', headers: { Authorization: 'Bearer SECRET-wrong' }, home: h.home,
    })).rejects.toThrow(/^uds_connection_failed$/);
    expect(witness).not.toHaveBeenCalled();
  });

  it('requires a usable descriptor for explicit UDS, including after server shutdown', async () => {
    await server();
    await listener!.close();
    await expect(connectAgentMcp({ url, mode: 'uds', home: h.home })).rejects.toThrow('uds_endpoint_unavailable');
  });

  it('fails pending calls instead of reopening or resending after disconnect', async () => {
    await server();
    const connected = await connectAgentMcp({
      url, mode: 'uds', headers: { Authorization: 'Bearer fixture-token' },
    });
    try {
      await listener!.close();
      await expect(connected.client.callTool({ name: 'echo' })).rejects.toThrow();
    } finally { await connected.client.close(); }
  });

  it.each([
    ['https://127.0.0.1:33170/api/mcp', 'linux', {}],
    ['http://remote.example/api/mcp', 'linux', {}],
    [url, 'win32', {}],
    [url, 'linux', { WSL_INTEROP: 'yes' }],
    [url, 'linux', { PAPERCUSP_IPC_TCP: '1' }],
  ])('preserves unsupported route %s %s %j', (value, platform, env) => {
    expect(localAgentMcpPort(value as string, platform as string, env as NodeJS.ProcessEnv)).toBeNull();
  });

  it('moves only eligible entries and resolves only maintained header templates, never a shell', () => {
    const config = { mcpServers: {
      papercusp: { type: 'http', url, headers: { 'x-papercusp-client': '!printf %s "${PAPERCUSP_SID:-}"' } },
      remote: { type: 'http', url: 'https://remote.example/api/mcp' },
      custom: { type: 'http', url, headers: { Authorization: '!do-not-run' } },
      stdio: { type: 'stdio', command: 'never-executed' },
    } };
    const text = JSON.stringify(config);
    expect(prepareNativeOmpConfig(text, { mode: 'http' })).toBe(text);
    const result = JSON.parse(prepareNativeOmpConfig(text, {
      mode: 'auto', home: h.home, platform: 'linux', env: { PAPERCUSP_SID: 'original' },
    }));
    expect(result.mcpServers).toEqual({
      remote: config.mcpServers.remote, custom: config.mcpServers.custom, stdio: config.mcpServers.stdio,
    });
    expect(result.papercuspNativeMcp.servers.papercusp.headers['x-papercusp-client']).toBe('original');
    expect(result.papercuspNativeMcp.home).toBe(h.home);
    expect(JSON.stringify(result)).not.toContain('unix://');
  });

  it('keeps rollout policy explicit and rejects unknown transport values', () => {
    expect(agentMcpMode(undefined)).toBe('http');
    expect(agentMcpMode('uds')).toBe('uds');
    expect(() => agentMcpMode('stdio')).toThrow();
  });
});

const execute = promisify(execFile);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const omp = (process.env.PATH ?? '').split(delimiter)
  .map(dir => join(dir, 'omp')).find(path => existsSync(path));

describe('installed clients using the built production adapter', () => {
  beforeAll(async () => {
    await execute(process.execPath, [join(repo, 'packages/omp-plugin/build-native.mjs')], { timeout: 20_000 });
  }, 25_000);
  it('executes the actual ptool CLI through discovered UDS, not HTTP', async () => {
    const { witness } = await server();
    const token = join(h.home, 'fixture-token');
    await writeFile(token, 'fixture-token', { mode: 0o600 });
    const result = await execute(process.execPath, [
      join(repo, 'apps/operator/scripts/ptool.mjs'), 'echo',
      '--url=http://127.0.0.1:33170', '--transport=uds', `--token-file=${token}`,
      '--workspace=fixture', '--harness=fixture', '--json={"row":"cli-row"}',
    ], {
      timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: h.home, PAPERCUSP_OPERATOR_HOME: h.home,
        PAPERCUSP_SID: 'fixture-agent' },
    });
    expect(result.stdout).toContain('compact-result');
    expect(witness.mock.calls).toContainEqual(['call', { row: 'cli-row' }]);
  }, 25_000);

  it.skipIf(!omp)('runs installed OMP through the packaged launcher, survives listener restart, and resumes the same native session over UDS', async () => {
    const initial = await server();
    const packagedScripts = join(h.home, 'packaged-sidecar', 'scripts');
    const packagedPsu = join(packagedScripts, 'psu.mjs');
    await mkdir(packagedScripts, { recursive: true });
    await execute('bash', ['-c', [
      'set -euo pipefail',
      'source "$P009_REPO/apps/operator/bin/bundle-host-common.sh"',
      'npx --yes esbuild@0.25.0 "$P009_REPO/apps/operator/scripts/psu-launcher.mjs" --bundle --platform=node --format=esm --target=node22 --minify-whitespace --minify-syntax --outfile="$P009_OUT" --banner:js="$HOST_BANNER" "--external:@lydell/*"',
    ].join('\n')], {
      timeout: 20_000,
      env: { ...process.env, P009_REPO: repo, P009_OUT: packagedPsu },
    });
    await Promise.all(['native-client.cjs', 'native-extension.mjs'].map(name =>
      copyFile(join(repo, 'packages/omp-plugin/dist', name), join(packagedScripts, name))));
    const packagedLauncher = await import(`${pathToFileURL(packagedPsu).href}?p009=${Date.now()}`);
    expect(Object.fromEntries(Object.entries(packagedLauncher.resolveNativeMcpAssets())
      .map(([name, value]) => [name, fileURLToPath(value as URL)]))).toEqual({
      bundle: join(packagedScripts, 'native-client.cjs'),
      extension: join(packagedScripts, 'native-extension.mjs'),
    });
    const sourceAgentDir = join(h.home, '.omp', 'agent');
    await mkdir(sourceAgentDir, { recursive: true });
    await writeFile(join(sourceAgentDir, 'config.yml'), 'tools:\n  discoveryMode: false\n');
    await writeFile(join(sourceAgentDir, 'mcp.json'), JSON.stringify({
      mcpServers: { papercusp: { type: 'http', url, headers: {
        Authorization: 'Bearer fixture-token',
        'x-papercusp-client': '!printf %s "${PAPERCUSP_SID:-}"',
        'x-papercusp-workspace': '!printf %s "${PAPERCUSP_WORKSPACE:-}"',
        'x-papercusp-profile': '!printf %s "${PAPERCUSP_PROFILE:-}"',
      } } },
    }), { mode: 0o600 });
    vi.stubEnv('PAPERCUSP_MCP_TRANSPORT', 'uds');
    const rel = packagedLauncher.writeOmpSessionConfigDir('p005-runtime', {
      nativeMcp: true, clientId: 'fixture-agent', operatorUrl: 'http://127.0.0.1:33170',
      mcpEnv: { PAPERCUSP_WORKSPACE: 'fixture', PAPERCUSP_PROFILE: 'fixture-profile' },
    }, h.home);
    expect(rel).toBeTruthy();
    const freshEnv = {
      PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: h.home,
      PI_CONFIG_DIR: rel!, PI_CODING_AGENT_DIR: join(h.home, rel!, 'agent'),
    };
    const installed = await execute(omp!, ['--version'], {
      env: freshEnv, cwd: h.home, timeout: 60_000,
    });
    const version = installed.stdout.trim();
    expect(version).toMatch(/18\.0\.3/);
    const freshArgs = packagedLauncher.nativeOmpExtensionArgs('omp');
    const provider = join(h.home, 'offline-provider.mjs');
    // An offline deterministic provider drives OMP's actual agent loop. It
    // cannot implement the tool or its transport; those come from the package.
    await writeFile(provider, `
export default function(pi) {
 let turn=0;
 const journey=[
  ['echo',{row:'omp-row'}],['fixture_set',{value:'changed'}],
  ['echo',{row:'omp-row'}],['fixture_set',{value:'initial'}],
 ];
 pi.registerProvider('p005-offline', {
  api:'p005-offline-api',apiKey:'fixture',baseUrl:'http://unused.invalid',
  models:[{id:'proof',name:'Offline',reasoning:false,input:['text'],
   cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:1024}],
  streamSimple(model) {
   const step=journey[turn++];
   const tool=Boolean(step);
   const content=tool?[{type:'toolCall',id:'actual-omp-call-'+turn,name:'mcp__papercusp_'+step[0],arguments:step[1]}]
    :[{type:'text',text:'done'}];
   const message={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
    stopReason:tool?'toolUse':'stop',timestamp:Date.now()};
   return {async *[Symbol.asyncIterator](){yield {type:'start',partial:message};
    if(tool)yield {type:'toolcall_end',contentIndex:0,toolCall:content[0],partial:message};
    yield {type:'done',reason:message.stopReason,message};},result:async()=>message};
  }
 });
}
`, { mode: 0o600 });
    const run = async (args: string[], env: NodeJS.ProcessEnv, provision = false): Promise<string> => {
      const child = spawn(omp!, [
        '--mode', 'rpc', '--no-extensions', '--no-skills', '--no-rules',
        ...args,
        '--extension', provider, '--model', 'p005-offline/proof',
      ], { cwd: h.home, stdio: 'pipe', env });
      const closed = once(child, 'close');
      const frames: Array<Record<string, any>> = [];
      let output = '';
      const errors = createTextCollector(child.stderr, { maxChars: 4_000 });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        let newline: number;
        while ((newline = output.indexOf('\n')) >= 0) {
          const line = output.slice(0, newline);
          output = output.slice(newline + 1);
          if (line.trim()) frames.push(JSON.parse(line));
        }
      });
      // One journey deadline, not a fresh allowance for every frame.
      const end = Date.now() + (provision ? 60_000 : 15_000);
      const wait = async (predicate: () => boolean) => {
        while (!predicate()) {
          if (Date.now() > end || child.exitCode !== null || child.signalCode !== null)
            throw new Error(`Native OMP did not complete: ${errors.peek()}; ${JSON.stringify(frames.slice(-3))}`);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      };
      try {
        await wait(() => frames.some(x => x.type === 'ready'));
        child.stdin.write(JSON.stringify({ id: 'native-state', type: 'get_state' }) + '\n');
        await wait(() => frames.some(x => x.id === 'native-state'));
        const state = frames.find(x => x.id === 'native-state');
        expect(state?.success).toBe(true);
        expect(state?.data?.sessionId).toEqual(expect.any(String));
        if (provision) return state!.data.sessionId;
        child.stdin.write(JSON.stringify({ id: 'native-call', type: 'prompt', message: 'Invoke the MCP fixture.' }) + '\n');
        await wait(() => frames.some(x => x.type === 'agent_end'));
        const calls = frames.filter(x => x.type === 'tool_execution_end');
        expect(calls).toHaveLength(4);
        expect(calls[0]).toMatchObject({ toolName: 'mcp__papercusp_echo', isError: false });
        expect(calls[0].result.content).toEqual([{ type: 'text', text: 'compact-result' }]);
        expect(calls[0].result.details._meta.fixtureValue).toBe('initial');
        expect(calls[1]).toMatchObject({
          toolName: 'mcp__papercusp_fixture_set', isError: false,
          result: { content: [{ type: 'text', text: 'fixture=changed' }] },
        });
        expect(calls[2].result.details._meta.fixtureValue).toBe('changed');
        expect(calls[3]).toMatchObject({
          toolName: 'mcp__papercusp_fixture_set', isError: false,
          result: { content: [{ type: 'text', text: 'fixture=initial' }] },
        });
        for (const call of calls) {
          expect(call.result.details.nativeMcp).toEqual({
            transportKind: 'uds', operatorId: listener!.endpoint.operatorId,
            generation: listener!.endpoint.generation,
          });
        }
        return state!.data.sessionId;
      } finally {
        child.stdin.end();
        const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
        try { await closed; } finally { clearTimeout(timer); }
      }
    };
    // A new HOME is a new OMP installation: the compiled binary unpacks its
    // large native addon before emitting ANY RPC frame. --version does not
    // perform that installation. Provision with an empty, ephemeral RPC boot
    // and assert its files exist before the unchanged 15s transport journeys.
    // Cold installation performance belongs to P008, not this client proof.
    await run(['--no-session'], freshEnv, true);
    const natives = join(h.home, '.omp', 'natives', '18.0.3');
    const addons = (await readdir(natives)).filter(name => name.endsWith('.node'));
    expect(addons.length).toBeGreaterThan(0);
    for (const addon of addons) expect((await stat(join(natives, addon))).size).toBeGreaterThan(0);
    expect(initial.witness.mock.calls.filter(x => x[0] === 'call')).toEqual([]);
    const sessionId = await run(freshArgs, freshEnv);
    expect(initial.witness.mock.calls.filter(x => x[0] === 'call')).toEqual([
      ['call', { row: 'omp-row' }], ['call', { row: 'omp-row' }],
    ]);
    expect(initial.fixture).toEqual({ value: 'initial', writes: ['changed', 'initial'] });
    const initialGeneration = listener!.endpoint.generation;
    await listener!.close();
    listener = undefined;
    const restarted = await server();
    expect(listener!.endpoint.generation).not.toBe(initialGeneration);
    // Fresh process and no ambient opt-in: restore from the launcher-written
    // config, discover the restarted listener generation, pass the REAL saved
    // native id, and prove the resumed tool runs.
    vi.stubEnv('PAPERCUSP_MCP_TRANSPORT', '');
    const session = { agent: 'omp', role: 'su', id: 'p005-runtime', ompThreadId: sessionId };
    const restoredEnv = { ...freshEnv, ...packagedLauncher.ompTrackedResumeEnv(session, { home: h.home }) };
    const resume = packagedLauncher.resumeArgsFor(session, { env: restoredEnv });
    expect(resume.bin).toBe('omp');
    expect(await run(resume.args, restoredEnv)).toBe(sessionId);
    expect(restarted.witness.mock.calls.filter(x => x[0] === 'call')).toEqual([
      ['call', { row: 'omp-row' }], ['call', { row: 'omp-row' }],
    ]);
    expect(restarted.fixture).toEqual({ value: 'initial', writes: ['changed', 'initial'] });
    for (const [extra] of [...initial.verify.mock.calls, ...restarted.verify.mock.calls]) {
      expect(extra).toMatchObject({ requestInfo: { headers: {
        'x-papercusp-client': 'fixture-agent', 'x-papercusp-workspace': 'fixture',
        'x-papercusp-profile': 'fixture-profile',
      } } });
    }
  }, 105_000);
});
