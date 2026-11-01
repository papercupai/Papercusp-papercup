/**
 * P006: real HTTP/UDS sockets through the SAME production native extension and
 * serializer. This isolates transport/model-content behavior; handler dispatch,
 * authorization, projection and argument reconstruction have separate matrix
 * tests. No production database, installed-runtime claim or latency claim here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getEncoding } from 'js-tiktoken';
import {
  analyzeSchema, configurePrePromptRegistry, clearPrePromptRegistry, projectReadColumns,
} from '@papercusp/result-encoding';
import { serializeToolResponse, formatOptsFromCtx, type SerializeFormatOpts } from '@papercusp/tooldef';
import { registerNativeMcp, type NativeExtensionApi } from '../../omp-plugin/src/native-extension';

const h = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async original => ({
  ...await original<typeof import('node:os')>(), homedir: () => h.home,
}));
import { writeEndpointIpcDiscovery } from './endpoint-ipc-discovery';
import { startAgentMcpServer } from './endpoint-route/routes/transport/_mcp-uds';

const rows = [
  { id: 'WI-1', state: 'todo' }, { id: 'WI-2', state: 'done' },
];
const rowSchema = {
  type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, state: { type: 'string' },
  }, required: ['id', 'state'], additionalProperties: false },
};
const outputSchema = {
  type: 'object', properties: { rows: rowSchema },
  required: ['rows'], additionalProperties: false,
};
const heterogeneous = {
  ok: true, results: [
    { ok: true, id: 'WI-1', state: 'passed' },
    { ok: false, id: 'WI-2', error: 'not found' },
    { ok: true, id: 'WI-3', state: 'passed' },
  ], counts: { ok: 2, failed: 1 },
};
const cases = [
  'compact', 'json', 'csv', 'headerless', 'heterogeneous', 'page',
  'delta', 'structured', 'structured_bad',
] as const;
type Case = typeof cases[number];
type Tool = Parameters<NativeExtensionApi['registerTool']>[0];
type NativeResult = {
  content: Array<{ type: string; text?: string }>;
  details: {
    content: Array<{ type: string; text?: string }>;
    _meta: Record<string, unknown>;
    structuredContent?: unknown;
    nativeMcp: { transportKind: string };
  };
};

function render(name: Case) {
  const opts: SerializeFormatOpts = {
    ...formatOptsFromCtx({
      transport: 'mcp',
      requestedFormat: name === 'json' ? 'json' : name === 'csv' ? 'csv' : undefined,
      requestedStructured: name === 'structured',
    }, name === 'csv' || name === 'headerless' ? analyzeSchema(rowSchema) : undefined),
    ...(name === 'headerless' ? {
      toolName: 'nativeformat:rows', readColumns: projectReadColumns(rowSchema),
    } : {}),
    ...(name === 'delta' ? {
      delta: { mode: 'not_modified' as const, supported: true, cursor: 'fixture-cursor' },
    } : {}),
  };
  const result = serializeToolResponse({
    data: name === 'heterogeneous' ? heterogeneous :
      name === 'structured' || name === 'structured_bad' ? { rows } : rows,
    ...(name === 'page' ? { nextCursor: 'page-2', degraded: true, degradedReasons: ['fixture'] } : {}),
  }, opts);
  // The SDK wire schema has no serializer-internal `format`/`fallback` fields.
  return {
    content: result.content, _meta: result._meta,
    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
  };
}

function register(host: McpServer) {
  host.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: cases.map(name => ({
      name, description: `Format corpus ${name}`, inputSchema: { type: 'object' as const },
      annotations: { readOnlyHint: true },
      ...(name.startsWith('structured') ? { outputSchema } : {}),
    })),
  }));
  host.server.setRequestHandler(CallToolRequestSchema, async request => {
    expect(request.params.arguments).toEqual({ marker: 'same-input' });
    const name = request.params.name as Case;
    if (!cases.includes(name)) throw new Error('unknown_fixture');
    return render(name);
  });
}

afterEach(() => {
  clearPrePromptRegistry();
  vi.unstubAllEnvs();
});

describe('production native extension compact corpus over real HTTP and UDS', () => {
  it('keeps compact model text, metadata, schema validation and tokenizer counts equal', async () => {
    h.home = await mkdtemp(join(tmpdir(), 'native-format-'));
    // Discovery's writer follows the instance home; the client below names
    // this private user home explicitly. Keep both on the same fixture root.
    vi.stubEnv('PAPERCUSP_HOME', join(h.home, '.papercusp'));
    vi.stubEnv('WSL_INTEROP', '');
    vi.stubEnv('WSL_DISTRO_NAME', '');
    vi.stubEnv('PAPERCUSP_IPC_TCP', '');
    configurePrePromptRegistry([{ name: 'nativeformat:rows', read: 'csv' }]);
    const httpHosts: Array<{ host: McpServer; transport: StreamableHTTPServerTransport }> = [];
    const serverErrors: unknown[] = [];
    const http = createServer(async (req, res) => {
      // Stateless HTTP: one fresh host per POST, the exact same register below.
      const host = new McpServer({ name: 'format-corpus', version: '1' }, {
        capabilities: { tools: { listChanged: true } },
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, enableJsonResponse: true,
      });
      httpHosts.push({ host, transport });
      try {
        register(host);
        await host.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        serverErrors.push(error);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('missing_fixture_port');
    const url = `http://127.0.0.1:${address.port}/api/mcp?workspace=format-fixture`;
    const shutdown: Array<() => Promise<void>> = [];
    let uds: Awaited<ReturnType<typeof startAgentMcpServer>> | undefined;
    try {
      uds = await startAgentMcpServer({
        port: address.port,
        host: {
          register, options: { capabilities: { tools: { listChanged: true } } },
          // Binding authentication is tested in the existing handler matrix.
          verify: async () => ({ kind: 'ok', ctx: {
            workspaceId: 'format-fixture', harnessSlug: 'format-fixture', role: 'operator',
            uiClientId: 'format-agent', runId: 'format-run', spawnId: 'format-agent',
            parentSpawnId: null, featureId: null, chunkId: null, detectorSessionKey: null,
            isSuperuser: true,
          } }),
        },
      });
      await writeEndpointIpcDiscovery('/tmp/ui-unused.sock', { port: address.port, agentMcp: uds.endpoint });
      const toolsByMode = new Map<string, Map<string, Tool>>();
      for (const mode of ['http', 'uds'] as const) {
        const tools = new Map<string, Tool>();
        await registerNativeMcp({
          registerTool: tool => { tools.set(tool.name, tool); },
          on: (name, fn) => { if (name === 'session_shutdown') shutdown.push(fn as () => Promise<void>); },
        }, { papercuspNativeMcp: {
          version: 1, mode, home: h.home, servers: { fixture: { type: 'http', url } },
        } });
        expect(tools.size).toBe(cases.length);
        toolsByMode.set(mode, tools);
      }
      const tokenizer = getEncoding('o200k_base');
      const counts: Array<{ name: string; http: number; uds: number }> = [];
      for (const name of cases) {
        const execute = (mode: string) => toolsByMode.get(mode)!
          .get(`mcp__fixture_${name}`)!.execute(`call-${name}`, { marker: 'same-input' });
        if (name === 'structured_bad') {
          // Positive schema inventory + deliberate missing structured payload:
          // the same strict SDK rejects both arms, never reports silent success.
          await expect(execute('http')).rejects.toThrow(/structured|schema/i);
          await expect(execute('uds')).rejects.toThrow(/structured|schema/i);
          continue;
        }
        const baseline = await execute('http') as NativeResult;
        const native = await execute('uds') as NativeResult;
        expect(baseline.details.nativeMcp.transportKind).toBe('http');
        expect(native.details.nativeMcp.transportKind).toBe('uds');
        expect(native.content).toEqual(baseline.content);
        expect(native.details._meta).toEqual(baseline.details._meta);
        expect(native.details.structuredContent).toEqual(baseline.details.structuredContent);
        const text = native.content.map(x => x.text ?? '').join('');
        const httpText = baseline.content.map(x => x.text ?? '').join('');
        expect(text).toBe(httpText);
        expect(tokenizer.encode(text).length).toBe(tokenizer.encode(httpText).length);
        counts.push({ name, http: tokenizer.encode(httpText).length, uds: tokenizer.encode(text).length });
        if (name === 'compact') expect(text).toMatch(/^format: toon\n/);
        if (name === 'json') expect(text).toBe(JSON.stringify(rows));
        if (name === 'csv') expect(text).toBe('format: csv\nid,state\nWI-1,todo\nWI-2,done');
        if (name === 'headerless') expect(text).toBe('format: csv\n[2]\nWI-1,todo\nWI-2,done');
        if (name === 'heterogeneous') expect(text).toBe(JSON.stringify(heterogeneous));
        if (name === 'page') expect(native.details._meta).toMatchObject({ nextCursor: 'page-2' });
        if (name === 'delta') expect(native.details._meta).toMatchObject({
          delta: { mode: 'not_modified', cursor: 'fixture-cursor' },
        });
        if (name === 'structured') expect(native.details.structuredContent).toEqual({ rows });
      }
      expect(counts).toHaveLength(cases.length - 1);
      expect(counts.reduce((sum, row) => sum + row.uds - row.http, 0)).toBe(0);
      // Same maintained tokenizer as agent-mcp/result-format-benchmark.test.ts.
      console.log('P006_MODEL_CONTENT_TOKENS', JSON.stringify({
        tokenizer: 'js-tiktoken',
        version: JSON.parse(readFileSync(join(
          dirname(createRequire(import.meta.url).resolve('js-tiktoken')), '../package.json',
        ), 'utf8')).version,
        encoding: 'o200k_base', counts,
        scope: 'content text only; BPE proxy, not provider billing or whole prompt',
      }));
      expect(serverErrors).toEqual([]);
    } finally {
      await Promise.allSettled(shutdown.map(fn => fn()));
      await uds?.close();
      await Promise.allSettled(httpHosts.map(async ({ host, transport }) => {
        await host.close(); await transport.close();
      }));
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      await rm(h.home, { recursive: true, force: true });
    }
  }, 45_000);
});
