import { request } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdaptorServer, serve } from '@hono/node-server';
import { captureOperatorHttpSecurityPopulation, handler } from './host-handler';
import { captureRuntimeSecurityCensus, readRuntimeSecurityCensus } from '@papercusp/operator-core/lib/observability/runtime';
import { _injectPluginHostForTests, _resetPluginHostForTests } from '@papercusp/operator-core/lib/plugin-host-runtime';
import { registerReactionRule, unregisterReactionRule } from '@papercusp/operator-core/lib/events/registry';
import { enterGuardHttpRequest, installGuardHttpDiagnostics, markGuardHttpStage } from '@papercusp/operator-core/lib/endpoint-route/telemetry';

const servers: Array<ReturnType<typeof serve>> = [];
const ENV_KEYS = [
  'PAPERCUSP_ALLOW_REMOTE_ADMIN',
  'PAPERCUSP_BIND_HOST',
  'PAPERCUSP_REMOTE_ORIGINS',
] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

const GUARD_ID = '550e8400-e29b-41d4-a716-446655440000';
const PRIVATE_GUARD_INPUT = 'private-guard-input-never-emit';

async function startGuardServer(fetch: Parameters<typeof createAdaptorServer>[0]['fetch'] = handler) {
  const server = createAdaptorServer({ fetch });
  installGuardHttpDiagnostics(server as import('node:http').Server);
  // Repeated setup must not duplicate request observers or output.
  installGuardHttpDiagnostics(server as import('node:http').Server);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
  return address.port;
}

function guardRequest(port: number, id: string | string[] = GUARD_ID, path = '/api/agent-mcp/tool-guard') {
  const req = request({ hostname: '127.0.0.1', port, path, method: 'POST',
    headers: { 'x-papercusp-guard-request-id': id, 'content-type': 'application/json' } });
  // Missing owner/tool exercises the real route's early response without reading authority.
  req.end(JSON.stringify({ input: PRIVATE_GUARD_INPUT }));
  return req;
}

interface GuardTraceRow {
  guardRequestId: string;
  event: string;
  elapsedMs: number;
  stagesMs: Record<string, number>;
  headersSent: boolean;
  writableFinished: boolean;
}
function guardTraceRows(log: { mock: { calls: readonly (readonly unknown[])[] } }): GuardTraceRow[] {
  return log.mock.calls.filter(([label]) => label === '[tool-guard-http-timing]')
    .map(([, body]) => JSON.parse(String(body)) as GuardTraceRow);
}

