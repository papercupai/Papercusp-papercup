/** D-019: real broker → outbound connector → workspace host, with opaque phone ingress. */
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import SecretStream from '@hyperswarm/secret-stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HostedWorkspaceSessionBroker,
  HOSTED_WORKSPACE_MAX_MESSAGE_BYTES,
} from '../endpoint-route/hosted-workspace-session';
import type { HostedConnectorBinding } from '../endpoint-route/hosted-workspace-connector';
import { BYOC_SEALED_PROTOCOL, ByocSealedChannel, isByocSealedPacket } from './byoc-sealed-channel';
import { HostedWorkspaceConnectorClient } from './hosted-connector-client';
import { HostedWorkspaceHostSessionAdapter } from './hosted-session-host';
import { attachSealedDeviceSocket, DEVICE_RELAY_INGRESS_MARKER } from './hosted-app-relay';
import { EXTERNAL_INGRESS_MARKER_HEADER } from '../auth/forwarded-request-trust';
import { HOSTED_OPERATOR_HTTP_BODY_CHUNK_BYTES, HOSTED_OPERATOR_HTTP_MAX_REQUEST_BODY_BYTES } from './hosted-operator-http';
import { __resetDeviceJwtForTest, verifyDeviceToken } from '../device-jwt';

class WireSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  peer?: WireSocket;
  closeCode?: number;
  closeReason?: string;
  constructor(readonly captures: string[]) { super(); }
  send(data: string | Buffer) {
    const raw = data.toString();
    this.captures.push(raw);
    queueMicrotask(() => {
      if (this.readyState === 1 && this.peer?.readyState === 1) this.peer.emit('message', Buffer.from(raw), false);
    });
  }
  close(code = 1000, reason = '') {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit('close');
    if (this.peer?.readyState === 1) this.peer.close(code, reason);
  }
}
function pair(captures: string[]) {
  const control = new WireSocket(captures);
  const peer = new WireSocket(captures);
  control.peer = peer;
  peer.peer = control;
  return { control, peer };
}
const binding: HostedConnectorBinding = {
  controlPlaneWorkspaceId: 'control-1', organizationId: 'org-1',
  customerWorkspaceId: 'byoc-1', hostId: 'host-1', routeLabel: 'byoc',
  generation: 1, transport: 'websocket', state: 'active', hosting: 'byoc',
};
// Independent token producer: the relay/VM verifier must check signatures,
// expiry and device kind, rather than agree with a mocked authorization answer.
const jwtSecret = 'sealed-device-integration-secret-padding';
let fixtureExpiresAt: number;
const jwt = (sub: string, exp = fixtureExpiresAt) => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, workspace_id: 'byoc-1', device_kind: 'mobile', exp })).toString('base64url');
  const signature = createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
};
const cleanup: Array<() => void> = [];
beforeEach(() => {
  // One expiry per test keeps independently produced tokens byte-identical
  // when a transport round trip crosses a wall-clock second.
  fixtureExpiresAt = Math.floor(Date.now() / 1000) + 3600;
  vi.stubEnv('MOBILE_JWT_SECRET', jwtSecret);
  __resetDeviceJwtForTest();
});
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.unstubAllEnvs();
  __resetDeviceJwtForTest();
});

