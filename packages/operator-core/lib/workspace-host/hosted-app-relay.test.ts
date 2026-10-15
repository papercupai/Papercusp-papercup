/**
 * Portal app relay (plan external-app-access-to-workspaces-2026-09-29 P-007,
 * WI-10004018): R-16, R-17, R-18, R-19, R-38, R-39.
 *
 * Every relay component is the production one — the portal handler, the connector
 * broker, and the machine's `app-http` channel built by `createAppHttpChannel` (the
 * same factory the workspace host adapter calls). Only the machine's own operator is
 * a stand-in `fetch`, so a test sees exactly what would reach it.
 *
 * Copy-out mutation seam: `PAPERCUSP_APP_RELAY_PROBE={}` points this file at a
 * mutated copy of hosted-app-relay.ts (scripts/mutation-probe.sh).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostedWorkspaceSessionBroker, type HostedWorkspaceRelaySocket } from '../endpoint-route/hosted-workspace-session';
import type { HostedConnectorBinding } from '../endpoint-route/hosted-workspace-connector';
import {
  AppRelayRateLimiter,
  InMemoryHostedAppRelayUsageStore,
  appHttpRequestHeaders,
  appRelayMonth,
  createAppHttpChannel,
  decideAppHttpRoute,
  handleHostedAppRelay,
  type AppRelayLimits,
  type HostedAppRelayAuditEvent,
  type HostedAppRelayDependencies,
} from './hosted-app-relay';
import type { OperatorHttpChannel } from './hosted-operator-http';

vi.mock('./hosted-app-relay', async (importOriginal) => {
  const probe = process.env.PAPERCUSP_APP_RELAY_PROBE;
  return probe ? await import(/* @vite-ignore */ probe) : await importOriginal();
});

const APP_KEY = `pcapp_${'a'.repeat(16)}_${'s'.repeat(43)}`;
const OWNER_TICKET = `ht_${'o'.repeat(43)}`;
const BODY_MARKER = 'SECRET-BODY-MARKER-7f3a';
const HEADER_MARKER = 'secret-header-marker-19c2';

const BINDING: HostedConnectorBinding = {
  controlPlaneWorkspaceId: 'cp-1',
  organizationId: 'org-1',
  customerWorkspaceId: 'ws-1',
  hostId: 'host-1',
  routeLabel: 'route-1',
  generation: 1,
  transport: 'websocket',
  state: 'active',
};

/** A connector socket whose far end is the machine's real `app-http` channel. */
class MachineConnector implements HostedWorkspaceRelaySocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly frames: Array<Record<string, unknown>> = [];
  // `never[]` so the interface's overloaded listeners (message: (data, isBinary); close/pong: ())
  // are both assignable here; `emit` widens once at the call site.
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();
  private readonly channels = new Map<string, OperatorHttpChannel>();

  constructor(private readonly machineFetch: (url: string, init: RequestInit) => Promise<Response>) {}

  on(event: string, listener: (...args: never[]) => void): unknown {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as (...a: unknown[]) => void)(...args);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  send(data: string | Buffer): void {
    const frame = JSON.parse(String(data)) as Record<string, unknown>;
    this.frames.push(frame);
    const channelId = String(frame.channelId ?? '');
    if (frame.type === 'relay.open' && frame.kind === 'app-http') {
      this.channels.set(channelId, createAppHttpChannel({
        origin: 'http://machine.test',
        fetch: this.machineFetch,
        audit: () => {},
        send: (payload) => this.emit('message', JSON.stringify({ type: 'relay', channelId, payload }), false),
      }));
    } else if (frame.type === 'relay') {
      const payload = frame.payload as Record<string, unknown>;
      void this.channels.get(channelId)?.accept(String(payload.type), payload);
    } else if (frame.type === 'relay.close') {
      this.channels.get(channelId)?.close();
      this.channels.delete(channelId);
    }
  }

  opened(): number {
    return this.frames.filter((frame) => frame.type === 'relay.open').length;
  }
}

let clock: number;
let machineFetch: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;
let brokerAudit: unknown[];
let relayAudit: HostedAppRelayAuditEvent[];
let broker: HostedWorkspaceSessionBroker;
let connector: MachineConnector;
let usage: InMemoryHostedAppRelayUsageStore;

function deps(limits: AppRelayLimits = { requestsPerMinute: 100, monthlyBandwidthBytes: 1024 * 1024 }): HostedAppRelayDependencies {
  return {
    port: broker,
    usage,
    rate: new AppRelayRateLimiter(limits.requestsPerMinute),
    limits,
    now: () => new Date(clock),
    onAudit: (event) => relayAudit.push(event),
  };
}

