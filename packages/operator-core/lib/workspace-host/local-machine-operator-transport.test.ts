import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { createHostedCliRoutes } from '../endpoint-route/routes/hosted-cli';
import { createWorkspaceContextMiddleware } from '../workspace-context-middleware';
import { OperatorHttpChannel, HOSTED_PRINCIPAL_USER_HEADER } from './hosted-operator-http';
import { createLocalMachineOperatorTransport } from './local-machine-operator-transport';
import { readHostedWorkspaceConnector } from '../../../../apps/operator/app/cloud-workspaces/hosted-workspace-session-protocol';

it('uses current CLI authorization and single-use tickets to deliver two windows to two actual operator destinations', async () => {
  const seen: Array<{ machine: string; path: string; workspace: string; user: string; body: string }> = [];
  const servers: Server[] = [];
  const origins = new Map<string, string>();
  for (const machine of ['host-a', 'host-b']) {
    const server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8'); // boundary-safe decode (WI-6728)
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        seen.push({ machine, path: req.url!, workspace: String(req.headers['x-papercusp-workspace']),
          user: String(req.headers[HOSTED_PRINCIPAL_USER_HEADER]), body });
        expect(req.headers.authorization).toBeUndefined();
        expect(req.headers.cookie).toBeUndefined();
        expect(req.headers['x-papercusp-machine']).toBeUndefined();
        const stream = req.url!.includes('/sse');
        res.setHeader('content-type', stream ? 'text/event-stream' : 'application/json');
        res.end(stream ? `data: ${machine}\n\n` : JSON.stringify({ machine }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    origins.set(machine, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  }
  const token = `pct_${'a'.repeat(43)}`;
  const permissions = new Set(['workspace:view', 'workspace:operate']);
  let reachable = true;
  const tickets = new Map<string, { hostId: string; userId: string; hostedSessionId: string; customerWorkspaceId: string }>();
  let ticketCount = 0;
  const routes = createHostedCliRoutes({
    publicOrigin: 'https://cloud.example', controlPlaneWorkspaceId: 'control',
    store: {
      async resolveToken(hash: string) {
        return hash === createHash('sha256').update(token).digest('hex') ? {
          id: 'cli-1', userId: 'customer', organizationId: 'org-1', expiresAt: new Date(Date.now() + 60_000),
        } : null;
      },
      async listWorkspaces(org: string) {
        expect(org).toBe('org-1');
        return ['a', 'b'].map(id => ({ id: `ws-${id}`, hostId: `host-${id}`, displayName: `Machine ${id}`,
          state: 'active', connector: { state: 'active', transport: 'websocket',
            routeLabel: `route-${id}`, generation: 1, heartbeatAt: reachable ? new Date() : null } }));
      },
      async organizationName() { return 'Test organization'; },
    } as never,
    membershipAuthority: { async resolveActive() {
      return { permissions, userId: 'customer', organizationId: 'org-1', permissionVersion: 1 } as never;
    } },
    connectorGateway: { async issueSessionTicket(input: any) {
      const ticket = `ht_${String(++ticketCount).padStart(43, '0')}`;
      tickets.set(ticket, input);
      return { ticket, binding: { expiresAt: new Date(Date.now() + 60_000) } };
    } } as never,
    resolvePrincipal: async () => ({ ok: false, reason: 'session_cookie_missing' }) as never,
  });
  const broker = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => broker.once('listening', resolve));
  const brokerOrigin = `http://127.0.0.1:${(broker.address() as AddressInfo).port}`;
  broker.on('connection', (socket, request) => {
    const url = new URL(request.url!, brokerOrigin);
    const ticket = url.searchParams.get('ticket')!;
    const binding = tickets.get(ticket);
    tickets.delete(ticket);
    if (!binding || url.searchParams.get('kind') !== 'operator-http') { socket.close(4401); return; }
    const channel = new OperatorHttpChannel({
      origin: origins.get(binding.hostId)!, principal: { userId: binding.userId,
        hostedSessionId: binding.hostedSessionId, workspaceId: binding.customerWorkspaceId },
      audit: () => {}, send: frame => socket.send(JSON.stringify(frame)),
    });
    socket.on('message', data => {
      const frame = JSON.parse(data.toString());
      void channel.accept(frame.type, frame);
    });
    socket.on('close', () => channel.close());
    socket.send(JSON.stringify({ type: 'session.bound', kind: 'operator-http' }));
    socket.send(JSON.stringify({ type: 'http.ready' }));
  });
  const localHandler = vi.fn();
  const controlCalls: string[] = [];
  const transport = createLocalMachineOperatorTransport({
    readProfiles: () => [{ kind: 'papercusp-hosted', origin: brokerOrigin,
      accessToken: token, expiresAt: new Date(Date.now() + 60_000).toISOString() }],
    isLocalWorkspace: id => id === 'local-ws',
    readLocalControl: async () => [{ kind: 'workspace', id: 'local-host' }],
    fetch: async (input, init) => {
      const request = new Request(String(input), init);
      const path = new URL(request.url).pathname;
      controlCalls.push(path);
      const list = path === '/api/hosted/cli/workspaces';
      const route = routes.find(r => r.method === (list ? 'GET' : 'POST')
        && r.path === (list ? '/hosted/cli/workspaces' : '/hosted/cli/workspaces/:workspaceId/terminal'))!;
      const workspaceId = path.split('/').at(-2);
      return route.handler(request, { params: { workspaceId } } as never) as Promise<Response>;
    },
  });
  const app = new Hono();
  app.use('*', createWorkspaceContextMiddleware(transport));
  app.all('*', c => { localHandler(); return c.json({ machine: 'local' }); });
  try {
    const localInventory = await transport.mergeControlRows(new Request('http://localhost/api/zero-harness/rest-query'), []);
    expect(localInventory).toEqual([
      expect.objectContaining({ kind: 'workspace', id: 'host-a', name: 'Machine a', observedState: 'running' }),
      expect.objectContaining({ kind: 'workspace', id: 'host-b', name: 'Machine b', observedState: 'running' }),
    ]);
    expect(JSON.stringify(localInventory)).not.toContain(token);
    // Exercise the desktop's production reader: a selector entry alone does
    // not establish the connector route needed to open its viewer.
    expect(localInventory.map(row => readHostedWorkspaceConnector((row as { tunnel?: unknown }).tunnel)))
      .toEqual([{ routeLabel: 'route-a', transport: 'websocket' }, { routeLabel: 'route-b', transport: 'websocket' }]);
    expect(await transport.mergeControlRows(new Request('http://localhost/api', {
      headers: { origin: 'http://localhost:3055' },
    }), [])).toMatchObject([{ id: 'host-a', observedState: 'running' }, { id: 'host-b', observedState: 'running' }]);
    expect(await transport.mergeControlRows(new Request('http://localhost/api', {
      headers: { origin: 'http://localhost:9999' },
    }), [])).toEqual([]);
    const hostedRequest = new Request('http://localhost/api/zero-harness/rest-query', {
      headers: { [HOSTED_PRINCIPAL_USER_HEADER]: 'customer' },
    });
    const beforeHostedRead = controlCalls.length;
    expect(await transport.mergeControlRows(hostedRequest, [])).toEqual([]);
    expect(controlCalls).toHaveLength(beforeHostedRead);
    for (const id of ['a', 'b']) {
      const headers = { 'x-papercusp-machine': `host-${id}`, 'x-papercusp-workspace': 'local-ws',
        cookie: 'local-cookie', authorization: 'Bearer local-controller' };
      const registry = await app.request('/api/workspaces', { headers });
      expect(await registry.json()).toMatchObject({ current: `ws-${id}`, workspaces: [{ id: `ws-${id}` }] });
      const session = await app.request('/api/hosted/auth/session', { headers });
      expect(await session.json()).toEqual({ ok: true, session: { workspaceId: `ws-${id}` } });
      const ticketResponse = await app.request(`/api/hosted/workspaces/ws-${id}/connectors/session-ticket`, {
        method: 'POST', headers, body: JSON.stringify({ hostId: `host-${id}`, routeLabel: `route-${id}`,
          transport: 'websocket', audience: 'workspace-operator' }),
      });
      expect(await ticketResponse.json()).toMatchObject({ ok: true, socketOrigin: brokerOrigin, ticket: expect.stringMatching(/^ht_/) });
      const launched = await app.request('/api/adv/sessions/launch-su', {
        method: 'POST', headers, body: JSON.stringify({ agent: 'codex', harness: 'example' }),
      });
      expect(await launched.json()).toEqual({ machine: `host-${id}` });
      const stream = await app.request(`/api/zero-harness/sse?desktopHost=host-${id}&ws=ws-${id}`);
      expect(await stream.text()).toBe(`data: host-${id}\n\n`);
      const catalog = await app.request('/api/zero-harness/rest-query?name=workspaceHosts.control', { headers });
      expect((await catalog.json()).rows.map((row: { id: string }) => row.id))
        .toEqual(['local-host', 'host-a', 'host-b']);
    }
    expect(seen.map(row => [row.machine, row.workspace, row.user])).toEqual([
      ['host-a', 'ws-a', 'customer'], ['host-a', 'ws-a', 'customer'],
      ['host-b', 'ws-b', 'customer'], ['host-b', 'ws-b', 'customer'],
    ]);
    expect(seen.every(row => !row.path.includes('desktopHost'))).toBe(true);
    expect(seen[0].body).toContain('codex');
    expect(ticketCount).toBe(6);
    const count = seen.length;
    reachable = false;
    expect(await transport.mergeControlRows(new Request('http://localhost/api'), []))
      .toEqual([expect.objectContaining({ observedState: 'degraded' }), expect.objectContaining({ observedState: 'degraded' })]);
    expect((await app.request('/api/workspaces', { headers: { 'x-papercusp-machine': 'host-a' } })).status).toBe(503);
    reachable = true;
    permissions.clear();
    expect((await app.request('/api/adv/sessions/launch-su', {
      method: 'POST', headers: { 'x-papercusp-machine': 'host-a' },
    })).status).toBe(403);
    const controlCount = controlCalls.length;
    expect((await app.request('https://foreign.example/api/workspaces?desktopHost=host-a')).status).toBe(403);
    expect(controlCalls).toHaveLength(controlCount);
    expect(seen).toHaveLength(count);
    expect(localHandler).not.toHaveBeenCalled();
  } finally {
    for (const socket of broker.clients) socket.terminate();
    await new Promise<void>(resolve => broker.close(() => resolve()));
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});
