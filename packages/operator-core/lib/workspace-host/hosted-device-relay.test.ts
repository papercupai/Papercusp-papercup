/**
 * The portal's `device-http` relay plane (android-public-release-2026-10-01 D-013 #2, P-015):
 * a phone's device-API call to a cloud workspace, carried over the workspace's connector.
 */
import { describe, expect, it, vi } from 'vitest';
import { PHONE_DEVICE_PATHS, isPhoneDevicePath } from '../device-ingress-paths';
import {
  AppRelayRateLimiter,
  DEVICE_RELAY_INGRESS_MARKER,
  InMemoryHostedAppRelayUsageStore,
  boundDeviceHttpRequestHeaders,
  createDeviceHttpChannel,
  decideDeviceHttpRoute,
  deviceHttpRequestHeaders,
  unverifiedDeviceJwtSubject,
  type DeviceChannelBinding,
  handleHostedDeviceRelay,
  parseDeviceRelayPath,
  readDeviceJwtBearer,
  type AppRelayChannelKind,
  type AppRelayConnector,
  type AppRelayOpenOptions,
  type HostedAppRelayAuditEvent,
} from './hosted-app-relay';
import { EXTERNAL_INGRESS_MARKER_HEADER } from '../auth/forwarded-request-trust';
import { HOSTED_OPERATOR_HTTP_BODY_CHUNK_BYTES, HOSTED_OPERATOR_HTTP_MAX_INFLIGHT, OperatorHttpChannel } from './hosted-operator-http';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZXYifQ.c2ln';
const NOW = new Date('2026-10-06T12:00:00Z');

interface Opened {
  kind: AppRelayChannelKind | undefined;
  open: AppRelayOpenOptions | undefined;
  sent: Array<Record<string, unknown>>;
}

function harness(opts: {
  hosting?: 'byoc' | 'papercusp';
  online?: boolean;
  reply?: { status: number; body: string };
} = {}) {
  const opened: Opened[] = [];
  const audits: HostedAppRelayAuditEvent[] = [];
  const connector: AppRelayConnector = {
    binding: { customerWorkspaceId: 'ws-1', hostId: 'h1', generation: 1, hosting: opts.hosting ?? 'papercusp' } as AppRelayConnector['binding'],
    lastSeenAt: opts.online === false ? new Date(NOW.getTime() - 3_600_000) : NOW,
  };
  const reply = opts.reply ?? { status: 200, body: '{"ok":true}' };
  const deps = {
    port: {
      appConnector: (id: string) => (id === 'ws-1' ? connector : null),
      openAppChannel(
        _c: AppRelayConnector,
        handlers: { onFrame: (p: Record<string, unknown>) => void; onClose: (r: string) => void },
        kind?: AppRelayChannelKind,
        open?: AppRelayOpenOptions,
      ) {
        const record: Opened = { kind, open, sent: [] };
        opened.push(record);
        return {
          send(payload: Record<string, unknown>) {
            record.sent.push(payload);
            if (payload.type === 'http.request') {
              queueMicrotask(() => {
                handlers.onFrame({ type: 'http.response', requestId: payload.requestId, status: reply.status, headers: { 'content-type': 'application/json', 'set-cookie': 'x=1' } });
                handlers.onFrame({ type: 'http.body', requestId: payload.requestId, data: Buffer.from(reply.body).toString('base64') });
                handlers.onFrame({ type: 'http.end', requestId: payload.requestId });
              });
            }
            return true;
          },
          close() {},
        };
      },
    },
    usage: new InMemoryHostedAppRelayUsageStore(),
    rate: new AppRelayRateLimiter(60),
    now: () => NOW,
    randomId: () => 'req-1',
    onAudit: (event: HostedAppRelayAuditEvent) => audits.push(event),
  };
  return { deps, opened, audits };
}

const call = (path: string, init: RequestInit = {}) =>
  new Request(`https://app.papercusp.com/api/workspaces/ws-1/api/device/${path}`, init);