async function assembled(options: { registered?: boolean; responseBody?: string; responseStream?: ReadableStream<Uint8Array>; status?: number; hosting?: 'byoc' | 'papercusp' } = {}) {
  const captures: string[] = [];
  const phoneKey = SecretStream.keyPair(Buffer.alloc(32, 51));
  const hostKey = SecretStream.keyPair(Buffer.alloc(32, 52));
  const fetched: Array<{ url: string; headers: Headers; body: string }> = [];
  const frames: Record<string, unknown>[] = [];
  const errors: string[] = [];
  let adapter: HostedWorkspaceHostSessionAdapter | undefined;
  const connectorWire = pair(captures);
  const client = new HostedWorkspaceConnectorClient({
    url: 'wss://portal.test/api/hosted/connectors/socket', bearer: 'fixture',
    createSocket: () => connectorWire.peer,
    onBound: (actualBinding) => {
      adapter = new HostedWorkspaceHostSessionAdapter({
        binding: actualBinding, workspaceRoot: tmpdir(), send: (frame) => client.send(frame),
        byocSealedChannel: {
          localKeyPair: hostKey,
          resolveDeviceNoiseKey: async (key) =>
            options.registered !== false && key === phoneKey.publicKey.toString('base64') ? 'phone-1' : null,
        },
        operatorHttp: {
          fetch: async (url, init) => {
            const headers = new Headers(init.headers);
            fetched.push({ url, headers, body: init.body ? Buffer.from(init.body as Uint8Array).toString() : '' });
            // The HTTP peer uses the production VM JWT verifier. Device storage
            // and route handlers remain controlled here; this is not live VM acceptance.
            const paired = url.endsWith('/api/device/pair');
            const token = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
            const claims = verifyDeviceToken(token);
            const status = paired || (claims?.sub === 'phone-1' && claims.workspace_id === 'byoc-1') ? options.status ?? 200 : 401;
            return new Response(options.responseStream ?? options.responseBody ?? '{"secret":"DEVICE_CONTENT_MARKER"}', {
              status, headers: { 'content-type': options.responseStream ? 'text/event-stream' : 'application/json' },
            });
          },
        },
      });
    },
    onEnvelope: (frame) => { void adapter?.accept(frame).catch((error: Error) => errors.push(error.message)); },
    pingIntervalMs: 60_000,
  });
  const broker = new HostedWorkspaceSessionBroker({ pingIntervalMs: 0 });
  const phoneWire = pair(captures);
  let phone: ByocSealedChannel | undefined;
  cleanup.push(() => {
    phone?.close();
    phoneWire.control.close();
    client.stop();
    adapter?.close();
    connectorWire.control.close();
  });
  client.start();
  broker.attachConnector({ ...binding, hosting: options.hosting ?? binding.hosting }, connectorWire.control);
  await vi.waitFor(() => expect(adapter).toBeDefined());
  expect(attachSealedDeviceSocket(broker, binding.customerWorkspaceId, phoneWire.control)).toBe(true);
  phoneWire.peer.on('message', (data: Buffer) => {
    const value: unknown = JSON.parse(data.toString());
    if (isByocSealedPacket(value)) phone?.receive(value);
  });
  phone = new ByocSealedChannel({
    initiator: true, localKeyPair: phoneKey, expectedRemotePublicKey: hostKey.publicKey,
    sendPacket: (packet) => phoneWire.peer.send(JSON.stringify(packet)),
    onFrame: (frame) => frames.push(frame), onError: (error) => errors.push(error.message),
  });
  await phone.opened;
  await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'http.ready')).toBe(true));
  const request = async (id: string, path: string, extras: Record<string, unknown> = {}) => {
    await phone!.send({
      type: 'http.request', requestId: id, method: 'POST', path,
      headers: { authorization: `Bearer ${jwt('phone-1')}`, 'content-type': 'application/json' },
      ...extras,
    });
    await vi.waitFor(() => expect(frames.some((frame) =>
      frame.requestId === id && (frame.type === 'http.end' || frame.type === 'http.error'))).toBe(true));
    return frames.filter((frame) => frame.requestId === id);
  };
  return { broker, phoneWire, phone, phoneKey, fetched, frames, captures, errors, request };
}

