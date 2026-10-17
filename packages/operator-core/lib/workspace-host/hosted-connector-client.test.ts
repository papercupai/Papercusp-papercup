import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  HostedWorkspaceConnectorClient,
  HOSTED_CONNECTOR_REVOKED_CLOSE_CODE,
  readBoundBinding,
  type HostedConnectorClientSocket,
} from './hosted-connector-client';

type Listeners = {
  open: Array<() => void>;
  message: Array<(data: unknown, isBinary: boolean) => void>;
  close: Array<(code: number, reason: unknown) => void>;
  error: Array<(error: unknown) => void>;
  ping: Array<() => void>;
  pong: Array<() => void>;
};

class FakeSocket implements HostedConnectorClientSocket {
  readonly OPEN = 1;
  readyState = 0;
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  pingsSent = 0;
  terminated = false;
  private readonly listeners: Listeners = { open: [], message: [], close: [], error: [], ping: [], pong: [] };

  constructor(readonly url: string, readonly headers: Record<string, string>) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) };
  }

  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: (code: number, reason: unknown) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'ping' | 'pong', listener: () => void): unknown;
  on(event: keyof Listeners, listener: never): unknown {
    (this.listeners[event] as unknown[]).push(listener);
    return this;
  }

  /** Drive the socket the way `ws` would. */
  emitOpen(): void {
    this.readyState = this.OPEN;
    for (const fn of this.listeners.open) fn();
  }
  emitMessage(value: unknown, isBinary = false): void {
    const payload = typeof value === 'string' ? value : JSON.stringify(value);
    for (const fn of this.listeners.message) fn(payload, isBinary);
  }
  emitClose(code: number, reason = ''): void {
    this.readyState = 3;
    for (const fn of this.listeners.close) fn(code, reason);
  }
  /** A ping from the control plane (`ws` auto-answers it). */
  emitPing(): void {
    for (const fn of this.listeners.ping) fn();
  }
  /** The control plane's answer to one of our pings. */
  emitPong(): void {
    for (const fn of this.listeners.pong) fn();
  }
  ping(): void {
    this.pingsSent += 1;
  }
  /** Like `ws`: a hard teardown that still emits `close` afterwards. */
  terminate(): void {
    this.terminated = true;
    this.emitClose(1006);
  }
}

const BINDING = {
  controlPlaneWorkspaceId: 'cp-ws',
  organizationId: 'org_1',
  customerWorkspaceId: 'cust_1',
  hostId: 'host_1',
  routeLabel: 'acme',
  generation: 3,
  transport: 'websocket',
  state: 'active',
} as const;

function harness(overrides: Partial<Parameters<typeof makeClient>[0]> = {}) {
  return makeClient(overrides);
}