describe('device-http chunked upload lifecycle', () => {
  function uploadHarness(limit = 10, timeout = 100) {
    const frames: Record<string, unknown>[] = [];
    const fetch = vi.fn(async () => new Response('ok'));
    const channel = new OperatorHttpChannel({
      send: (frame) => frames.push(frame), audit: () => {},
      requestHeaders: deviceHttpRequestHeaders, decideRoute: decideDeviceHttpRoute,
      fetch, maxChunkedRequestBodyBytes: limit, headerTimeoutMs: timeout,
    });
    const start = (requestId = 'upload', extra: Record<string, unknown> = {}) =>
      channel.accept('http.request', { requestId, method: 'POST', path: '/api/device/voice/turn', bodyChunked: true, ...extra });
    const chunk = (data: string, requestId = 'upload') =>
      channel.accept('http.body', { requestId, data });
    return { channel, frames, fetch, start, chunk };
  }

  it('refuses oversize or malformed chunks and forgets the partial upload', async () => {
    const run = uploadHarness();
    for (const data of [Buffer.alloc(11).toString('base64'), 'not base64', Buffer.alloc(HOSTED_OPERATOR_HTTP_BODY_CHUNK_BYTES + 1).toString('base64')]) {
      await run.start();
      await run.chunk(data);
      expect(run.channel.inflightCount).toBe(0);
    }
    expect(run.frames.map((frame) => frame.code)).toEqual(['request_body_too_large', 'invalid_body_chunk', 'invalid_body_chunk']);
    expect(run.fetch).not.toHaveBeenCalled();
    run.channel.close();
  });

  it('counts pending uploads toward the in-flight cap and rejects duplicate IDs', async () => {
    const run = uploadHarness();
    await run.start();
    await run.start();
    expect(run.frames).toContainEqual(expect.objectContaining({ code: 'request_id_in_use' }));
    expect(run.channel.inflightCount).toBe(1);
    for (let index = 1; index < HOSTED_OPERATOR_HTTP_MAX_INFLIGHT; index++) await run.start(`pending-${index}`);
    await run.start('over-cap');
    expect(run.channel.inflightCount).toBe(HOSTED_OPERATOR_HTTP_MAX_INFLIGHT);
    expect(run.frames).toContainEqual(expect.objectContaining({ requestId: 'over-cap', code: 'too_many_requests', status: 429 }));
    run.channel.close();
    expect(run.channel.inflightCount).toBe(0);
  });

  it('aborts and times out unfinished uploads without sending any partial content', async () => {
    const run = uploadHarness(10, 5);
    await run.start();
    await run.chunk(Buffer.from('abc').toString('base64'));
    await run.channel.accept('http.abort', { requestId: 'upload' });
    expect(run.channel.inflightCount).toBe(0);
    await run.start('timeout');
    await vi.waitFor(() => expect(run.frames).toContainEqual(expect.objectContaining({ requestId: 'timeout', code: 'request_body_timeout', status: 408 })));
    expect(run.channel.inflightCount).toBe(0);
    expect(run.fetch).not.toHaveBeenCalled();
    run.channel.close();
  });

  it('validates routes before buffering and rejects inline/chunked ambiguity', async () => {
    const run = uploadHarness();
    await run.start('denied', { path: '/api/mcp' });
    await run.start('ambiguous', { body: 'YWJj' });
    expect(run.frames.map((frame) => frame.code)).toEqual(['route_not_relayed', 'invalid_body']);
    expect(run.channel.inflightCount).toBe(0);
    expect(run.fetch).not.toHaveBeenCalled();
    run.channel.close();
  });
});