describe('guard HTTP outer timing', () => {
  it('correlates the real adapter, composed Hono stack, route, response and header write without body data', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const port = await startGuardServer();
    const req = guardRequest(port);
    const [res] = await once(req, 'response');
    res.resume();
    await once(res, 'end');
    const rows = guardTraceRows(log);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ guardRequestId: GUARD_ID, event: 'finish',
      headersSent: true, writableFinished: true });
    const stages = rows[0].stagesMs;
    const ordered = ['hono_enter', 'middleware_enter', 'route_start', 'route_end', 'hono_response', 'headers_write']
      .map(stage => stages[stage]);
    expect(ordered.every(value => Number.isFinite(value) && value >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    expect(rows[0].elapsedMs).toBeGreaterThanOrEqual(ordered.at(-1)!);
    expect(JSON.stringify(rows)).not.toContain(PRIVATE_GUARD_INPUT);
  });

  it('records disconnect before headers and separately captures the late response', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let entered!: () => void, release!: () => void, settled!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const done = new Promise<void>(resolve => { settled = resolve; });
    let closed!: Promise<unknown>;
    const port = await startGuardServer(async (req, bindings) => {
      enterGuardHttpRequest(req, bindings.incoming as import('node:http').IncomingMessage);
      closed = once(bindings.outgoing, 'close');
      entered();
      await hold;
      markGuardHttpStage(req, 'hono_response');
      settled();
      return new Response('late');
    });
    const req = guardRequest(port);
    req.on('error', () => {}); // Expected ECONNRESET from this test's explicit disconnect.
    await entry;
    req.destroy();
    await closed;
    expect(guardTraceRows(log)).toEqual([expect.objectContaining({ event: 'close', headersSent: false })]);
    release();
    await done;
    const rows = guardTraceRows(log);
    expect(rows.map(row => row.event)).toEqual(['close', 'late_response']);
    expect(rows[0].stagesMs.hono_response).toBeUndefined();
    expect(rows[1].stagesMs.hono_response).toBeGreaterThanOrEqual(rows[0].elapsedMs);
    expect(JSON.stringify(rows)).not.toContain(PRIVATE_GUARD_INPUT);
  });

  it('ignores arbitrary/duplicate identifiers and unrelated paths without consuming their bodies', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const port = await startGuardServer(async req => new Response(await req.text()));
    for (const [id, path] of [[PRIVATE_GUARD_INPUT, '/api/agent-mcp/tool-guard'],
      [[GUARD_ID, GUARD_ID], '/api/agent-mcp/tool-guard'], [GUARD_ID, '/api/health']] as const) {
      const req = guardRequest(port, Array.isArray(id) ? [...id] : id as string, path);
      const [res] = await once(req, 'response');
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      await once(res, 'end');
      expect(body).toContain(PRIVATE_GUARD_INPUT);
    }
    expect(guardTraceRows(log)).toEqual([]);
  });
});

