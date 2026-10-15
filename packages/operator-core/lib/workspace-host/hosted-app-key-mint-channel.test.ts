/**
 * The machine end of a portal MCP OAuth key mint (plan external-app-access-to-workspaces-2026-09-29
 * P-325, WI-10004189; D-021), driven through the REAL host adapter against a real loopback HTTP
 * server standing in for this machine's operator.
 *
 * The portal's broker opens `relay.open { kind: 'app-key-mint', audience: 'portal-oauth' }` and
 * sends ONE `mint.request`. The adapter must: call only the loopback mint route, WITHOUT the
 * ingress marker (the machine acting on its own connector) and without any principal header;
 * answer exactly once and close; refuse anything that is not a well-formed mint request; and abort
 * the call when the portal closes the channel. The same file pins the two relay-side facts the
 * portal flow depends on: neither relay plane can reach the mint route, and the portal's MCP 401
 * names the workspace's authorization-server metadata.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EXTERNAL_INGRESS_MARKER_HEADER } from '../auth/forwarded-request-trust';
import type { HostedConnectorBinding } from '../endpoint-route/hosted-workspace-connector';
import {
  AppRelayRateLimiter,
  InMemoryHostedAppRelayUsageStore,
  PORTAL_MINT_ROUTE_PATH,
  PORTAL_TOKEN_ROUTE_PATH,
  decideAppHttpRoute,
  handleHostedAppRelay,
  type HostedAppRelayDependencies,
} from './hosted-app-relay';
import { HOSTED_PRINCIPAL_SESSION_HEADER, HOSTED_PRINCIPAL_USER_HEADER, decideOperatorHttpRoute } from './hosted-operator-http';
import { HostedWorkspaceHostSessionAdapter, type HostedHostOutboundEnvelope } from './hosted-session-host';
import { HostedWorkspaceSessionBroker } from '../endpoint-route/hosted-workspace-session';

const APP_KEY = `pcapp_${'a'.repeat(16)}_${'s'.repeat(43)}`;
const REQUEST = { type: 'mint.request', requestId: 'r-1', label: 'Claude', scopes: { tools: ['plans:get'] }, approvedBy: 'portal:user-1' };

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

async function operator(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
      handler(req, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const json = (status: number, body: unknown) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function hostFor(origin: string) {
  const sent: HostedHostOutboundEnvelope[] = [];
  const adapter = new HostedWorkspaceHostSessionAdapter({
    binding,
    workspaceRoot: '/nonexistent-root',
    send: (message) => sent.push(message),
    operatorHttp: { origin },
  });
  const frames = (channelId = 'mint-1') =>
    sent
      .filter((m): m is Extract<HostedHostOutboundEnvelope, { type: 'relay' }> => m.type === 'relay' && m.channelId === channelId)
      .map((m) => m.payload as Record<string, unknown>);
  const closes = (channelId = 'mint-1') =>
    sent.filter((m) => m.type === 'relay.close' && m.channelId === channelId).map((m) => (m as { reason: string }).reason);
  const open = (extra: Record<string, unknown> = {}) =>
    adapter.accept({ type: 'relay.open', channelId: 'mint-1', kind: 'app-key-mint', audience: 'portal-oauth', ...extra });
  const relay = (payload: unknown, channelId = 'mint-1') => adapter.accept({ type: 'relay', channelId, payload });
  return { adapter, sent, frames, closes, open, relay };
}

describe('app-key-mint channel, machine end (P-325)', () => {
  it('mints through the loopback route as the machine itself, answers once, and closes', async () => {
    const op = await operator(json(201, { ok: true, key: APP_KEY, scopes: { capabilities: [], tools: ['plans:get'] } }));
    const host = hostFor(op.origin);
    await host.open();
    expect(host.frames()).toEqual([]); // no http.ready: this channel is not an HTTP pipe
    await host.relay(REQUEST);

    expect(op.seen).toHaveLength(1);
    const call = op.seen[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(PORTAL_MINT_ROUTE_PATH);
    expect(JSON.parse(call.body)).toEqual({ label: 'Claude', scopes: { tools: ['plans:get'] }, approvedBy: 'portal:user-1' });
    expect(call.headers[EXTERNAL_INGRESS_MARKER_HEADER]).toBeUndefined();
    expect(call.headers[HOSTED_PRINCIPAL_USER_HEADER]).toBeUndefined();
    expect(call.headers[HOSTED_PRINCIPAL_SESSION_HEADER]).toBeUndefined();
    expect(call.headers.authorization).toBeUndefined();

    expect(host.frames()).toEqual([
      { type: 'mint.issued', requestId: 'r-1', key: APP_KEY, scopes: { capabilities: [], tools: ['plans:get'] } },
    ]);
    expect(host.closes()).toEqual(['mint_complete']);
    // The channel is gone: a second request reaches nothing.
    await host.relay({ ...REQUEST, requestId: 'r-2' });
    expect(op.seen).toHaveLength(1);
  });

  it('passes the route refusal code back, e.g. a scope this machine will not grant', async () => {
    const op = await operator(json(400, { ok: false, error: { code: 'invalid_scope', problems: [] } }));
    const host = hostFor(op.origin);
    await host.open();
    await host.relay(REQUEST);
    expect(host.frames()).toEqual([{ type: 'mint.error', requestId: 'r-1', code: 'invalid_scope' }]);
    expect(host.closes()).toEqual(['mint_complete']);
  });

  it('refuses a malformed request without calling the operator', async () => {
    for (const bad of [
      { ...REQUEST, approvedBy: 'user-1' },
      { ...REQUEST, approvedBy: 'portal:a b' },
      { ...REQUEST, label: '  ' },
      { ...REQUEST, scopes: ['plans:get'] },
    ]) {
      const op = await operator(json(201, { ok: true, key: APP_KEY }));
      const host = hostFor(op.origin);
      await host.open();
      await host.relay(bad);
      expect(op.seen).toEqual([]);
      expect(host.frames()).toEqual([{ type: 'mint.error', requestId: 'r-1', code: 'invalid_request' }]);
    }
  });

  it('opens only for the portal-oauth audience, and carries nothing but mint.request', async () => {
    const op = await operator(json(201, { ok: true, key: APP_KEY }));
    const wrongAudience = hostFor(op.origin);
    await wrongAudience.open({ audience: 'app' });
    await wrongAudience.relay(REQUEST);
    expect(wrongAudience.frames()).toEqual([]);

    const host = hostFor(op.origin);
    await host.open();
    await host.relay({ type: 'http.request', requestId: 'h-1', method: 'POST', path: '/api/mcp' });
    await host.relay({ type: 'desktop.start', requestId: 'd-1' });
    expect(host.frames()).toEqual([
      { type: 'mint.error', requestId: 'h-1', code: 'channel_kind_mismatch' },
      { type: 'mint.error', requestId: 'd-1', code: 'channel_kind_mismatch' },
    ]);
    expect(op.seen).toEqual([]);

    // And an app-http channel never mints.
    await host.adapter.accept({ type: 'relay.open', channelId: 'app-1', kind: 'app-http', audience: 'app' });
    await host.relay(REQUEST, 'app-1');
    expect(op.seen).toEqual([]);
  });

  it('answers a second request on the same channel with a refusal, not a second key', async () => {
    let release: () => void = () => {};
    const op = await operator((req, res) => {
      release = () => json(201, { ok: true, key: APP_KEY })(req, res);
    });
    const host = hostFor(op.origin);
    await host.open();
    const first = host.relay(REQUEST);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await host.relay({ ...REQUEST, requestId: 'r-2' });
    release();
    await first;
    expect(op.seen).toHaveLength(1);
    expect(host.frames()).toEqual([
      { type: 'mint.error', requestId: 'r-2', code: 'mint_already_requested' },
      { type: 'mint.issued', requestId: 'r-1', key: APP_KEY, scopes: REQUEST.scopes },
    ]);
  });

  it('aborts the call when the portal closes the channel, and never delivers a key afterwards', async () => {
    let release: () => void = () => {};
    const op = await operator((req, res) => {
      release = () => json(201, { ok: true, key: APP_KEY })(req, res);
    });
    const host = hostFor(op.origin);
    await host.open();
    const inflight = host.relay(REQUEST);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await host.adapter.accept({ type: 'relay.close', channelId: 'mint-1', reason: 'mint_timeout' });
    release();
    await inflight;
    expect(host.frames()).toEqual([]);
  });
});

const ACCESS_TOKEN = `pcat_${'b'.repeat(16)}_${'t'.repeat(43)}`;
const AUDIENCE = 'https://app.papercusp.com/api/workspaces/workspace-1/oauth/token';
const TOKEN_REQUEST = {
  type: 'token.request',
  requestId: 't-1',
  fields: { grant_type: 'client_credentials', client_id: 'c'.repeat(16), client_secret: APP_KEY, scope: 'tool:plans:get' },
  basic: null,
  audience: AUDIENCE,
};

describe('app-key-mint channel carries one client-credentials token request (P-016, D-022)', () => {
  it('forwards it to the loopback token route as the machine itself, answers token.answer once, and closes', async () => {
    const issued = { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600, scope: 'tool:plans:get' };
    const op = await operator(json(200, { ok: true, status: 200, body: issued }));
    const host = hostFor(op.origin);
    await host.open();
    await host.relay({ ...TOKEN_REQUEST, fields: { ...TOKEN_REQUEST.fields, resource: 'https://evil.example' } });

    expect(op.seen).toHaveLength(1);
    const call = op.seen[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(PORTAL_TOKEN_ROUTE_PATH);
    // Only the grant's own fields cross: the extra `resource` is dropped here too.
    expect(JSON.parse(call.body)).toEqual({ fields: TOKEN_REQUEST.fields, basic: null, audience: AUDIENCE });
    expect(call.headers[EXTERNAL_INGRESS_MARKER_HEADER]).toBeUndefined();
    expect(call.headers[HOSTED_PRINCIPAL_USER_HEADER]).toBeUndefined();
    expect(call.headers.authorization).toBeUndefined();

    expect(host.frames()).toEqual([{ type: 'token.answer', requestId: 't-1', status: 200, body: issued }]);
    expect(host.closes()).toEqual(['mint_complete']);
    await host.relay({ ...TOKEN_REQUEST, requestId: 't-2' });
    expect(op.seen).toHaveLength(1);
  });

  it('passes an OAuth refusal back as the answer, with its status', async () => {
    const refusal = { error: 'invalid_client', error_description: 'client authentication failed' };
    const op = await operator(json(200, { ok: true, status: 401, body: refusal }));
    const host = hostFor(op.origin);
    await host.open();
    await host.relay({ ...TOKEN_REQUEST, basic: { id: 'c'.repeat(16), secret: APP_KEY }, fields: { grant_type: 'client_credentials' } });
    expect(JSON.parse(op.seen[0]!.body).basic).toEqual({ id: 'c'.repeat(16), secret: APP_KEY });
    expect(host.frames()).toEqual([{ type: 'token.answer', requestId: 't-1', status: 401, body: refusal }]);
  });

  it('never relays a long-lived key, or a non-OAuth answer, as a token', async () => {
    for (const answer of [
      { ok: true, status: 200, body: { access_token: APP_KEY, token_type: 'Bearer' } },
      { ok: true, status: 500, body: { error: 'server_error' } },
      { ok: true, status: 400, body: { note: 'no error field' } },
      { ok: false, error: { code: 'local_only' } },
    ]) {
      const op = await operator(json(200, answer));
      const host = hostFor(op.origin);
      await host.open();
      await host.relay(TOKEN_REQUEST);
      expect(host.frames()).toEqual([{ type: 'mint.error', requestId: 't-1', code: 'token_failed' }]);
    }
  });

  it('refuses a malformed token request without calling the operator', async () => {
    for (const bad of [
      { ...TOKEN_REQUEST, fields: 'grant_type=client_credentials' },
      { ...TOKEN_REQUEST, fields: { ...TOKEN_REQUEST.fields, client_assertion: 'x'.repeat(9000) } },
      { ...TOKEN_REQUEST, fields: { ...TOKEN_REQUEST.fields, scope: ['tool:plans:get'] } },
      { ...TOKEN_REQUEST, basic: { id: 'c'.repeat(16) } },
      { ...TOKEN_REQUEST, audience: '' },
    ]) {
      const op = await operator(json(200, { ok: true, status: 200, body: {} }));
      const host = hostFor(op.origin);
      await host.open();
      await host.relay(bad);
      expect(op.seen).toEqual([]);
      expect(host.frames()).toEqual([{ type: 'mint.error', requestId: 't-1', code: 'invalid_request' }]);
    }
  });

  it('refuses a mint answer that is a pcat_ token rather than a pcapp_ key', async () => {
    const op = await operator(json(201, { ok: true, key: ACCESS_TOKEN, scopes: {} }));
    const host = hostFor(op.origin);
    await host.open();
    await host.relay(REQUEST);
    expect(host.frames()).toEqual([{ type: 'mint.error', requestId: 'r-1', code: 'http_201' }]);
  });
});

describe('the mint and token routes are reachable from neither relay plane (P-325, P-016)', () => {
  it('refuses both on the app-http and operator-http allowlists', () => {
    for (const path of [PORTAL_MINT_ROUTE_PATH, PORTAL_TOKEN_ROUTE_PATH]) {
      expect(decideAppHttpRoute('POST', path).ok).toBe(false);
      expect(decideOperatorHttpRoute('POST', path).ok).toBe(false);
    }
  });
});

describe("the portal MCP 401 names the workspace's authorization server (P-325)", () => {
  // The relay classifies the server-authenticated connector before checking
  // the app key. Use the real empty broker; no machine is connected here.
  const deps: HostedAppRelayDependencies = {
    port: new HostedWorkspaceSessionBroker(),
    usage: new InMemoryHostedAppRelayUsageStore(),
    rate: new AppRelayRateLimiter(100),
    limits: { requestsPerMinute: 100, monthlyBandwidthBytes: 1024 * 1024 },
  };
  it('carries resource_metadata on /mcp, and a plain Bearer challenge on tool calls', async () => {
    const mcp = await handleHostedAppRelay(new Request('https://app.papercusp.com/api/workspaces/ws-1/mcp', { method: 'POST' }), deps);
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://app.papercusp.com/.well-known/oauth-protected-resource/api/workspaces/ws-1/mcp"',
    );
    const tools = await handleHostedAppRelay(
      new Request('https://app.papercusp.com/api/workspaces/ws-1/agent-tools/plans/get', { method: 'POST' }),
      deps,
    );
    expect(tools.status).toBe(401);
    expect(tools.headers.get('www-authenticate')).toBe('Bearer');
  });
});