describe('device-http allowlist (derived from the external-ingress phone list)', () => {
  it('admits every phone device path and nothing desktop-only', () => {
    for (const path of PHONE_DEVICE_PATHS) expect(decideDeviceHttpRoute('POST', path).ok, path).toBe(true);
    expect(decideDeviceHttpRoute('GET', '/api/device/devices/dev-1').ok).toBe(true);
    for (const path of ['/api/device/pair-token', '/api/device/mint', '/api/device/qr', '/api/agent-tools/x/y', '/api/mcp']) {
      expect(decideDeviceHttpRoute('POST', path), path).toEqual({ ok: false, code: 'route_not_relayed' });
      expect(isPhoneDevicePath(path), path).toBe(false);
    }
    expect(decideDeviceHttpRoute('PUT', '/api/device/heartbeat')).toEqual({ ok: false, code: 'route_not_relayed' });
    expect(decideDeviceHttpRoute('GET', '/api/device/../mcp')).toEqual({ ok: false, code: 'invalid_path' });
  });

  it('parses only /api/workspaces/<id>/device/<route>', () => {
    expect(parseDeviceRelayPath('/api/workspaces/ws-1/api/device/runtime-config')).toEqual({ customerWorkspaceId: 'ws-1', machinePath: '/api/device/runtime-config' });
    expect(parseDeviceRelayPath('/api/workspaces/ws-1/mcp')).toBeNull();
    // The pre-fix shape: the shared Rust client never sends it, so it must not be relayed.
    expect(parseDeviceRelayPath('/api/workspaces/ws-1/device/runtime-config')).toBeNull();
  });
});

describe('device-http header policy', () => {
  it('forwards a device-JWT-shaped bearer only, and always stamps the deny-only marker', () => {
    expect(readDeviceJwtBearer(`Bearer ${JWT}`)).toBe(JWT);
    expect(readDeviceJwtBearer('Bearer pcapp_abcdef')).toBeNull();
    expect(readDeviceJwtBearer('Basic abc')).toBeNull();
    const headers = deviceHttpRequestHeaders({ Authorization: `Bearer ${JWT}`, Cookie: 'sid=1', 'Content-Type': 'application/json', 'X-Forwarded-For': '1.2.3.4' });
    expect(headers).toEqual({ authorization: `Bearer ${JWT}`, 'content-type': 'application/json', [EXTERNAL_INGRESS_MARKER_HEADER]: DEVICE_RELAY_INGRESS_MARKER });
    expect(deviceHttpRequestHeaders({ authorization: 'Bearer pcapp_x' }).authorization).toBeUndefined();
  });
});

/** A JWT-shaped token whose claims are `claims`; the signature is never checked here. */
function jwtWithClaims(claims: unknown): string {
  return `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2ln`;
}

