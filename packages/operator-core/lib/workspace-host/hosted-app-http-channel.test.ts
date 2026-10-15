/**
 * The machine end of an outside app's call (plan external-app-access-to-workspaces-2026-09-29
 * P-007, WI-10004018), driven through the REAL host adapter: the portal's broker opens it as
 * `relay.open { kind: 'app-http', audience: 'app' }`, and HostedWorkspaceHostSessionAdapter must
 * build it with the APP plane's policy, not operator-http's — no ticket principal (even one a
 * frame claims), the app key as the only credential, and the deny-only ingress marker so the
 * operator never grants the call loopback trust (R-7, D-015). Runs against a real loopback HTTP
 * server, so the forwarded headers are what the operator actually receives.
 *
 * hosted-app-relay.test.ts covers the portal half and the channel factory in isolation; this file
 * pins the adapter's `open()` wiring, which that file's fake machine bypasses.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EXTERNAL_INGRESS_MARKER_HEADER } from '../auth/forwarded-request-trust';
import type { HostedConnectorBinding } from '../endpoint-route/hosted-workspace-connector';
import { APP_RELAY_INGRESS_MARKER } from './hosted-app-relay';
import { HOSTED_PRINCIPAL_SESSION_HEADER, HOSTED_PRINCIPAL_USER_HEADER } from './hosted-operator-http';
import {
  HostedWorkspaceHostSessionAdapter,
  LOCAL_RELAY_CHANNEL_KINDS,
  type HostedHostOutboundEnvelope,
} from './hosted-session-host';

const APP_KEY = `pcapp_${'a'.repeat(16)}_${'s'.repeat(43)}`;

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

function hostFor(origin: string) {
  const sent: HostedHostOutboundEnvelope[] = [];
  const audit: Array<{ action: string; userId?: string; detail?: string }> = [];
  const adapter = new HostedWorkspaceHostSessionAdapter({
    binding,
    workspaceRoot: '/nonexistent-root',
    send: (message) => sent.push(message),
    onAudit: (event) => audit.push(event),
    operatorHttp: { origin },
  });
  const payloads = (channelId = 'app-1') =>
    sent
      .filter((m): m is Extract<HostedHostOutboundEnvelope, { type: 'relay' }> => m.type === 'relay' && m.channelId === channelId)
      .map((m) => m.payload as Record<string, unknown>);
  const open = (extra: Record<string, unknown> = {}) =>
    adapter.accept({ type: 'relay.open', channelId: 'app-1', kind: 'app-http', audience: 'app', role: 'controller', ...extra });
  const relay = (payload: unknown) => adapter.accept({ type: 'relay', channelId: 'app-1', payload });
  return { adapter, sent, audit, payloads, open, relay };
}

const decodeBody = (frames: Array<Record<string, unknown>>) =>
  frames.filter((f) => f.type === 'http.body').map((f) => Buffer.from(String(f.data), 'base64').toString()).join('');

describe('HostedWorkspaceHostSessionAdapter — app-http channels (P-007)', () => {
  it('forwards an app tool call with the app key and the ingress marker, and drops any ticket principal', async () => {
    const { seen, origin } = await operator((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'leak=1' });
      res.end('{"ok":true}');
    });
    const h = hostFor(origin);
    // A frame that also claims an owner's ticket identity: the app plane binds none.
    await h.open({ userId: 'owner-1', hostedSessionId: 'owner-session' });
    expect(h.payloads()[0]).toEqual({ type: 'http.ready' });
    await h.relay({
      type: 'http.request',
      requestId: 'r1',
      method: 'POST',
      path: '/api/agent-tools/plans/list',
      headers: {
        authorization: `Bearer ${APP_KEY}`,
        cookie: 'papercusp_session=owner',
        'content-type': 'application/json',
        [HOSTED_PRINCIPAL_USER_HEADER]: 'owner-1',
        'x-forwarded-for': '203.0.113.9',
        [EXTERNAL_INGRESS_MARKER_HEADER]: 'spoofed',
      },
      body: Buffer.from('{}').toString('base64'),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/agent-tools/plans/list', body: '{}' });
    const headers = seen[0]!.headers;
    expect(headers.authorization).toBe(`Bearer ${APP_KEY}`);
    expect(headers[EXTERNAL_INGRESS_MARKER_HEADER]).toBe(APP_RELAY_INGRESS_MARKER);
    expect(headers[HOSTED_PRINCIPAL_USER_HEADER]).toBeUndefined();
    expect(headers[HOSTED_PRINCIPAL_SESSION_HEADER]).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers['x-forwarded-for']).toBeUndefined();
    const frames = h.payloads();
    expect(frames).toContainEqual({ type: 'http.response', requestId: 'r1', status: 200, headers: { 'content-type': 'application/json' } });
    expect(decodeBody(frames)).toBe('{"ok":true}');
    expect(h.audit).toContainEqual(expect.objectContaining({ action: 'app_http_attached', userId: 'app-relay' }));
    expect(h.audit).toContainEqual(expect.objectContaining({ action: 'app_http_request', userId: 'app-relay' }));
    expect(h.audit.some((e) => e.action.startsWith('operator_http_') || e.userId === 'owner-1')).toBe(false);
  });

  it('never forwards an owner or admin ticket as the credential', async () => {
    const { seen, origin } = await operator((_req, res) => res.end('{}'));
    const h = hostFor(origin);
    await h.open();
    await h.relay({
      type: 'http.request', requestId: 'r1', method: 'POST', path: '/api/mcp',
      headers: { authorization: 'Bearer owner-ticket-jwt', 'content-type': 'application/json' },
      body: Buffer.from('{}').toString('base64'),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.headers[EXTERNAL_INGRESS_MARKER_HEADER]).toBe(APP_RELAY_INGRESS_MARKER);
  });

  it('refuses an operator route the owner plane allows, without making any request', async () => {
    const { seen, origin } = await operator((_req, res) => res.end('should not be reached'));
    const h = hostFor(origin);
    await h.open();
    await h.relay({ type: 'http.request', requestId: 'r1', method: 'POST', path: '/api/harness/portal/agent-chats' });
    expect(seen).toEqual([]);
    expect(h.payloads()).toContainEqual({ type: 'http.error', requestId: 'r1', code: 'route_not_relayed', status: 403 });
    expect(h.audit).toContainEqual(expect.objectContaining({ action: 'app_http_denied' }));
  });

  it('opens nothing for an app-http frame without the app audience or a channel id', async () => {
    const { origin } = await operator((_req, res) => res.end());
    const h = hostFor(origin);
    await h.open({ audience: 'workspace-operator' });
    await h.adapter.accept({ type: 'relay.open', kind: 'app-http', audience: 'app', role: 'controller' });
    expect(h.sent).toEqual([]);
  });

  it('refuses a second open of a live app channel', async () => {
    const { origin } = await operator((_req, res) => res.end());
    const h = hostFor(origin);
    await h.open();
    await h.open();
    expect(h.sent).toContainEqual({ type: 'relay.close', channelId: 'app-1', reason: 'channel_already_open' });
  });
});

describe('HostedWorkspaceHostSessionAdapter — relay usage on app-http opens (P-328)', () => {
  const usage = { month: '2026-09-01', bytes: 900, limitBytes: 1000 };

  function hostWithUsage(onRelayUsage: (value: unknown) => void, onWarning?: (message: string) => void) {
    const sent: HostedHostOutboundEnvelope[] = [];
    const adapter = new HostedWorkspaceHostSessionAdapter({
      binding,
      workspaceRoot: '/nonexistent-root',
      send: (message) => sent.push(message),
      operatorHttp: { origin: 'http://127.0.0.1:9' },
      onRelayUsage,
      ...(onWarning ? { onWarning } : {}),
    });
    return { adapter, sent };
  }

  it("hands the portal's usage report to onRelayUsage once the channel is attached", async () => {
    const reports: unknown[] = [];
    const h = hostWithUsage((value) => reports.push(value));
    await h.adapter.accept({ type: 'relay.open', channelId: 'app-1', kind: 'app-http', audience: 'app', role: 'controller', relayUsage: usage });
    expect(reports).toEqual([usage]);
    expect(h.sent).toContainEqual({ type: 'relay', channelId: 'app-1', payload: { type: 'http.ready' } });
  });

  it('does not call onRelayUsage for an open without a report, or for a refused open', async () => {
    const reports: unknown[] = [];
    const h = hostWithUsage((value) => reports.push(value));
    await h.adapter.accept({ type: 'relay.open', channelId: 'app-1', kind: 'app-http', audience: 'app', role: 'controller' });
    await h.adapter.accept({ type: 'relay.open', channelId: 'app-2', kind: 'app-http', audience: 'workspace-operator', role: 'controller', relayUsage: usage });
    expect(reports).toEqual([]);
  });

  it('keeps the channel open when the usage sink throws, and reports it as a warning', async () => {
    const warnings: string[] = [];
    const h = hostWithUsage(() => { throw new Error('sink down'); }, (message) => warnings.push(message));
    await h.adapter.accept({ type: 'relay.open', channelId: 'app-1', kind: 'app-http', audience: 'app', role: 'controller', relayUsage: usage });
    expect(h.sent).toContainEqual({ type: 'relay', channelId: 'app-1', payload: { type: 'http.ready' } });
    expect(warnings).toEqual(['relay_usage_report_failed']);
  });
});

// EAA P-008 (D-031 #7): a relay-linked home computer serves outside apps only. The portal must
// never get a terminal, the screen or loopback-trusted operator access through its connector.
describe('HostedWorkspaceHostSessionAdapter — local relay channel allowlist (P-008)', () => {
  function localHost() {
    const sent: HostedHostOutboundEnvelope[] = [];
    const warnings: string[] = [];
    const createdPtys: unknown[] = [];
    const adapter = new HostedWorkspaceHostSessionAdapter({
      binding,
      workspaceRoot: '/nonexistent-root',
      send: (message) => sent.push(message),
      operatorHttp: { origin: 'http://127.0.0.1:9' },
      allowedChannelKinds: LOCAL_RELAY_CHANNEL_KINDS,
      onWarning: (message) => warnings.push(message),
      createPty: (input) => {
        createdPtys.push(input);
        throw new Error('a local relay must never start a terminal');
      },
    });
    return { adapter, sent, warnings, createdPtys };
  }
  const ticketOpen = { userId: 'user-1', hostedSessionId: 'hs-1', audience: 'workspace-operator', role: 'controller' };

  it('refuses pty (explicit and absent kind), desktop and operator-http opens with a close frame', async () => {
    const h = localHost();
    await h.adapter.accept({ type: 'relay.open', channelId: 'c-pty', kind: 'pty', ...ticketOpen });
    await h.adapter.accept({ type: 'relay.open', channelId: 'c-default', ...ticketOpen });
    await h.adapter.accept({ type: 'relay.open', channelId: 'c-desk', kind: 'desktop', desktopSessionId: 'd-1', ...ticketOpen });
    await h.adapter.accept({ type: 'relay.open', channelId: 'c-http', kind: 'operator-http', ...ticketOpen });
    expect(h.sent).toEqual(['c-pty', 'c-default', 'c-desk', 'c-http'].map((channelId) => ({
      type: 'relay.close', channelId, reason: 'channel_kind_not_allowed',
    })));
    expect(h.createdPtys).toHaveLength(0);
    expect(h.warnings).toHaveLength(4);
    // Nothing was opened, so a later frame on a refused channel reaches nothing.
    await h.adapter.accept({ type: 'relay', channelId: 'c-http', payload: { type: 'http.request', requestId: 'r1', method: 'GET', path: '/api/health', headers: {} } });
    expect(h.sent).toHaveLength(4);
  });

  it('still serves app-http and app-key-mint', async () => {
    const h = localHost();
    await h.adapter.accept({ type: 'relay.open', channelId: 'app-1', kind: 'app-http', audience: 'app', role: 'controller' });
    expect(h.sent).toEqual([{ type: 'relay', channelId: 'app-1', payload: { type: 'http.ready' } }]);
    await h.adapter.accept({ type: 'relay.open', channelId: 'mint-1', kind: 'app-key-mint', audience: 'portal-oauth', role: 'controller' });
    expect(h.sent.some((m) => m.type === 'relay.close' && m.channelId === 'mint-1')).toBe(false);
    expect(h.warnings).toEqual([]);
  });

  it('serves every kind when no allowlist is set (a Papercusp-hosted machine)', async () => {
    const sent: HostedHostOutboundEnvelope[] = [];
    const adapter = new HostedWorkspaceHostSessionAdapter({
      binding, workspaceRoot: '/nonexistent-root', send: (message) => sent.push(message), operatorHttp: { origin: 'http://127.0.0.1:9' },
    });
    await adapter.accept({ type: 'relay.open', channelId: 'c-http', kind: 'operator-http', ...ticketOpen });
    expect(sent.some((m) => m.type === 'relay.close' && m.channelId === 'c-http')).toBe(false);
  });
});