function startServer() {
  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req, bindings) => {
      // The real adapter supplies the accepted socket through the second
      // fetch argument. Override only its peer address so a loopback test
      // connection exercises the off-box branch deterministically.
      Object.defineProperty(bindings.incoming.socket, 'remoteAddress', {
        configurable: true,
        value: '203.0.113.10',
      });
      return handler(req, bindings);
    },
  });
  servers.push(server);
  return new Promise<typeof server>((resolve, reject) => {
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

function getHealth(port: number): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'GET',
        path: '/api/health',
        headers: {
          host: 'localhost',
          origin: 'https://app.example.com',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'app.example.com',
          'x-papercusp-workspace': 'papercusp-workspace',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('host handler HTTP composition', () => {
  it('captures newly registered reaction edges without executing conditions or copying private arguments', async () => {
    const id = 'vault-census-omission-control';
    const when = vi.fn(() => { throw Error('discovery executed a condition'); });
    registerReactionRule({ id, on: ['vault:probe', 'vault:other'], fire: 'vault:effect', when,
      args: { payload: 'private-census-canary' } });
    try {
      const captured = await captureOperatorHttpSecurityPopulation();
      expect(captured.surfaces.find(row => row.kind === 'registered-event-reaction' && row.surfaceId === id))
        .toMatchObject({ attrs: { on: ['vault:probe', 'vault:other'], fire: 'vault:effect' } });
      expect(JSON.stringify(captured)).not.toContain('private-census-canary');
      expect(when).not.toHaveBeenCalled();
      expect(captured.unresolved).toContain('reaction-registration-source-and-adapter-reconciliation-unverified');
      expect(captured.closureAccepted).toBe(false);
    } finally { unregisterReactionRule(id); }
    const after = await captureOperatorHttpSecurityPopulation();
    expect(after.surfaces.some(row => row.kind === 'registered-event-reaction' && row.surfaceId === id)).toBe(false);
  });
  it('includes unloaded plugin declarations in the declared census without promoting them to serving handlers', async () => {
    _injectPluginHostForTests([], { roots: [], unavailable: [], candidates: [{
      path: '/excluded', source: 'project', status: 'excluded', reason: 'not installed',
      manifest: { name: 'excluded', tools: [{ name: 'unavailable-tool' }], apiRoutes: false },
    }] });
    try {
      const captured = await captureOperatorHttpSecurityPopulation();
      const declarations = captured.declaredSurfaces.filter(row => row.kind === 'configured-plugin-declaration');
      expect(declarations).toHaveLength(2);
      expect(declarations[0]!.attrs).toMatchObject({ discoveryStatus: 'excluded',
        declarationKind: 'tools', declaration: { name: 'unavailable-tool' }, reachability: 'unknown' });
      expect(declarations[1]!.attrs).toMatchObject({ declarationKind: 'apiRoutes', declaration: false });
      expect(captured.surfaces.some(row => row.kind === 'configured-plugin-declaration')).toBe(false);
      const snapshot = await captureRuntimeSecurityCensus();
      expect(snapshot.rows.filter(row => row.kind === 'configured-plugin-declaration')).toEqual(
        expect.arrayContaining(declarations.map(row => expect.objectContaining({
          basis: 'declared-route', surfaceId: row.surfaceId,
        }))),
      );
      expect(snapshot).toMatchObject({ populationComplete: false, closureAccepted: false, executionAdmitted: false });
      expect(snapshot.unresolved).toContain('plugin-runtime-declaration-reconciliation-unverified');
    } finally { _resetPluginHostForTests(); }
  });

  it('connects the composed host to runtime discovery with full-set identity before paging', async () => {
    const captured = await captureOperatorHttpSecurityPopulation();
    const a = await readRuntimeSecurityCensus(1), b = await readRuntimeSecurityCensus(2);
    expect(a.status).toBe('captured');
    expect(a.total).toBe(captured.surfaces.length + captured.declaredSurfaces.length);
    expect(a.discoverySha256).toBe(b.discoverySha256);
    expect(a.rows).toHaveLength(1); expect(b.rows).toHaveLength(2);
    expect(a.truncatedByLimit).toBe(true);
    expect(a.populationComplete).toBe(false); expect(a.executionAdmitted).toBe(false);
    expect(captured.surfaces.some(s => s.kind === 'projected-handler')).toBe(true);
    expect(a.unresolved).toContain('security-population-not-closed:effect');
    expect(a.unresolved).toContain('plugin-runtime-configured-inputs-unverified');
    expect(a.unresolved).toContain('plugin-runtime-module-effects-unverified');
  });
  it('captures the actual outer host and delegated API stack without treating declarations as closure', async () => {
    const captured = await captureOperatorHttpSecurityPopulation();
    const mounts = new Set(captured.surfaces.filter(s => s.kind === 'mounted-http-handler').map(s => s.attrs?.mountId));
    expect([...mounts].sort()).toEqual(['operator-api', 'operator-host']);
    expect(captured.surfaces.some(s => s.attrs?.mountId === 'operator-host' && s.attrs?.routeId === 'ALL /api/*')).toBe(true);
    expect(captured.surfaces.some(s => s.attrs?.mountId === 'operator-api' && String(s.attrs?.path).endsWith('/health'))).toBe(true);
    expect(captured.surfaces.some(s => s.attrs?.mountId === 'operator-host' && !String(s.attrs?.path).startsWith('/api/'))).toBe(true);
    expect(captured.declaredSurfaces.length).toBeGreaterThan(0);
    expect(captured.unresolved).toEqual(expect.arrayContaining([
      'http-stack-nested-dispatch-unverified:operator-host',
      'http-stack-nested-dispatch-unverified:operator-api',
    ]));
    expect(captured.closureAccepted).toBe(false);
    expect((await captureOperatorHttpSecurityPopulation()).surfaces).toEqual(captured.surfaces);
  });

  it('preserves socket context so forged loopback Host headers cannot bypass remote auth', async () => {
    process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN = '1';
    process.env.PAPERCUSP_BIND_HOST = '0.0.0.0';
    process.env.PAPERCUSP_REMOTE_ORIGINS = 'https://app.example.com';

    const server = await startServer();
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not bind TCP');
    }

    const response = await getHealth(address.port);
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      error: {
        code: 'unauthorized',
        message: 'a verified remote operator session is required',
      },
    });
  });
});