describe('sealed device-http channel binding (D-013 #6)', () => {
  const DEV_A = jwtWithClaims({ sub: 'dev-a' });
  const DEV_B = jwtWithClaims({ sub: 'dev-b' });

  it('reads the unverified sub claim, and nothing from a malformed token', () => {
    expect(unverifiedDeviceJwtSubject(DEV_A)).toBe('dev-a');
    expect(unverifiedDeviceJwtSubject(JWT)).toBe('dev');
    expect(unverifiedDeviceJwtSubject(jwtWithClaims({ sub: 7 }))).toBeNull();
    expect(unverifiedDeviceJwtSubject(jwtWithClaims({ sub: '' }))).toBeNull();
    expect(unverifiedDeviceJwtSubject(jwtWithClaims('dev-a'))).toBeNull();
    expect(unverifiedDeviceJwtSubject('a.!!!not-json!!!.c')).toBeNull();
    expect(unverifiedDeviceJwtSubject('no-dots')).toBeNull();
  });

  it('keeps a JWT naming the bound device, with the rest of the header policy intact', () => {
    const headers = boundDeviceHttpRequestHeaders({ Authorization: `Bearer ${DEV_A}`, 'Content-Type': 'application/json', Cookie: 'x=1' }, { deviceId: 'dev-a' });
    expect(headers).toEqual({ authorization: `Bearer ${DEV_A}`, 'content-type': 'application/json', [EXTERNAL_INGRESS_MARKER_HEADER]: DEVICE_RELAY_INGRESS_MARKER });
  });

  it("drops another phone's JWT, so one paired key cannot present a second device's token", () => {
    const headers = boundDeviceHttpRequestHeaders({ authorization: `Bearer ${DEV_B}`, 'content-type': 'application/json' }, { deviceId: 'dev-a' });
    expect(headers.authorization).toBeUndefined();
    expect(headers[EXTERNAL_INGRESS_MARKER_HEADER]).toBe(DEVICE_RELAY_INGRESS_MARKER);
    expect(headers['content-type']).toBe('application/json');
  });

  it('forwards no JWT at all on a channel whose key is not a registered device (pair redeem)', () => {
    expect(boundDeviceHttpRequestHeaders({ authorization: `Bearer ${DEV_A}` }, { deviceId: null }).authorization).toBeUndefined();
    expect(boundDeviceHttpRequestHeaders({ authorization: `Bearer ${jwtWithClaims({})}` }, { deviceId: 'dev-a' }).authorization).toBeUndefined();
  });

  function channelHarness(boundDevice?: DeviceChannelBinding) {
    const seen: Array<Record<string, string>> = [];
    const channel = createDeviceHttpChannel({
      send: () => {},
      audit: () => {},
      origin: 'http://127.0.0.1:1',
      fetch: async (_url, init) => {
        seen.push({ ...(init.headers as Record<string, string>) });
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
      ...(boundDevice ? { boundDevice } : {}),
    });
    const request = (requestId: string, token: string) =>
      channel.accept('http.request', { requestId, method: 'GET', path: '/api/device/runtime-config', headers: { authorization: `Bearer ${token}` } });
    return { seen, request };
  }

  it('applies the binding at request time, so a device resolved after the handshake is honoured', async () => {
    const binding: DeviceChannelBinding = { deviceId: null };
    const h = channelHarness(binding);
    await h.request('r1', DEV_A);
    binding.deviceId = 'dev-a';
    await h.request('r2', DEV_A);
    await h.request('r3', DEV_B);
    expect(h.seen.map((headers) => headers.authorization ?? null)).toEqual([null, `Bearer ${DEV_A}`, null]);
  });

  it('leaves an unsealed channel on the plain header policy', async () => {
    const h = channelHarness();
    await h.request('r1', DEV_B);
    expect(h.seen[0].authorization).toBe(`Bearer ${DEV_B}`);
  });
});

describe('sealed pair redeem registers the handshake-proven Noise key (D-013 #6)', () => {
  const PROVEN = Buffer.alloc(32, 7).toString('base64');
  const OTHER = Buffer.alloc(32, 9).toString('base64');

  function pairHarness(boundDevice?: DeviceChannelBinding) {
    const bodies: Array<Record<string, unknown> | null> = [];
    const sent: Array<Record<string, unknown>> = [];
    const channel = createDeviceHttpChannel({
      send: (payload) => sent.push(payload),
      audit: () => {},
      origin: 'http://127.0.0.1:1',
      fetch: async (_url, init) => {
        bodies.push(init.body ? JSON.parse(Buffer.from(init.body as Uint8Array).toString('utf8')) : null);
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
      ...(boundDevice ? { boundDevice } : {}),
    });
    const pair = (requestId: string, body: unknown) =>
      channel.accept('http.request', {
        requestId,
        method: 'POST',
        path: '/api/device/pair',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)).toString('base64') }),
      });
    return { bodies, sent, pair };
  }

  it('forwards a pair whose body key is the key the handshake proved', async () => {
    const h = pairHarness({ deviceId: null, noisePublicKey: PROVEN });
    await h.pair('r1', { pairToken: 'tok', noisePublicKey: PROVEN });
    expect(h.bodies).toEqual([{ pairToken: 'tok', noisePublicKey: PROVEN }]);
  });

  it('fills in the proven key when the phone omits it', async () => {
    const h = pairHarness({ deviceId: null, noisePublicKey: PROVEN });
    await h.pair('r1', { pairToken: 'tok' });
    expect(h.bodies).toEqual([{ pairToken: 'tok', noisePublicKey: PROVEN }]);
  });

  it('refuses a pair naming a key other than the proven one, before the one-time token reaches the machine', async () => {
    const h = pairHarness({ deviceId: null, noisePublicKey: PROVEN });
    await h.pair('r1', { pairToken: 'tok', noisePublicKey: OTHER });
    await h.pair('r2', { pairToken: 'tok', noisePublicKey: 'not-base64-key' });
    expect(h.bodies).toEqual([]);
    expect(h.sent).toEqual([
      { type: 'http.error', requestId: 'r1', code: 'noise_key_mismatch', status: 403 },
      { type: 'http.error', requestId: 'r2', code: 'noise_key_mismatch', status: 403 },
    ]);
  });

  it('refuses a pair on a sealed channel with no proven key, or whose body is not a JSON object', async () => {
    const unproven = pairHarness({ deviceId: null });
    await unproven.pair('r1', { pairToken: 'tok', noisePublicKey: PROVEN });
    expect(unproven.sent).toEqual([{ type: 'http.error', requestId: 'r1', code: 'noise_key_unproven', status: 403 }]);
    const malformed = pairHarness({ deviceId: null, noisePublicKey: PROVEN });
    await malformed.pair('r1', 'not json');
    await malformed.pair('r2', undefined);
    expect(malformed.bodies).toEqual([]);
    expect(malformed.sent.map((m) => m.code)).toEqual(['invalid_body', 'invalid_body']);
  });

  it('leaves an unsealed pair body untouched (the operator route validates it)', async () => {
    const h = pairHarness();
    await h.pair('r1', { pairToken: 'tok', noisePublicKey: OTHER });
    expect(h.bodies).toEqual([{ pairToken: 'tok', noisePublicKey: OTHER }]);
  });
});