function makeClient(overrides: Record<string, unknown> = {}) {
  const sockets: FakeSocket[] = [];
  const envelopes: unknown[] = [];
  const bound: unknown[] = [];
  const terminal: Array<{ reason: string; detail: string }> = [];
  const disconnects: string[] = [];
  const client = new HostedWorkspaceConnectorClient({
    url: 'wss://app.papercusp.com/api/hosted/connectors/socket',
    bearer: 'bearer-secret',
    onEnvelope: (envelope) => envelopes.push(envelope),
    onBound: (binding) => bound.push(binding),
    onDisconnect: (reason) => disconnects.push(reason),
    onTerminal: (reason, detail) => terminal.push({ reason, detail }),
    createSocket: (url, headers) => {
      const socket = new FakeSocket(url, headers);
      sockets.push(socket);
      return socket;
    },
    minBackoffMs: 10,
    maxBackoffMs: 1000,
    random: () => 1,
    ...overrides,
  });
  return { client, sockets, envelopes, bound, terminal, disconnects };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('readBoundBinding', () => {
  it('reads the control-plane-supplied binding', () => {
    expect(readBoundBinding({ type: 'bound', role: 'connector', binding: BINDING })).toMatchObject({
      organizationId: 'org_1',
      generation: 3,
    });
  });

  it('refuses a browser-role bound frame', () => {
    // A connector must never adopt the identity the broker sends to a BROWSER
    // socket: that frame carries a ticket binding for one user, not this host.
    expect(readBoundBinding({ type: 'bound', role: 'browser', binding: BINDING })).toBeNull();
  });

  it('refuses a malformed binding rather than throwing', () => {
    // The control plane is separately deployed across a real version skew, so an
    // unrecognised frame must degrade to "not bound", never crash the host.
    expect(readBoundBinding({ type: 'bound', role: 'connector', binding: { organizationId: 'org_1' } })).toBeNull();
    expect(readBoundBinding({ type: 'bound', role: 'connector', binding: { ...BINDING, generation: 'three' } })).toBeNull();
    expect(readBoundBinding('nonsense')).toBeNull();
  });
});

describe('HostedWorkspaceConnectorClient', () => {
  it('reuses its live heartbeat for workload sampling and stops sampling after disconnect', async () => {
    const heartbeat = vi.fn();
    const { client, sockets } = harness({ onHeartbeat: heartbeat, pingIntervalMs: 1000 });
    client.start(); sockets[0]!.emitOpen();
    await vi.advanceTimersByTimeAsync(1000);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    client.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });

  it('dials the configured url with the bearer in an Authorization header', () => {
    const { client, sockets } = harness();
    client.start();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe('wss://app.papercusp.com/api/hosted/connectors/socket');
    expect(sockets[0]!.headers).toEqual({ Authorization: 'Bearer bearer-secret' });
  });

  it('routes a bound frame to onBound and everything else to onEnvelope', () => {
    const { client, sockets, bound, envelopes } = harness();
    client.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage({ type: 'bound', role: 'connector', protocol: 'papercusp-hosted-workspace.v1', binding: BINDING });
    sockets[0]!.emitMessage({ type: 'relay.open', channelId: 'c1', userId: 'u1', hostedSessionId: 's1', audience: 'workspace-operator', role: 'controller' });
    expect(bound).toHaveLength(1);
    expect(envelopes).toEqual([
      { type: 'relay.open', channelId: 'c1', userId: 'u1', hostedSessionId: 's1', audience: 'workspace-operator', role: 'controller' },
    ]);
  });

  it('drops binary and unparseable frames without disturbing the connection', () => {
    const { client, sockets, envelopes } = harness();
    client.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage('{ not json', false);
    sockets[0]!.emitMessage({ type: 'relay' }, true);
    expect(envelopes).toEqual([]);
    expect(client.connected).toBe(true);
  });

  it('serialises outbound envelopes, and drops them without throwing while disconnected', () => {
    const { client, sockets } = harness();
    // Before start: no socket at all. The adapter emits relay.close from teardown
    // paths, so a throw here would strand the channel it was closing.
    expect(client.send({ type: 'relay.close', channelId: 'c1', reason: 'x' })).toBe(false);
    client.start();
    expect(client.send({ type: 'relay.close', channelId: 'c1', reason: 'x' })).toBe(false);
    sockets[0]!.emitOpen();
    expect(client.send({ type: 'relay', channelId: 'c1', payload: { type: 'pty.output' } })).toBe(true);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ type: 'relay', channelId: 'c1', payload: { type: 'pty.output' } });
  });

  it('reconnects after an ordinary close', () => {
    const { client, sockets, disconnects } = harness();
    client.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitClose(1006, 'abnormal');
    expect(disconnects).toHaveLength(1);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.headers).toEqual({ Authorization: 'Bearer bearer-secret' });
  });

  it('NEVER reconnects after a revoked close', () => {
    // The gateway closes 4001 when the binding is revoked or its generation
    // rotated. The bearer this process holds can never succeed again, so retrying
    // is an infinite authenticated-looking hammer at the control plane.
    const { client, sockets, terminal } = harness();
    client.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitClose(HOSTED_CONNECTOR_REVOKED_CLOSE_CODE, 'binding_revoked');
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(terminal).toEqual([{ reason: 'revoked', detail: '4001: binding_revoked' }]);
  });

  it('backs off exponentially and caps, then resets the cap on a successful open', () => {
    const { client, sockets } = harness({ minBackoffMs: 100, maxBackoffMs: 400 });
    client.start();
    // Fail four times without ever opening: 100, 200, 400, then capped at 400.
    for (const expected of [100, 200, 400, 400]) {
      const socket = sockets.at(-1)!;
      socket.emitClose(1006);
      vi.advanceTimersByTime(expected - 1);
      const before = sockets.length;
      vi.advanceTimersByTime(1);
      expect(sockets.length).toBe(before + 1);
    }
    // A successful OPEN resets the ladder, so the next drop waits the minimum again.
    sockets.at(-1)!.emitOpen();
    sockets.at(-1)!.emitClose(1006);
    const before = sockets.length;
    vi.advanceTimersByTime(100);
    expect(sockets.length).toBe(before + 1);
  });

  it('retries when the socket constructor itself throws', () => {
    // A bad URL or a transient DNS failure is indistinguishable from a refused
    // connection here, and must not be fatal to a long-lived host.
    let calls = 0;
    const built: string[] = [];
    const client = new HostedWorkspaceConnectorClient({
      url: 'wss://cp/api/hosted/connectors/socket',
      bearer: 'b',
      onEnvelope: () => {},
      onBound: () => {},
      minBackoffMs: 10,
      random: () => 1,
      createSocket: (url) => {
        calls += 1;
        if (calls === 1) throw new Error('EAI_AGAIN');
        built.push(url);
        return new FakeSocket(url, {});
      },
    });
    client.start();
    expect(built).toEqual([]);
    vi.advanceTimersByTime(10);
    expect(built).toEqual(['wss://cp/api/hosted/connectors/socket']);
  });

  it('stop() is terminal and idempotent', () => {
    const { client, sockets, terminal } = harness();
    client.start();
    sockets[0]!.emitOpen();
    client.stop('host_stopped');
    client.stop('host_stopped');
    expect(terminal).toEqual([{ reason: 'stopped', detail: 'host_stopped' }]);
    expect(sockets[0]!.closedWith).toEqual({ code: 1000, reason: 'host_stopped' });
    // A close event arriving after stop must not resurrect the client.
    sockets[0]!.emitClose(1006);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('start() is idempotent — a second call cannot leave two live sockets racing', () => {
    const { client, sockets } = harness();
    client.start();
    client.start();
    sockets[0]!.emitOpen();
    client.start();
    expect(sockets).toHaveLength(1);
  });

  it('fires onBound on every reconnect, because a reconnect can carry a new generation', () => {
    const { client, sockets, bound } = harness();
    client.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage({ type: 'bound', role: 'connector', binding: BINDING });
    sockets[0]!.emitClose(1006);
    vi.advanceTimersByTime(10);
    sockets[1]!.emitOpen();
    sockets[1]!.emitMessage({ type: 'bound', role: 'connector', binding: { ...BINDING, generation: 4 } });
    expect(bound).toHaveLength(2);
    expect((bound[1] as { generation: number }).generation).toBe(4);
  });

  it('ignores a close from a socket it has already replaced', () => {
    // Without the identity guard a late close from the OLD socket would schedule a
    // second reconnect, and two live sockets would deliver envelopes into one adapter.
    const { client, sockets } = harness();
    client.start();
    const first = sockets[0]!;
    first.emitClose(1006);
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);
    first.emitClose(1006);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
  });
});