describe('assembled sealed device ingress (D-019)', () => {
  it('R-32: a session transcript stays open and carries a new turn through Noise without leaking relay content', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const responseStream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const h = await assembled({ responseStream });
    await h.phone.send({ type: 'http.request', requestId: 'sessions-live', method: 'GET',
      path: '/api/device/sessions/su-target/transcript?stream=1', headers: { authorization: `Bearer ${jwt('phone-1')}` } });
    source.enqueue(new TextEncoder().encode('event: backfill\ndata: []\n\n'));
    const text = () => h.frames.filter(frame => frame.requestId === 'sessions-live' && frame.type === 'http.body')
      .map(frame => Buffer.from(String(frame.data), 'base64').toString()).join('');
    await vi.waitFor(() => expect(text()).toContain('event: backfill'));
    expect(h.frames.some(frame => frame.requestId === 'sessions-live' && frame.type === 'http.end')).toBe(false);
    source.enqueue(new TextEncoder().encode('event: event\ndata: {"kind":"text","text":"SESSION_LIVE_PRIVATE_MARKER"}\n\n'));
    await vi.waitFor(() => expect(text()).toContain('SESSION_LIVE_PRIVATE_MARKER'));
    expect(h.fetched).toHaveLength(1);
    expect(h.fetched[0].url).toContain('/api/device/sessions/su-target/transcript?stream=1');
    expect(h.captures.join('\n')).not.toContain('SESSION_LIVE_PRIVATE_MARKER');
    expect(h.errors).toEqual([]);
    source.close();
    await vi.waitFor(() => expect(h.frames.some(frame => frame.requestId === 'sessions-live' && frame.type === 'http.end')).toBe(true));
  });

  it('keeps the fixture bearer stable across wall-clock seconds while preserving expiry verification', () => {
    const token = jwt('phone-1');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    try {
      expect(jwt('phone-1')).toBe(token);
      expect(verifyDeviceToken(token)?.sub).toBe('phone-1');
      expect(verifyDeviceToken(jwt('phone-1', Math.floor(Date.now() / 1000) - 60))).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['byoc', 'papercusp'] as const)('operates against %s without a portal session ticket and keeps device content encrypted on both relay wires', async (hosting) => {
    const run = await assembled({ hosting });
    const response = await run.request('chat-1', '/api/device/operator/converse', {
      body: Buffer.from('PHONE_CONTENT_MARKER').toString('base64'),
    });
    expect(response.find((frame) => frame.type === 'http.response')?.status).toBe(200);
    const body = response.filter((frame) => frame.type === 'http.body').map((frame) => Buffer.from(String(frame.data), 'base64').toString()).join('');
    expect(body).toContain('DEVICE_CONTENT_MARKER');
    expect(run.fetched[0].body).toBe('PHONE_CONTENT_MARKER');
    expect(run.fetched[0].headers.get(EXTERNAL_INGRESS_MARKER_HEADER)).toBe(DEVICE_RELAY_INGRESS_MARKER);
    for (const marker of ['PHONE_CONTENT_MARKER', 'DEVICE_CONTENT_MARKER', jwt('phone-1')]) {
      for (const wire of run.captures) {
        expect(wire).not.toContain(marker);
        expect(wire).not.toContain(Buffer.from(marker).toString('base64'));
      }
    }
    expect(run.errors).toEqual([]);
  });

  it('binds pair redemption to the handshake-proven key, including an unregistered phone', async () => {
    const run = await assembled({ registered: false });
    const refused = await run.request('wrong-pair-key', '/api/device/pair', {
      body: Buffer.from(JSON.stringify({ pairToken: 'one-use', noisePublicKey: 'attacker-key' })).toString('base64'),
    });
    expect(refused).toContainEqual(expect.objectContaining({ type: 'http.error', code: 'noise_key_mismatch', status: 403 }));
    expect(run.fetched).toEqual([]);
    await run.request('pair-1', '/api/device/pair', {
      body: Buffer.from(JSON.stringify({ pairToken: 'one-use' })).toString('base64'),
    });
    expect(JSON.parse(run.fetched[0].body).noisePublicKey).toBe(run.phoneKey.publicKey.toString('base64'));
    expect(run.fetched[0].headers.get('authorization')).toBeNull();
  });

  it('does not let one proven device key present another device JWT', async () => {
    const run = await assembled();
    const response = await run.request('wrong-device', '/api/device/heartbeat', {
      headers: { authorization: `Bearer ${jwt('phone-2')}` },
    });
    expect(run.fetched[0].headers.get('authorization')).toBeNull();
    expect(response.find((frame) => frame.type === 'http.response')?.status).toBe(401);
  });

  it('refuses missing, forged and expired device bearers through the assembled sealed relay', async () => {
    const run = await assembled();
    const valid = jwt('phone-1');
    const forged = `${valid.slice(0, valid.lastIndexOf('.') + 1)}${Buffer.alloc(32).toString('base64url')}`;
    for (const [index, authorization] of [undefined, 'Bearer pcapp_not-a-device', `Bearer ${forged}`, `Bearer ${jwt('phone-1', 1)}`].entries()) {
      const response = await run.request(`invalid-bearer-${index}`, '/api/device/heartbeat', {
        headers: authorization ? { authorization } : {},
      });
      expect(response.find((frame) => frame.type === 'http.response')?.status).toBe(401);
    }
    const accepted = await run.request('valid-bearer', '/api/device/heartbeat', {
      headers: { authorization: `Bearer ${valid}` },
    });
    expect(accepted.find((frame) => frame.type === 'http.response')?.status).toBe(200);
    expect(run.phoneWire.control.readyState).toBe(1);
  });

  it('denies desktop mint, tools and MCP even inside valid sealed packets', async () => {
    const run = await assembled();
    for (const [index, path] of ['/api/device/pair-token', '/api/agent-tools/x/y', '/api/mcp'].entries()) {
      const response = await run.request(`deny-${index}`, path);
      expect(response).toContainEqual(expect.objectContaining({ type: 'http.error', code: 'route_not_relayed', status: 403 }));
    }
    expect(run.fetched).toEqual([]);
  });

  it('passes a VM refusal unchanged without closing the pairing transport', async () => {
    const run = await assembled({ status: 403 });
    const response = await run.request('refusal', '/api/device/heartbeat');
    expect(response.find((frame) => frame.type === 'http.response')?.status).toBe(403);
    expect(run.phoneWire.control.readyState).toBe(1);
    await run.request('retry', '/api/device/heartbeat');
    expect(run.fetched).toHaveLength(2);
  });

  it('enforces request body limits and chunks a large response into relay-safe frames', async () => {
    const responseBody = 'R'.repeat(HOSTED_OPERATOR_HTTP_MAX_REQUEST_BODY_BYTES + 100);
    const run = await assembled({ responseBody });
    const response = await run.request('large-response', '/api/device/voice/turn');
    const chunks = response.filter((frame) => frame.type === 'http.body');
    expect(chunks.length).toBeGreaterThan(1);
    expect(Buffer.concat(chunks.map((frame) => Buffer.from(String(frame.data), 'base64'))).toString()).toBe(responseBody);
    expect(run.captures.every((wire) => Buffer.byteLength(wire) <= HOSTED_WORKSPACE_MAX_MESSAGE_BYTES)).toBe(true);
    const denied = await run.request('large-request', '/api/device/voice/turn', {
      body: Buffer.alloc(HOSTED_OPERATOR_HTTP_MAX_REQUEST_BODY_BYTES + 1).toString('base64'),
    });
    expect(denied).toContainEqual(expect.objectContaining({ type: 'http.error', code: 'request_body_too_large', status: 413 }));
    expect(run.fetched).toHaveLength(1);
  });

  it('reassembles a voice upload larger than the inline cap from separately sealed HTTP body chunks', async () => {
    const run = await assembled();
    const body = Buffer.from(JSON.stringify({ audio: 'VOICE_UPLOAD_MARKER'.repeat(32_000) }));
    expect(body.length).toBeGreaterThan(HOSTED_OPERATOR_HTTP_MAX_REQUEST_BODY_BYTES);
    await run.phone.send({
      type: 'http.request', requestId: 'upload', method: 'POST',
      path: '/api/device/voice/turn', bodyChunked: true,
      headers: { authorization: `Bearer ${jwt('phone-1')}`, 'content-type': 'application/json' },
    });
    for (let offset = 0; offset < body.length; offset += HOSTED_OPERATOR_HTTP_BODY_CHUNK_BYTES) {
      await run.phone.send({
        type: 'http.body', requestId: 'upload',
        data: body.subarray(offset, offset + HOSTED_OPERATOR_HTTP_BODY_CHUNK_BYTES).toString('base64'),
      });
    }
    expect(run.fetched).toEqual([]);
    await run.phone.send({ type: 'http.end', requestId: 'upload' });
    await vi.waitFor(() => expect(run.frames.some((frame) => frame.type === 'http.end' && frame.requestId === 'upload')).toBe(true));
    expect(run.fetched).toHaveLength(1);
    expect(run.fetched[0].body).toBe(body.toString());
    expect(run.fetched[0].headers.get('authorization')).toBe(`Bearer ${jwt('phone-1')}`);
    expect(run.captures.every((wire) => Buffer.byteLength(wire) <= HOSTED_WORKSPACE_MAX_MESSAGE_BYTES)).toBe(true);
    expect(run.captures.join('\n')).not.toContain('VOICE_UPLOAD_MARKER');
  });

  it('closes on plaintext or malformed phone content instead of forwarding it', async () => {
    for (const raw of ['{"type":"http.request","path":"/api/device/heartbeat"}', 'not-json']) {
      const run = await assembled();
      run.phoneWire.peer.send(raw);
      await vi.waitFor(() => expect(run.phoneWire.control.closeCode).toBe(4403));
      expect(run.fetched).toEqual([]);
    }
  });

  it('refuses plaintext disguised as a sealed packet even after a valid Noise handshake', async () => {
    const run = await assembled();
    const plaintext = Buffer.from(JSON.stringify({
      type: 'http.request', requestId: 'fake-sealed', method: 'POST', path: '/api/device/heartbeat',
      headers: { authorization: `Bearer ${jwt('phone-1')}` },
    }));
    // SecretStream's transport has a three-byte little-endian length prefix.
    // Supply a complete record so the test reaches ciphertext authentication,
    // rather than leaving an arbitrary byte prefix waiting for more data.
    const record = Buffer.alloc(3 + plaintext.length);
    record.writeUIntLE(plaintext.length, 0, 3);
    plaintext.copy(record, 3);
    // An envelope and base64 are not encryption. The real responder must
    // authenticate the ciphertext before delivering any application content.
    run.phoneWire.peer.send(JSON.stringify({
      type: 'sealed.packet', protocol: BYOC_SEALED_PROTOCOL, contentType: 'http.request',
      packet: record.toString('base64'),
    }));
    await vi.waitFor(() => expect(
      run.phoneWire.control.readyState !== 1 || run.frames.some((frame) => frame.requestId === 'fake-sealed'),
    ).toBe(true));
    expect(run.fetched).toEqual([]);
    expect(run.phoneWire.control.readyState).not.toBe(1);
  });

  it('refuses offline or wrong-workspace ingress without opening a channel', () => {
    const socket = new WireSocket([]);
    const open = vi.fn();
    const port = { appConnector: () => null, openAppChannel: open };
    expect(attachSealedDeviceSocket(port, 'offline', socket)).toBe(false);
    expect(socket.closeReason).toBe('workspace_offline');
    expect(open).not.toHaveBeenCalled();
  });

  it('closes an attached phone when its outbound workspace connector disconnects', async () => {
    const run = await assembled();
    run.broker.closeGeneration(binding, 4001, 'connector_gone');
    await vi.waitFor(() => expect(run.phoneWire.control.closeReason).toBe('workspace_offline'));
  });
});