describe('handleHostedDeviceRelay', () => {
  it('relays a JWT-bearing call over a device-http channel and streams the answer back', async () => {
    const h = harness();
    const res = await handleHostedDeviceRelay(call('runtime-config?x=1', { headers: { authorization: `Bearer ${JWT}` } }), h.deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0].kind).toBe('device-http');
    expect(h.opened[0].sent[0]).toMatchObject({
      type: 'http.request', method: 'GET', path: '/api/device/runtime-config?x=1',
      headers: { authorization: `Bearer ${JWT}`, [EXTERNAL_INGRESS_MARKER_HEADER]: DEVICE_RELAY_INGRESS_MARKER },
    });
  });

  it('lets pair through with no bearer, and carries its body', async () => {
    const h = harness();
    const res = await handleHostedDeviceRelay(call('pair', { method: 'POST', body: '{"token":"t"}', headers: { 'content-type': 'application/json' } }), h.deps);
    expect(res.status).toBe(200);
    expect(Buffer.from(String(h.opened[0].sent[0].body), 'base64').toString()).toBe('{"token":"t"}');
  });

  it('refuses a non-pair call without a device-JWT-shaped bearer before opening a channel', async () => {
    const h = harness();
    const res = await handleHostedDeviceRelay(call('heartbeat', { method: 'POST', headers: { authorization: 'Bearer pcapp_abc' } }), h.deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'device_token_required' });
    expect(h.opened).toHaveLength(0);
  });

  it('passes the machine 401 through unchanged (the VM owns auth)', async () => {
    const h = harness({ reply: { status: 401, body: '{"error":"unauthorized"}' } });
    const res = await handleHostedDeviceRelay(call('heartbeat', { method: 'POST', headers: { authorization: `Bearer ${JWT}` } }), h.deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('refuses a route off the phone allowlist as route_not_relayed (never a re-pair code)', async () => {
    const h = harness();
    const res = await handleHostedDeviceRelay(call('pair-token', { method: 'POST', headers: { authorization: `Bearer ${JWT}` } }), h.deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'route_not_relayed' });
    expect(h.opened).toHaveLength(0);
  });

  it('answers workspace_offline (503 + retry-after) when the connector is stale', async () => {
    const h = harness({ online: false });
    const res = await handleHostedDeviceRelay(call('heartbeat', { method: 'POST', headers: { authorization: `Bearer ${JWT}` } }), h.deps);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await res.json()).toEqual({ error: 'workspace_offline' });
  });

  it('refuses plaintext device content to a BYOC workspace (D-013 #6)', async () => {
    const h = harness({ hosting: 'byoc' });
    const res = await handleHostedDeviceRelay(call('heartbeat', { method: 'POST', headers: { authorization: `Bearer ${JWT}` } }), h.deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'byoc_plaintext_relay_refused' });
    expect(h.opened).toHaveLength(0);
    expect(h.audits).toContainEqual({ action: 'app_relay_refused', customerWorkspaceId: 'ws-1', detail: 'byoc_plaintext_relay_refused' });
  });
});