function appCall(path = '/api/workspaces/ws-1/agent-tools/harness/list?limit=2', init: RequestInit = {}): Request {
  return new Request(`https://app.papercusp.com${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${APP_KEY}`, 'content-type': 'application/json', 'x-trace': HEADER_MARKER },
    body: JSON.stringify({ note: BODY_MARKER }),
    ...init,
  });
}

beforeEach(() => {
  clock = Date.UTC(2026, 8, 30, 12, 0, 0);
  machineFetch = vi.fn(async () => new Response(JSON.stringify({ tools: ['harness:list'] }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': 'machine=1' },
  }));
  brokerAudit = [];
  relayAudit = [];
  broker = new HostedWorkspaceSessionBroker({ pingIntervalMs: 0, now: () => clock, onAudit: (event) => brokerAudit.push(event) });
  connector = new MachineConnector(machineFetch);
  broker.attachConnector(BINDING, connector);
  usage = new InMemoryHostedAppRelayUsageStore();
});

afterEach(() => {
  broker.dispose();
});

describe('R-16 — the portal relays an app call', () => {
  it('refuses an offline BYOC workspace using the durable hosting classification', async () => {
    connector.close();
    const input = deps();
    input.resolveCustomerWorkspaceHosting = async (id) => id === 'ws-1' ? 'byoc' : null;
    const response = await handleHostedAppRelay(appCall(), input);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'byoc_plaintext_relay_refused',
      alternatives: ['customer_controlled_ingress', 'sealed_channel'],
    });
    expect(usage.rows.size).toBe(0);
    expect(machineFetch).not.toHaveBeenCalled();
  });

  it('refuses BYOC before parsing an app key or reading and forwarding the body', async () => {
    broker.attachConnector({ ...BINDING, hosting: 'byoc' }, connector);
    const response = await handleHostedAppRelay(appCall(), deps());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'byoc_plaintext_relay_refused',
      alternatives: ['customer_controlled_ingress', 'sealed_channel'],
    });
    expect(connector.opened()).toBe(0);
    expect(machineFetch).not.toHaveBeenCalled();
    expect(usage.rows.size).toBe(0);
    expect(relayAudit).toContainEqual({ action: 'app_relay_refused', customerWorkspaceId: 'ws-1', detail: 'byoc_plaintext_relay_refused' });
    expect(JSON.stringify(relayAudit)).not.toContain(BODY_MARKER);
  });

  it('returns the machine response for a limited-key call to a connected workspace', async () => {
    const response = await handleHostedAppRelay(appCall(), deps());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tools: ['harness:list'] });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(machineFetch).toHaveBeenCalledTimes(1);
    const [url, init] = machineFetch.mock.calls[0];
    expect(url).toBe('http://machine.test/api/agent-tools/harness/list?limit=2');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${APP_KEY}`);
    expect(headers['x-papercusp-ingress']).toBe('app-relay');
    expect(headers['x-trace']).toBeUndefined();
    expect(Buffer.from(init.body as Uint8Array).toString()).toBe(JSON.stringify({ note: BODY_MARKER }));
  });

  it('relays the MCP route to the machine /api/mcp', async () => {
    const response = await handleHostedAppRelay(appCall('/api/workspaces/ws-1/mcp'), deps());
    expect(response.status).toBe(200);
    expect(machineFetch.mock.calls[0][0]).toBe('http://machine.test/api/mcp');
  });

  it('the machine end forwards only app routes', () => {
    expect(decideAppHttpRoute('POST', '/api/agent-tools/harness/list')).toMatchObject({ ok: true });
    expect(decideAppHttpRoute('POST', '/api/harness/pots')).toEqual({ ok: false, code: 'route_not_relayed' });
    expect(decideAppHttpRoute('POST', '/api/agent-tools/../admin')).toEqual({ ok: false, code: 'invalid_path' });
  });
});

describe('R-17 — owner and admin tickets are refused on app routes', () => {
  it.each([
    ['an owner ticket bearer', { authorization: `Bearer ${OWNER_TICKET}` }],
    ['an admin/device JWT bearer', { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.sig' }],
    ['a browser session cookie', { cookie: 'papercusp_session=owner-session' }],
    ['no credential', {}],
  ])('refuses %s before reaching the machine', async (_label, headers) => {
    const response = await handleHostedAppRelay(appCall(undefined, { headers: { 'content-type': 'application/json', ...headers } }), deps());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'app_key_required' });
    expect(connector.opened()).toBe(0);
    expect(machineFetch).not.toHaveBeenCalled();
  });

  it('the machine end never forwards a non-app credential', () => {
    const forwarded = appHttpRequestHeaders({ authorization: `Bearer ${OWNER_TICKET}`, cookie: 'papercusp_session=x' });
    expect(forwarded.authorization).toBeUndefined();
    expect(forwarded.cookie).toBeUndefined();
    expect(forwarded['x-papercusp-ingress']).toBe('app-relay');
  });
});

describe('R-18 — an offline machine is refused at once', () => {
  it('refuses when the connector heartbeat is stale, without sending anything to the connector', async () => {
    clock += 90_001;
    const response = await handleHostedAppRelay(appCall(), deps());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'workspace_offline' });
    expect(response.headers.get('retry-after')).toBe('30');
    expect(connector.opened()).toBe(0);
    expect(machineFetch).not.toHaveBeenCalled();
  });

  it('a pong inside the window keeps the workspace reachable', async () => {
    clock += 60_000;
    connector.emit('pong');
    clock += 60_000;
    expect((await handleHostedAppRelay(appCall(), deps())).status).toBe(200);
  });

  it('refuses a workspace with no attached connector', async () => {
    const response = await handleHostedAppRelay(appCall('/api/workspaces/ws-2/mcp'), deps());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'workspace_offline' });
  });
});

describe('R-38 — calls to an offline machine are not stored', () => {
  it('persists no body or header of a workspace-offline refusal in any store the relay writes', async () => {
    connector.close();
    const response = await handleHostedAppRelay(appCall(), deps());
    expect(response.status).toBe(503);

    expect(usage.rows.size).toBe(0);
    const written = JSON.stringify({ usage: [...usage.rows], relayAudit, brokerAudit: brokerAudit.slice(1) });
    expect(written).not.toContain(BODY_MARKER);
    expect(written).not.toContain(HEADER_MARKER);
    expect(written).not.toContain(APP_KEY);
    expect(relayAudit).toEqual([{ action: 'app_relay_refused', customerWorkspaceId: 'ws-1', detail: 'workspace_offline' }]);
  });
});

describe('R-19 — the request-rate limit is enforced', () => {
  it('answers rate_limited once a workspace is over its request rate', async () => {
    const limited = deps({ requestsPerMinute: 2, monthlyBandwidthBytes: 1024 * 1024 });
    expect((await handleHostedAppRelay(appCall(), limited)).status).toBe(200);
    expect((await handleHostedAppRelay(appCall(), limited)).status).toBe(200);
    const refused = await handleHostedAppRelay(appCall(), limited);

    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: 'rate_limited', limit: 'requests_per_minute' });
    expect(machineFetch).toHaveBeenCalledTimes(2);

    clock += 60_000;
    expect((await handleHostedAppRelay(appCall(), limited)).status).toBe(200);
  });
});

describe('R-39 — the monthly relay bandwidth limit is enforced', () => {
  it('answers rate_limited once a workspace is over its monthly bandwidth', async () => {
    // One call counts its request body plus its response body, byte for byte.
    const callBytes = Buffer.byteLength(JSON.stringify({ note: BODY_MARKER }))
      + Buffer.byteLength(JSON.stringify({ tools: ['harness:list'] }));
    const limited = deps({ requestsPerMinute: 100, monthlyBandwidthBytes: callBytes });
    const first = await handleHostedAppRelay(appCall(), limited);
    expect(first.status).toBe(200);
    await first.text();
    await vi.waitFor(async () => expect(await usage.monthBytes(BINDING, appRelayMonth(new Date(clock)))).toBe(callBytes));

    const refused = await handleHostedAppRelay(appCall(), limited);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: 'rate_limited', limit: 'monthly_bandwidth' });
    expect(machineFetch).toHaveBeenCalledTimes(1);
  });

  it('a new month starts a fresh allowance', async () => {
    const limited = deps({ requestsPerMinute: 100, monthlyBandwidthBytes: 64 });
    await usage.add(BINDING, appRelayMonth(new Date(clock)), { bytes: 64, requests: 1 });
    expect((await handleHostedAppRelay(appCall(), limited)).status).toBe(429);
    clock = Date.UTC(2026, 9, 1, 0, 0, 1);
    connector.emit('pong');
    expect((await handleHostedAppRelay(appCall(), limited)).status).toBe(200);
  });
});

describe('P-328 — the machine learns the relay usage it needs for the relay-limit alert', () => {
  it("sends this month's usage and limit on each app call's relay.open, counts only", async () => {
    const month = appRelayMonth(new Date(clock));
    await usage.add(BINDING, month, { bytes: 700, requests: 3 });
    const response = await handleHostedAppRelay(appCall(), deps({ requestsPerMinute: 100, monthlyBandwidthBytes: 1000 }));
    expect(response.status).toBe(200);
    await response.text();

    const opens = connector.frames.filter((frame) => frame.type === 'relay.open');
    expect(opens).toHaveLength(1);
    expect(opens[0].relayUsage).toEqual({ month, bytes: 700, limitBytes: 1000 });
    expect(JSON.stringify(opens[0])).not.toContain(BODY_MARKER);
  });
});

describe('P-017 — a signed webhook is relayed without an app key (D-032 #4)', () => {
  const HOOK = '0b9f3c2e-4d51-4a7e-9c0f-2f8d6a1b3e57';
  const RAW = '{"ref":"refs/heads/main","n":1}';
  const hookCall = (workspace = 'ws-1', init: RequestInit = {}): Request =>
    new Request(`https://app.papercusp.com/api/workspaces/${workspace}/hooks/${HOOK}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'papercusp-signature': `t=1790000000,v1=${'c'.repeat(64)}`,
        'papercusp-event': 'push',
        'papercusp-delivery': 'd-1',
        'x-hub-signature-256': 'sha256=abc',
        'x-hook-secret': 'vendor-handshake',
        'x-other-signature': 'another-provider',
        'x-papercusp-secret': 'never-forward',
        cookie: 'session=owner',
      },
      body: RAW,
      ...init,
    });

  it('forwards the exact body and the signature headers to the machine /api/hooks/<id>, with no key', async () => {
    const response = await handleHostedAppRelay(hookCall(), deps());
    expect(response.status).toBe(200);
    await response.text();
    expect(machineFetch).toHaveBeenCalledTimes(1);
    const [url, init] = machineFetch.mock.calls[0];
    expect(url).toBe(`http://machine.test/api/hooks/${HOOK}`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['papercusp-signature']).toBe(`t=1790000000,v1=${'c'.repeat(64)}`);
    expect(headers['papercusp-event']).toBe('push');
    expect(headers['papercusp-delivery']).toBe('d-1');
    expect(headers['x-hub-signature-256']).toBe('sha256=abc');
    expect(headers['x-hook-secret']).toBe('vendor-handshake');
    expect(headers['x-other-signature']).toBe('another-provider');
    expect(headers['x-papercusp-secret']).toBeUndefined();
    expect(headers['x-papercusp-ingress']).toBe('app-relay');
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(Buffer.from(init.body as Uint8Array).toString()).toBe(RAW);
  });

  it('admits GET verification and POST delivery, refusing other methods', async () => {
    const verification = await handleHostedAppRelay(hookCall('ws-1', { method: 'GET', body: undefined }), deps());
    expect(verification.status).toBe(200);
    expect(machineFetch).toHaveBeenCalledTimes(1);
    machineFetch.mockClear();
    for (const method of ['PUT', 'DELETE']) {
      const response = await handleHostedAppRelay(hookCall('ws-1', { method, body: method === 'GET' ? undefined : RAW }), deps());
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, POST');
    }
    expect(machineFetch).not.toHaveBeenCalled();
  });

  it('still refuses an offline machine at once with 503 and Retry-After (D-008)', async () => {
    const response = await handleHostedAppRelay(hookCall('ws-2'), deps());
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('30');
    expect(machineFetch).not.toHaveBeenCalled();
  });

  it('the machine end admits GET and POST /api/hooks/<uuid> and nothing else under /api/hooks', () => {
    expect(decideAppHttpRoute('POST', `/api/hooks/${HOOK}`)).toMatchObject({ ok: true });
    expect(decideAppHttpRoute('GET', `/api/hooks/${HOOK}`)).toMatchObject({ ok: true });
    expect(decideAppHttpRoute('POST', '/api/hooks/not-a-uuid')).toMatchObject({ ok: false });
    expect(decideAppHttpRoute('POST', `/api/hooks/${HOOK}/x`)).toMatchObject({ ok: false });
  });

  it('a hooks path that is not a uuid is not a relay path at all', async () => {
    const response = await handleHostedAppRelay(new Request('https://app.papercusp.com/api/workspaces/ws-1/hooks/nope', { method: 'POST', body: RAW }), deps());
    expect(response.status).toBe(404);
    expect(machineFetch).not.toHaveBeenCalled();
  });
});