describe('HostedWorkspaceConnectorClient liveness watchdog (P-002)', () => {
  // Defaults on purpose: 25s ping cadence, 75s of silence before the socket is declared dead.

  it('pings the control plane on its own cadence while the link is open', () => {
    const { client, sockets } = harness();
    client.start();
    sockets[0]!.emitOpen();
    vi.advanceTimersByTime(25_000);
    expect(sockets[0]!.pingsSent).toBe(1);
    sockets[0]!.emitPong();
    vi.advanceTimersByTime(25_000);
    expect(sockets[0]!.pingsSent).toBe(2);
  });

  it('terminates a silent open socket and reconnects exactly once (the half-open case)', () => {
    // `ws` never emits close for a link that died without a FIN/RST, so without the
    // watchdog this socket would stay "open" forever and nothing would reconnect.
    const { client, sockets, disconnects } = harness();
    client.start();
    sockets[0]!.emitOpen();
    vi.advanceTimersByTime(74_999);
    expect(sockets[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sockets[0]!.terminated).toBe(true);
    expect(client.connected).toBe(false);
    expect(disconnects).toEqual([expect.stringMatching(/^liveness_timeout: no inbound frame for 75s$/)]);
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);
    // The close that terminate() emits must not schedule a second reconnect.
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    expect(disconnects).toHaveLength(1);
  });

  it('stays connected while pongs, control-plane pings or messages keep arriving', () => {
    const { client, sockets } = harness();
    client.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(50_000);
      socket.emitPong();
    }
    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(50_000);
      socket.emitPing();
    }
    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(50_000);
      socket.emitMessage({ type: 'noop' });
    }
    expect(socket.terminated).toBe(false);
    expect(sockets).toHaveLength(1);
    expect(client.connected).toBe(true);
  });

  it('reaps a handshake that never completes, without pinging it', () => {
    const { client, sockets } = harness();
    client.start();
    vi.advanceTimersByTime(75_000);
    expect(sockets[0]!.terminated).toBe(true);
    expect(sockets[0]!.pingsSent).toBe(0);
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);
  });

  it('falls back to close() when the socket has no terminate()', () => {
    const { client, sockets } = harness();
    client.start();
    const socket = sockets[0]!;
    (socket as { terminate?: unknown }).terminate = undefined;
    socket.emitOpen();
    vi.advanceTimersByTime(75_000);
    expect(socket.closedWith).toEqual({ code: 4000, reason: 'liveness_timeout' });
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);
  });

  it('disarms the watchdog on stop()', () => {
    const { client, sockets } = harness();
    client.start();
    sockets[0]!.emitOpen();
    client.stop();
    vi.advanceTimersByTime(300_000);
    expect(sockets[0]!.terminated).toBe(false);
    expect(sockets[0]!.pingsSent).toBe(0);
    expect(sockets).toHaveLength(1);
  });

  it('honours injected cadence and timeout', () => {
    const { client, sockets } = harness({ pingIntervalMs: 1_000, silenceTimeoutMs: 3_000 });
    client.start();
    sockets[0]!.emitOpen();
    vi.advanceTimersByTime(2_000);
    expect(sockets[0]!.pingsSent).toBe(2);
    vi.advanceTimersByTime(1_000);
    expect(sockets[0]!.terminated).toBe(true);
  });
});
