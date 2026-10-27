/**
 * The operator-http relay plane (D-418, WI-10002873). The route allowlist and header
 * filter are the authorization boundary for everything the relay reaches on the
 * workspace machine's loopback operator, so both are pinned directly; the adapter
 * cases run against a REAL loopback HTTP server so streaming and abort are measured,
 * not mocked.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideOperatorHttpRoute,
  HOSTED_OPERATOR_HTTP_MAX_REQUEST_BODY_BYTES,
  HOSTED_PRINCIPAL_SESSION_HEADER,
  HOSTED_PRINCIPAL_USER_HEADER,
  localOperatorOrigin,
  OperatorHttpChannel,
  operatorHttpRequestHeaders,
} from './hosted-operator-http';
import { HostedWorkspaceHostSessionAdapter, type HostedHostOutboundEnvelope,
  type HostedWorkspaceHostOptions, type HostedCustomerHttpRequestContext } from './hosted-session-host';
import type { HostedConnectorBinding } from '../endpoint-route/hosted-workspace-connector';

// These policy/adapter tests must stay runnable without the service registry.
// Registry-backed assertions live in hosted-operator-http-routes.test.ts.
vi.mock('../endpoint-route/routes', () => {
  throw new Error('Service registry imported by isolated operator-http tests; use the registry companion suite.');
});

describe('decideOperatorHttpRoute', () => {
  it.each([
    ['GET', '/api/health'],
    ['GET', '/api/zero-harness/rest-query?name=x&args=%7B%7D'],
    ['GET', '/api/zero-harness/sse'],
    ['GET', '/api/harness/portal/agent-chats?limit=50'],
    ['POST', '/api/harness/portal/agent-chats/chat-1/messages'],
    ['POST', '/api/harness/customer/insights/diagnostic-export'],
    ['POST', '/api/operator/conversations'],
    ['POST', '/api/operator/conversations/c1/turns'],
    ['POST', '/api/agent-mcp/operator-converse'],
    ['GET', '/api/adv/session/thinking?sessionId=s'],
    ['POST', '/api/adv/sessions/launch-su'],
    ['GET', '/api/agent-mcp/console/bootstrap-su/options?x=1'],
    ['post', '/api/admin/coord/send'],
    ['POST', '/api/adv/sessions/close-window'],
    // The Add-a-pot popup, as its forms call it (WI-10003268).
    ['POST', '/api/harness/projects'],
    ['POST', '/api/harness/pots'],
    ['POST', '/api/harness/pots/from-repo'],
    ['POST', '/api/harness/join-link'],
    ['POST', '/api/discovery/join-pot'],
    ['POST', '/api/discovery/join-invite'],
    ['GET', '/api/github/search-repos?q=papercusp'],
    ['GET', '/api/cupboard/listings?kind=blueprint&q=work'],
    ['GET', '/api/cupboard/bindings?repo_ids=1,2'],
    ['POST', '/api/cupboard/install-blueprint'],
    ['GET', '/api/discovery/pot-meta?slug=alpha'],
    ['POST', '/api/discovery/set-pot'],
    ['GET', '/api/flags/bootstrap'],
    // Native Settings pages must work through the same workspace connector as chat.
    ['GET', '/api/zero-harness/rest-query?name=consult.expertRouting&args=%7B%7D'],
    ['POST', '/api/agent-mcp/consult-expert-routing-set'],
    ['POST', '/api/admin/inbox/automation-policy'],
    ['GET', '/api/profile'],
    ['POST', '/api/profile'],
    ['GET', '/api/backups/healthcheck'],
    ['PUT', '/api/backups'],
    ['PUT', '/api/agent-mcp/operator-voice-prefs'],
    ['POST', '/api/agent-mcp/trust-set'],
    ['POST', '/api/agent-mcp/p2p-settings-set'],
    ['GET', '/api/plugins/config?harness=alpha&plugin=search'],
    ['PUT', '/api/plugins/config'],
    ['GET', '/api/user/jev-settings'],
    ['POST', '/api/user/jev-settings'],
    ['GET', '/api/pot/alpha/policy'],
    ['POST', '/api/pot/alpha/policy'],
  ])('relays the portal surface %s %s', (method, path) => {
    expect(decideOperatorHttpRoute(method, path)).toMatchObject({ ok: true });
  });

  it('marks slow writes as bounded by the route budget and leaves reads on the header budget', () => {
    expect(decideOperatorHttpRoute('POST', '/api/harness/pots')).toMatchObject({ ok: true, awaitsRouteBudget: true });
    expect(decideOperatorHttpRoute('GET', '/api/cupboard/listings?q=x')).toMatchObject({ ok: true, awaitsRouteBudget: false });
    expect(decideOperatorHttpRoute('POST', '/api/harness/portal/agent-chats')).toMatchObject({ ok: true, awaitsRouteBudget: false });
  });

  it.each([
    // Loopback admin surfaces outside the chat/session set (D-025).
    ['POST', '/api/workspace-hosts/provision'],
    ['POST', '/api/admin/plans/set-status'],
    ['GET', '/api/admin/inbox/automation-policy'],
    ['DELETE', '/api/admin/inbox/automation-policy'],
    ['POST', '/api/admin/inbox/triage'],
    ['POST', '/api/admin/inbox/automation-policy/extra'],
    ['POST', '/api/mcp'],
    ['GET', '/api/agent-config/secrets'],
    ['POST', '/api/health'],
    ['GET', '/api/health/private'],
    // Right path, wrong method.
    ['DELETE', '/api/harness/portal/agent-chats/chat-1'],
    ['GET', '/api/adv/sessions/launch-su'],
    // Pot surfaces the popup does not use stay closed.
    ['DELETE', '/api/harness/projects'],
    ['POST', '/api/harness/pots/from-repo/extra'],
    ['POST', '/api/flags/bootstrap'],
  ])('refuses %s %s as route_not_relayed', (method, path) => {
    expect(decideOperatorHttpRoute(method, path)).toEqual({ ok: false, code: 'route_not_relayed' });
  });

  it.each([
    'api/zero-harness/sse',
    '//evil.example/api/zero-harness/sse',
    'http://127.0.0.1:1/api/zero-harness/sse',
    '/api/harness/portal/agent-chats/../../workspace-hosts/provision',
    '/api/harness/portal%2F..%2F/agent-chats',
    '/api/zero-harness/sse#x',
    '/api/zero-harness\\sse',
  ])('refuses a path that could change the resolved route: %s', (path) => {
    expect(decideOperatorHttpRoute('GET', path)).toEqual({ ok: false, code: 'invalid_path' });
  });
});

describe('native Settings route coverage', () => {
  it('admits the HTTP calls the mounted Settings pages actually make', () => {
    const root = new URL('../../../../apps/operator/app/settings/', import.meta.url);
    const calls: Array<{ file: string; method: string; path: string }> = [];
    function urlOf(node: ts.Expression): string | null {
      if (ts.isStringLiteralLike(node)) return node.text;
      if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => 'example' + s.literal.text).join('');
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return urlOf(node.left);
      return null;
    }
    for (const file of readdirSync(root, { recursive: true }) as string[]) {
      if (!file.endsWith('.tsx') || file.includes('.test.')) continue;
      const src = ts.createSourceFile(file, readFileSync(new URL(file, root), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && ['fetch', 'postJson'].includes(node.expression.getText(src)) && node.arguments[0]) {
          let path = urlOf(node.arguments[0]);
          // plugin-runtime's optional origin prefix is empty in the web portal.
          if (path === 'example/api/plugins/runtime/status') path = '/api/plugins/runtime/status';
          if (path?.startsWith('/api/')) {
            let method = node.expression.getText(src) === 'postJson' ? 'POST' : 'GET';
            const options = node.arguments[1];
            if (options && ts.isObjectLiteralExpression(options)) {
              for (const prop of options.properties) {
                if (ts.isPropertyAssignment(prop) && prop.name.getText(src) === 'method' && ts.isStringLiteral(prop.initializer)) method = prop.initializer.text;
              }
            }
            calls.push({ file, method, path });
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(src);
    }
    // A failed crawl/parser must not turn coverage into a vacuous green.
    expect(calls).toContainEqual({ file: 'expert-routing/page.tsx', method: 'POST', path: '/api/agent-mcp/consult-expert-routing-set' });
    // These Settings calls belong to separate route planes, not operator-http:
    // customer data, browser authentication and connector revocation use hosted-runtime
    // routes, while device session grants and server-tool execution are loopback-only.
    // Keep each call outside the workspace operator relay.
    const intentionallyNotRelayed = [
      { file: 'profile/CustomerDataControls.tsx', method: 'POST', path: '/api/hosted/browser/data/example/export' },
      { file: 'profile/CustomerDataControls.tsx', method: 'POST', path: '/api/hosted/browser/data/example/delete' },
      { file: 'remote-access/page.tsx', method: 'POST', path: '/api/device/desktop/devices/example/agent-sessions' },
      { file: 'remote-access/page.tsx', method: 'GET', path: '/api/hosted/auth/session' },
      { file: 'remote-access/page.tsx', method: 'POST', path: '/api/hosted/auth/logout' },
      { file: 'remote-access/page.tsx', method: 'POST', path: '/api/hosted/workspaces/example/connectors/revoke' },
      { file: 'storage/page.tsx', method: 'POST', path: '/api/agent-mcp/run-tool' },
    ];
    const refused = calls.filter(({ method, path }) => !decideOperatorHttpRoute(method, path).ok);
    const sortCalls = (entries: typeof calls) =>
      [...entries].sort((a, b) => `${a.file}:${a.method}:${a.path}`.localeCompare(`${b.file}:${b.method}:${b.path}`));
    expect(sortCalls(refused), JSON.stringify(refused)).toEqual(sortCalls(intentionallyNotRelayed));
    for (const { method, path } of intentionallyNotRelayed) {
      expect(decideOperatorHttpRoute(method, path)).toEqual({ ok: false, code: 'route_not_relayed' });
    }
    // Coverage is for source calls, not an authority to admit arbitrary operations.
    expect(decideOperatorHttpRoute('DELETE', '/api/profile')).toEqual({ ok: false, code: 'route_not_relayed' });
    expect(decideOperatorHttpRoute('POST', '/api/admin/deploy-accounts/arbitrary-operation')).toEqual({ ok: false, code: 'route_not_relayed' });
  });
});

describe('operatorHttpRequestHeaders', () => {
  it('forwards only the allowlisted headers and stamps the channel principal over any claim', () => {
    const headers = operatorHttpRequestHeaders(
      {
        'Content-Type': 'application/json',
        'last-event-id': '42',
        'x-papercusp-workspace': 'customer-workspace-not-this-operators',
        authorization: 'Bearer hc_stolen',
        cookie: 'session=x',
        host: 'evil.example',
        'x-forwarded-for': '1.2.3.4',
        [HOSTED_PRINCIPAL_USER_HEADER]: 'someone-else',
        accept: 'text/event-stream\r\nx-injected: 1',
      },
      { userId: 'user-1', hostedSessionId: 'session-1' },
    );
    expect(headers).toEqual({
      'content-type': 'application/json',
      'last-event-id': '42',
      [HOSTED_PRINCIPAL_USER_HEADER]: 'user-1',
      [HOSTED_PRINCIPAL_SESSION_HEADER]: 'session-1',
    });
  });
});

describe('localOperatorOrigin', () => {
  it('is always loopback on the operator port', () => {
    expect(localOperatorOrigin({ PAPERCUSP_HONO_PORT: '3170' })).toBe('http://127.0.0.1:3170');
    expect(localOperatorOrigin({ PORT: '4000' })).toBe('http://127.0.0.1:4000');
    expect(localOperatorOrigin({})).toBe('http://127.0.0.1:3070');
    expect(localOperatorOrigin({ PAPERCUSP_HONO_PORT: 'evil.example' })).toBe('http://127.0.0.1:3070');
  });
});

// ── Adapter, against a real loopback server ─────────────────────────────────

const binding: HostedConnectorBinding = {
  controlPlaneWorkspaceId: 'control-1',
  organizationId: 'org-1',
  customerWorkspaceId: 'workspace-1',
  hostId: 'host-1',
  routeLabel: 'alpha',
  generation: 4,
  transport: 'websocket',
  state: 'active',
};

type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: string };
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function operator(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const entry = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() };
      seen.push(entry);
      handler(req, res, entry);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seen, origin };
}

function adapterFor(origin: string, httpOptions: HostedWorkspaceHostOptions['operatorHttp'] = {}) {
  const sent: HostedHostOutboundEnvelope[] = [];
  const audit: Array<{ action: string; userId?: string; detail?: string }> = [];
  const adapter = new HostedWorkspaceHostSessionAdapter({
    binding,
    workspaceRoot: '/nonexistent-root',
    send: (message) => sent.push(message),
    onAudit: (event) => audit.push(event),
    operatorHttp: { origin, ...httpOptions },
  });
  const payloads = (channelId = 'http-1') =>
    sent
      .filter((m): m is Extract<HostedHostOutboundEnvelope, { type: 'relay' }> => m.type === 'relay' && m.channelId === channelId)
      .map((m) => m.payload as Record<string, unknown>);
  const open = () => adapter.accept({
    type: 'relay.open',
    channelId: 'http-1',
    userId: 'user-1',
    hostedSessionId: 'session-1',
    audience: 'workspace-operator',
    role: 'controller',
    kind: 'operator-http',
  });
  const relay = (payload: unknown) => adapter.accept({ type: 'relay', channelId: 'http-1', payload });
  return { adapter, sent, audit, payloads, open, relay };
}

const decodeBody = (frames: Array<Record<string, unknown>>) =>
  frames.filter((f) => f.type === 'http.body').map((f) => Buffer.from(String(f.data), 'base64').toString()).join('');

describe('OperatorHttpChannel request ownership', () => {
  it('relays native owned-origin health to the operator without admitting health writes or subpaths', async () => {
    const { origin, seen } = await operator((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'papercusp-operator', sha: 'current-build' }));
    });
    const h = adapterFor(origin);
    await h.open();
    await h.relay({ type: 'http.request', requestId: 'native-health', method: 'GET', path: '/api/health' });
    expect(h.payloads()).toContainEqual({ type: 'http.response', requestId: 'native-health', status: 200,
      headers: { 'content-type': 'application/json' } });
    expect(JSON.parse(decodeBody(h.payloads()))).toEqual({ ok: true, service: 'papercusp-operator', sha: 'current-build' });
    expect(seen).toHaveLength(1);
    expect(seen[0].headers[HOSTED_PRINCIPAL_USER_HEADER]).toBe('user-1');
    for (const [requestId, method, path] of [
      ['health-write', 'POST', '/api/health'],
      ['health-subpath', 'GET', '/api/health/private'],
    ]) {
      await h.relay({ type: 'http.request', requestId, method, path });
      expect(h.payloads()).toContainEqual({ type: 'http.error', requestId, code: 'route_not_relayed', status: 403 });
    }
    expect(seen).toHaveLength(1);
    await h.adapter.accept({ type: 'relay.close', channelId: 'http-1', reason: 'test_complete' });
  });

  it('runs a private callback only after route/body validation with filtered headers', async () => {
    const frames: Record<string, unknown>[] = [];
    const seen: Request[] = [];
    const fallback = vi.fn(async () => new Response('loopback'));
    const channel = new OperatorHttpChannel({ principal: { userId: 'user-1', hostedSessionId: 'session-1' },
      send: frame => frames.push(frame), audit: () => {}, fetch: fallback,
      handleRequest: async request => { seen.push(request); return new Response(await request.text()); } });
    await channel.accept('http.request', { requestId: 'forbidden', method: 'POST', path: '/api/mcp' });
    expect(seen).toHaveLength(0);
    await channel.accept('http.request', { requestId: 'private', method: 'POST',
      path: '/api/harness/h/agent-chats/c/messages', body: Buffer.from('native').toString('base64'),
      headers: { authorization: 'stolen', cookie: 'stolen', [HOSTED_PRINCIPAL_USER_HEADER]: 'forged' } });
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.get('authorization')).toBeNull();
    expect(seen[0].headers.get('cookie')).toBeNull();
    expect(seen[0].headers.get(HOSTED_PRINCIPAL_USER_HEADER)).toBe('user-1');
    expect(seen[0].signal.aborted).toBe(true);
    expect(decodeBody(frames)).toBe('native');
    expect(fallback).not.toHaveBeenCalled();
    channel.close();
  });

  it('preserves ordinary forwarding when the private callback does not claim a route', async () => {
    const fetch = vi.fn(async () => new Response('ordinary'));
    const channel = new OperatorHttpChannel({ principal: { userId: 'user-1', hostedSessionId: 'session-1' },
      send: () => {}, audit: () => {}, fetch, handleRequest: async () => undefined });
    await channel.accept('http.request', { requestId: 'ordinary', method: 'GET', path: '/api/operator/conversations' });
    expect(fetch).toHaveBeenCalledTimes(1);
    channel.close();
  });

  it('settles an aborted private callback without fallback or late response publication', async () => {
    const frames: Record<string, unknown>[] = [];
    let finish!: (response: Response) => void;
    const fetch = vi.fn(async () => new Response('ambient'));
    const channel = new OperatorHttpChannel({ principal: { userId: 'user-1', hostedSessionId: 'session-1' },
      send: frame => frames.push(frame), audit: () => {}, fetch,
      handleRequest: () => new Promise<Response>(resolve => { finish = resolve; }) });
    const pending = channel.accept('http.request', { requestId: 'cancel', method: 'GET', path: '/api/operator/conversations' });
    await channel.accept('http.abort', { requestId: 'cancel' });
    await pending;
    finish(new Response('late'));
    await Promise.resolve(); await Promise.resolve();
    expect(frames).toEqual([]); expect(fetch).not.toHaveBeenCalled();
    channel.close();
  });

  it('does not publish a late response from an aborted request after its id is reused', async () => {
    const frames: Record<string, unknown>[] = [];
    const replies: Array<(response: Response) => void> = [];
    const channel = new OperatorHttpChannel({ principal: { userId: 'user-1', hostedSessionId: 'session-1' },
      send: frame => frames.push(frame), audit: () => {},
      fetch: () => new Promise<Response>(resolve => replies.push(resolve)) });
    const payload = { requestId: 'reused', method: 'GET', path: '/api/operator/conversations' };
    const old = channel.accept('http.request', payload);
    await channel.accept('http.abort', { requestId: 'reused' });
    const current = channel.accept('http.request', payload);
    replies[0](new Response('stale'));
    await old;
    expect(frames).toEqual([]);
    expect(channel.inflightCount).toBe(1);
    replies[1](new Response('current'));
    await current;
    expect(decodeBody(frames)).toBe('current');
    channel.close();
  });

  it('cancels a private response body even when its producer ignores the fetch signal', async () => {
    const cancel = vi.fn();
    const frames: Record<string, unknown>[] = [];
    const channel = new OperatorHttpChannel({ principal: { userId: 'user-1', hostedSessionId: 'session-1' },
      send: frame => frames.push(frame), audit: () => {},
      fetch: async () => new Response(new ReadableStream({ cancel })) });
    const pending = channel.accept('http.request', { requestId: 'stream', method: 'GET', path: '/api/operator/conversations' });
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'http.response')).toBe(true));
    await channel.accept('http.abort', { requestId: 'stream' });
    expect(cancel).toHaveBeenCalledTimes(1);
    await pending;
    expect(frames.some(frame => frame.type === 'http.end')).toBe(false);
    channel.close();
  });
});

describe('HostedWorkspaceHostSessionAdapter — operator-http channels (D-418)', () => {
  it('pins private callback authority to the exact request and original channel object', async () => {
    const contexts: HostedCustomerHttpRequestContext[] = [];
    const signals: AbortSignal[] = [];
    let finish!: (response: Response) => void;
    const { adapter, open, relay, payloads } = adapterFor('http://127.0.0.1:9', {
      handleRequest: (request, context) => {
        contexts.push(context);
        signals.push(context.sessionHost.customerInvocationSignal(context.channelId, request.signal));
        return new Promise<Response>(resolve => { finish = resolve; });
      },
    });
    await open();
    const old = relay({ type: 'http.request', requestId: 'old', method: 'GET', path: '/api/operator/conversations' });
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    expect(() => contexts[0].sessionHost.customerInvocationSignal('another-channel')).toThrow();
    await adapter.accept({ type: 'relay.close', channelId: 'http-1' });
    await old;
    expect(signals[0].aborted).toBe(true);
    await open();
    expect(() => contexts[0].sessionHost.customerInvocationSignal('http-1')).toThrow();
    expect(await contexts[0].sessionHost.resolveCustomerPrincipal('http-1')).toEqual({ ok: false });
    finish(new Response('late'));
    expect(payloads().some(frame => frame.type === 'http.response')).toBe(false);
    const current = relay({ type: 'http.request', requestId: 'new', method: 'GET', path: '/api/operator/conversations' });
    await vi.waitFor(() => expect(contexts).toHaveLength(2));
    expect(signals[1].aborted).toBe(false);
    finish(new Response('current'));
    await current;
    expect(signals[1].aborted).toBe(true);
    expect(await contexts[1].sessionHost.resolveCustomerPrincipal('http-1')).toEqual({ ok: false });
    adapter.close();
  });

  it('relays the exact Autonomy save and preserves its ticket principal', async () => {
    const policy = { op: 'set', level: 'L1', minimumConfidence: 'high' };
    const { seen, origin } = await operator((_req, res, entry) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, policy: JSON.parse(entry.body) }));
    });
    const h = adapterFor(origin);
    await h.open();
    await h.relay({ type: 'http.request', requestId: 'autonomy-save', method: 'POST',
      path: '/api/admin/inbox/automation-policy',
      headers: { 'content-type': 'application/json', [HOSTED_PRINCIPAL_USER_HEADER]: 'forged-user',
        'x-papercusp-workspace': 'forged-workspace', authorization: 'Bearer forged' },
      body: Buffer.from(JSON.stringify(policy)).toString('base64') });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/admin/inbox/automation-policy' });
    expect(seen[0].headers[HOSTED_PRINCIPAL_USER_HEADER]).toBe('user-1');
    expect(seen[0].headers['x-papercusp-workspace']).toBe(binding.customerWorkspaceId);
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(JSON.parse(decodeBody(h.payloads().filter(f => f.requestId === 'autonomy-save'))))
      .toEqual({ ok: true, policy });
    await h.adapter.accept({ type: 'relay.close', channelId: 'http-1', reason: 'test_complete' });
  });

  it('saves and rereads Expert Routing on the selected machine under the ticket principal', async () => {
    let halfLife = 14;
    const { seen, origin } = await operator((req, res, entry) => {
      if (req.method === 'POST' && req.url === '/api/agent-mcp/consult-expert-routing-set') {
        halfLife = JSON.parse(entry.body).recencyHalfLifeDays;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ rows: [{ recencyHalfLifeDays: halfLife }] }));
      }
    });
    const h = adapterFor(origin);
    await h.open();
    await h.relay({ type: 'http.request', requestId: 'settings-save', method: 'POST',
      path: '/api/agent-mcp/consult-expert-routing-set',
      headers: { 'content-type': 'application/json', cookie: 'must-not-forward' },
      body: Buffer.from(JSON.stringify({ recencyHalfLifeDays: 21 })).toString('base64') });
    await h.relay({ type: 'http.request', requestId: 'settings-read', method: 'GET',
      path: '/api/zero-harness/rest-query?name=consult.expertRouting&args=%7B%7D' });
    expect(seen.map(({ method }) => method)).toEqual(['POST', 'GET']);
    expect(JSON.parse(decodeBody(h.payloads().filter((f) => f.requestId === 'settings-read'))))
      .toEqual({ rows: [{ recencyHalfLifeDays: 21 }] });
    for (const request of seen) {
      expect(request.headers[HOSTED_PRINCIPAL_USER_HEADER]).toBe('user-1');
      expect(request.headers.cookie).toBeUndefined();
    }
    await h.adapter.accept({ type: 'relay.close', channelId: 'http-1', reason: 'test_complete' });
  });

  it('forwards an allowlisted POST to the loopback operator as the ticket principal and relays the response', async () => {
    const { seen, origin } = await operator((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json', 'set-cookie': 'leak=1' });
      res.end(JSON.stringify({ ok: true, chat: { id: 'c1' } }));
    });
    const h = adapterFor(origin);
    await h.open();
    expect(h.payloads()[0]).toEqual({ type: 'http.ready' });
    await h.relay({
      type: 'http.request',
      requestId: 'r1',
      method: 'POST',
      path: '/api/harness/portal/agent-chats',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: Buffer.from('{"role":"papercup"}').toString('base64'),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/harness/portal/agent-chats', body: '{"role":"papercup"}' });
    expect(seen[0]!.headers[HOSTED_PRINCIPAL_USER_HEADER]).toBe('user-1');
    expect(seen[0]!.headers.authorization).toBeUndefined();
    const frames = h.payloads();
    expect(frames).toContainEqual({ type: 'http.response', requestId: 'r1', status: 201, headers: { 'content-type': 'application/json' } });
    expect(decodeBody(frames)).toBe('{"ok":true,"chat":{"id":"c1"}}');
    expect(frames.at(-1)).toEqual({ type: 'http.end', requestId: 'r1' });
    expect(h.audit).toContainEqual(expect.objectContaining({ action: 'operator_http_request', userId: 'user-1', detail: 'POST /api/harness/portal/agent-chats 201' }));
  });

  it('refuses a non-allowlisted route without making any request', async () => {
    const { seen, origin } = await operator((_req, res) => res.end('should not be reached'));
    const h = adapterFor(origin);
    await h.open();
    await h.relay({ type: 'http.request', requestId: 'r1', method: 'POST', path: '/api/workspace-hosts/provision' });
    expect(seen).toEqual([]);
    expect(h.payloads()).toContainEqual({ type: 'http.error', requestId: 'r1', code: 'route_not_relayed', status: 403 });
    expect(h.audit).toContainEqual(expect.objectContaining({ action: 'operator_http_denied' }));
  });

  it('refuses an oversized body with 413 rather than truncating it', async () => {
    const { seen, origin } = await operator((_req, res) => res.end());
    const h = adapterFor(origin);
    await h.open();
    const body = Buffer.alloc(HOSTED_OPERATOR_HTTP_MAX_REQUEST_BODY_BYTES + 1).toString('base64');
    await h.relay({ type: 'http.request', requestId: 'r1', method: 'POST', path: '/api/admin/coord/send', body });
    expect(seen).toEqual([]);
    expect(h.payloads()).toContainEqual({ type: 'http.error', requestId: 'r1', code: 'request_body_too_large', status: 413 });
  });

  it('streams an SSE body as it arrives, and a client abort tears the upstream stream down', async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => { upstreamClosed = resolve; });
    const { origin } = await operator((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      req.socket.on('close', () => upstreamClosed());
    });
    const h = adapterFor(origin);
    await h.open();
    const pending = h.relay({ type: 'http.request', requestId: 's1', method: 'GET', path: '/api/zero-harness/sse' });
    await expect.poll(() => decodeBody(h.payloads())).toBe('data: one\n\n');
    expect(h.payloads()).toContainEqual({ type: 'http.response', requestId: 's1', status: 200, headers: { 'content-type': 'text/event-stream' } });

    await h.relay({ type: 'http.abort', requestId: 's1' });
    await pending;
    await closed;
    // The client asked; no error and no end frame are owed.
    expect(h.payloads().filter((f) => f.type === 'http.error' || f.type === 'http.end')).toEqual([]);
  });

  it('detaching the channel aborts its in-flight streams', async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => { upstreamClosed = resolve; });
    const { origin } = await operator((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': open\n\n');
      req.socket.on('close', () => upstreamClosed());
    });
    const h = adapterFor(origin);
    await h.open();
    const pending = h.relay({ type: 'http.request', requestId: 's1', method: 'GET', path: '/api/adv/session/thinking?x=1' });
    await expect.poll(() => decodeBody(h.payloads())).toBe(': open\n\n');
    await h.adapter.accept({ type: 'relay.close', channelId: 'http-1', reason: 'browser_disconnected' });
    await pending;
    await closed;
    expect(h.audit).toContainEqual(expect.objectContaining({ action: 'operator_http_detached' }));
  });

  it('lets a slow create answer past the header budget but still cuts a slow read (WI-10003268)', async () => {
    const { origin } = await operator((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }, 150);
    });
    const sent: Array<Record<string, unknown>> = [];
    const channel = new OperatorHttpChannel({
      principal: { userId: 'user-1', hostedSessionId: 'session-1' },
      send: (payload) => sent.push(payload),
      audit: () => {},
      origin,
      headerTimeoutMs: 50,
    });
    await channel.accept('http.request', {
      requestId: 'create', method: 'POST', path: '/api/harness/pots', body: Buffer.from('{}').toString('base64'),
    });
    await channel.accept('http.request', { requestId: 'read', method: 'GET', path: '/api/cupboard/listings?q=work' });

    expect(sent).toContainEqual({ type: 'http.response', requestId: 'create', status: 200, headers: { 'content-type': 'application/json' } });
    expect(sent).toContainEqual({ type: 'http.end', requestId: 'create' });
    expect(sent).toContainEqual({ type: 'http.error', requestId: 'read', code: 'operator_timeout', status: 504 });
  });

  it.each(['link-start', 'link-complete'])('preserves the provider response for slow account %s', async (operation) => {
    const { origin } = await operator((_req, res) => {
      setTimeout(() => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"ok":false,"error":"provider login failed"}');
      }, 100);
    });
    const sent: Array<Record<string, unknown>> = [];
    const channel = new OperatorHttpChannel({
      principal: { userId: 'user-1', hostedSessionId: 'session-1' },
      send: (payload) => sent.push(payload),
      audit: () => {},
      origin,
      headerTimeoutMs: 20,
    });
    await channel.accept('http.request', {
      requestId: operation, method: 'POST', path: `/api/admin/deploy-accounts/${operation}`,
      body: Buffer.from('{}').toString('base64'),
    });
    expect(sent).toContainEqual({ type: 'http.response', requestId: operation, status: 400, headers: { 'content-type': 'application/json' } });
    expect(decodeBody(sent)).toBe('{"ok":false,"error":"provider login failed"}');
    expect(sent).toContainEqual({ type: 'http.end', requestId: operation });
    expect(sent.some((frame) => frame.type === 'http.error')).toBe(false);
    channel.close();
  });

  it('answers 502 when the loopback operator is down', async () => {
    const h = adapterFor('http://127.0.0.1:1');
    await h.open();
    await h.relay({ type: 'http.request', requestId: 'r1', method: 'GET', path: '/api/agent-config' });
    expect(h.payloads()).toContainEqual({ type: 'http.error', requestId: 'r1', code: 'operator_unreachable', status: 502 });
  });

  it('never runs host-level desktop operations or PTY frames on an operator-http channel', async () => {
    const { origin } = await operator((_req, res) => res.end());
    const h = adapterFor(origin);
    await h.open();
    await h.relay({ type: 'desktop.start', requestId: 'd1' });
    await h.relay({ type: 'pty.input', data: 'aGk=' });
    expect(h.payloads()).toContainEqual({ type: 'http.error', code: 'channel_kind_mismatch', requestType: 'desktop.start' });
    expect(h.payloads()).toContainEqual({ type: 'http.error', code: 'channel_kind_mismatch', requestType: 'pty.input' });
    expect(h.payloads().some((f) => f.type === 'desktop.start.result' || f.type === 'pty.ready')).toBe(false);
  });

  it('refuses an unknown channel kind instead of opening a terminal', async () => {
    const { origin } = await operator((_req, res) => res.end());
    const h = adapterFor(origin);
    await h.adapter.accept({
      type: 'relay.open', channelId: 'x', userId: 'u', hostedSessionId: 's', audience: 'workspace-operator', role: 'controller', kind: 'operator-admin',
    });
    // The host answers an unknown kind with a close the client can act on (it falls back), and
    // never opens anything for it (D-002, P-006).
    expect(h.sent).toEqual([{ type: 'relay.close', channelId: 'x', reason: 'channel_kind_unknown' }]);
  });
});
