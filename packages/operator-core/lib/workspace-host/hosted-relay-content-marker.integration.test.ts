/**
 * P-003, hosted-byoc-confidentiality-correction-2026-10-02.
 *
 * This is the assembled, in-process negative control for the BYOC confidentiality
 * promise. The broker, outbound connector client, and workspace host adapter all
 * run here; only the WebSocket, PTY, desktop, and local HTTP peers are fakes.
 * The wire tap is on the control-plane side of each socket, before its JSON parser.
 *
 * The original plaintext relay leaked markers on every content plane. Current
 * BYOC sessions use sealed packets, so the negative control deliberately adds
 * plaintext frames to the captured surface and proves the same leak oracle
 * would catch a regression without weakening the sealed-path assertion.
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import SecretStream from '@hyperswarm/secret-stream';
import { HostedWorkspaceSessionBroker } from '../endpoint-route/hosted-workspace-session';
import type {
  HostedConnectorBinding,
  HostedConnectorTicketBinding,
} from '../endpoint-route/hosted-workspace-connector';
import { HostedWorkspaceConnectorClient } from './hosted-connector-client';
import { ByocSealedChannel, isByocSealedPacket } from './byoc-sealed-channel';
import {
  HostedWorkspaceHostSessionAdapter,
  type HostedDesktopBackend,
  type HostedDesktopSocket,
  type HostedHostPty,
} from './hosted-session-host';

type Capture = { surface: string; bytes: string };
type Plane = 'pty' | 'file' | 'operator-http' | 'app-http' | 'desktop';
const PLANES: Plane[] = ['pty', 'file', 'operator-http', 'app-http', 'desktop'];
const marker = (plane: Plane) => 'BYOC_SECRET_' + plane.replace('-', '_') + '_7e91';

function encodings(value: string): string[] {
  return [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('hex'), encodeURIComponent(value)];
}

function recoverable(captures: Capture[], value: string): Capture[] {
  const forms = encodings(value);
  return captures.filter((entry) => {
    const pending = [entry.bytes];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const text = pending.shift()!;
      if (seen.has(text)) continue;
      seen.add(text);
      if (forms.some((form) => text.includes(form))) return true;
      // A whole JSON body is often base64-encoded. Searching for base64(marker)
      // alone misses it because the marker starts at a different byte offset.
      try {
        const parsed: unknown = JSON.parse(text);
        const strings = (node: unknown): void => {
          if (typeof node === 'string') pending.push(node);
          else if (Array.isArray(node)) node.forEach(strings);
          else if (node && typeof node === 'object') Object.values(node).forEach(strings);
        };
        strings(parsed);
      } catch {
        /* a raw wire fragment need not be JSON */
      }
      if (/^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length >= 12) {
        const decoded = Buffer.from(text, 'base64');
        if (decoded.toString('base64').replace(/=+$/, '') === text.replace(/=+$/, '')) {
          pending.push(decoded.toString('utf8'));
        }
      }
      if (/^(?:[a-fA-F0-9]{2}){6,}$/.test(text)) pending.push(Buffer.from(text, 'hex').toString('utf8'));
      if (text.includes('%')) {
        try {
          pending.push(decodeURIComponent(text));
        } catch {
          /* malformed encoding */
        }
      }
    }
    return false;
  });
}

/** A pair of real EventEmitter socket surfaces with a tap at the broker boundary. */
class WireSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  peer?: WireSocket;
  constructor(
    private readonly surface: string,
    private readonly direction: string,
    private readonly captures: Capture[],
  ) {
    super();
  }
  send(data: string | Buffer): void {
    const bytes = data.toString();
    this.captures.push({ surface: this.surface + ':' + this.direction, bytes });
    queueMicrotask(() => {
      const peer = this.peer;
      if (this.readyState === this.OPEN && peer && peer.readyState === peer.OPEN) {
        peer.emit('message', Buffer.from(bytes), false);
      }
    });
  }
  close(_code?: number, _reason?: string): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    const peer = this.peer;
    if (peer) peer.readyState = 3;
    this.emit('close', 1000, Buffer.alloc(0));
    peer?.emit('close', 1000, Buffer.alloc(0));
  }
}

function sockets(surface: string, captures: Capture[]) {
  const control = new WireSocket(surface, 'control-to-peer', captures);
  const peer = new WireSocket(surface, 'peer-to-control', captures);
  control.peer = peer;
  peer.peer = control;
  return { control, peer };
}

class MarkerPty extends EventEmitter implements HostedHostPty {
  readonly writes: Buffer[] = [];
  write(data: Buffer) {
    this.writes.push(data);
    return true;
  }
  resize() {
    return true;
  }
  signal() {
    return true;
  }
  kill() {}
  snapshot() {
    return Promise.resolve('');
  }
  onData(listener: (data: Buffer) => void) {
    this.on('data', listener);
    return () => this.off('data', listener);
  }
  onExit(listener: (code: number, signal: number) => void) {
    this.on('exit', listener);
    return () => this.off('exit', listener);
  }
  output(value: string) {
    this.emit('data', Buffer.from(value));
  }
}

class MarkerDesktopSocket extends EventEmitter implements HostedDesktopSocket {
  readonly writes: Buffer[] = [];
  send(data: Buffer) {
    this.writes.push(data);
    return true;
  }
  close() {
    this.emit('close', 'closed');
  }
  onData(listener: (data: Buffer) => void) {
    this.on('data', listener);
    return () => this.off('data', listener);
  }
  onClose(listener: (reason: string) => void) {
    this.on('close', listener);
    return () => this.off('close', listener);
  }
  output(value: string) {
    this.emit('data', Buffer.from(value));
  }
}

const binding: HostedConnectorBinding = {
  controlPlaneWorkspaceId: 'control-1',
  organizationId: 'org-1',
  customerWorkspaceId: 'byoc-workspace-1',
  hostId: 'byoc-host-1',
  routeLabel: 'byoc',
  generation: 7,
  transport: 'websocket',
  state: 'active',
  hosting: 'byoc',
};
const ticket: HostedConnectorTicketBinding = {
  ...binding,
  kind: 'session',
  userId: 'user-1',
  hostedSessionId: 'session-1',
  audience: 'workspace-operator',
  expiresAt: new Date('2030-01-01'),
};

async function settle(pending: Array<Promise<void>>): Promise<void> {
  for (let turn = 0; turn < 8; turn++) {
    await Promise.all(pending.splice(0));
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (pending.length === 0) return;
  }
  throw new Error('assembled relay did not settle');
}

async function runAssembledByoc(untrustedEndpoint = false, terminalKind: 'pty' | 'psu' = 'pty') {
  const root = await mkdtemp(join(tmpdir(), 'byoc-marker-'));
  const captures: Capture[] = [];
  const pending: Array<Promise<void>> = [];
  const ptys: MarkerPty[] = [];
  const psuSpawns: string[][] = [];
  const desktopSockets: MarkerDesktopSocket[] = [];
  const fetched: Array<{ url: string; body: string }> = [];
  const brokerAudit: unknown[] = [];
  const hostAudit: unknown[] = [];
  const hostWarnings: string[] = [];
  const controlLogs: string[] = [];
  let adapter: HostedWorkspaceHostSessionAdapter | undefined;
  let channel = 0;
  const clientKey = SecretStream.keyPair(Buffer.alloc(32, 41));
  const hostKey = SecretStream.keyPair(Buffer.alloc(32, 42));
  const desktop: HostedDesktopBackend = {
    lookup: async () => ({
      endpoint: { host: '127.0.0.1', port: 6901 },
      credentials: { view: { user: 'view', secret: 'v' }, control: { user: 'control', secret: 'c' } },
    }),
    dial: async () => {
      const socket = new MarkerDesktopSocket();
      desktopSockets.push(socket);
      return socket;
    },
    heartbeat: () => {},
    roster: async () => [{ desktopSessionId: 'desktop-1', state: 'ready' }],
    thumbnail: async () => null,
    start: async () => ({ desktopSessionId: 'desktop-1', state: 'ready' }),
  };
  const connectorWire = sockets('connector-wire', captures);
  const client = new HostedWorkspaceConnectorClient({
    url: 'wss://control.example.test/api/hosted/connectors/socket',
    bearer: 'fixture-bearer',
    createSocket: () => connectorWire.peer,
    onBound: (actualBinding) => {
      adapter = new HostedWorkspaceHostSessionAdapter({
        binding: actualBinding,
        workspaceRoot: root,
        send: (envelope) => {
          client.send(envelope);
        },
        createPty: (input) => {
          if (input.psu) psuSpawns.push([...input.psu.argv]);
          const pty = new MarkerPty();
          ptys.push(pty);
          return pty;
        },
        desktop,
        operatorHttp: {
          fetch: async (url, init) => {
            fetched.push({ url, body: init.body ? Buffer.from(init.body as Uint8Array).toString('utf8') : '' });
            return new Response(
              JSON.stringify({ result: marker(url.includes('agent-tools') ? 'app-http' : 'operator-http') }),
              {
                headers: { 'content-type': 'application/json' },
              },
            );
          },
        },
        onAudit: (event) => hostAudit.push(event),
        onWarning: (warning) => hostWarnings.push(warning),
        byocSealedChannel: {
          localKeyPair: hostKey,
          expectedRemotePublicKey: clientKey.publicKey,
        },
      });
    },
    onEnvelope: (envelope) => {
      if (!adapter) throw new Error('connector received relay before binding');
      pending.push(adapter.accept(envelope));
    },
    pingIntervalMs: 60_000,
  });
  const broker = new HostedWorkspaceSessionBroker({
    randomId: () => 'channel-' + ++channel,
    onAudit: (event) => brokerAudit.push(event),
    pingIntervalMs: 0,
  });
  // Console is the only log sink these three in-process components can write
  // without a full operator service. Broker onAudit is the row/telemetry sink.
  const logSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      controlLogs.push(args.map(String).join(' '));
    }),
  );
  try {
    client.start();
    broker.attachConnector(binding, connectorWire.control);
    await settle(pending);
    if (!adapter) throw new Error('broker did not bind the workspace host');

    function browser(kind: 'pty' | 'psu' | 'operator-http' | 'desktop', desktopSessionId?: string) {
      const wire = sockets(kind + '-browser-wire', captures);
      broker.attachBrowser(ticket, wire.control, {
        kind,
        sealed: true,
        ...(kind === 'psu' ? { argv: ['--agent=codex', '--no-picker'] } : {}),
        ...(desktopSessionId ? { desktopSessionId, desktopMode: 'takeover' as const } : {}),
      });
      const frames: Record<string, unknown>[] = [];
      const sealed = new ByocSealedChannel({
        initiator: true,
        localKeyPair: clientKey,
        expectedRemotePublicKey: untrustedEndpoint
          ? SecretStream.keyPair(Buffer.alloc(32, 43)).publicKey
          : hostKey.publicKey,
        sendPacket: (packet) => wire.peer.send(JSON.stringify(packet)),
        onFrame: (frame) => frames.push(frame),
        onError: (error) => hostWarnings.push(`browser sealed channel: ${error.message}`),
      });
      wire.peer.on('message', (data: unknown) => {
        try {
          const parsed: unknown = JSON.parse(Buffer.from(data as Buffer).toString('utf8'));
          if (isByocSealedPacket(parsed)) sealed.receive(parsed);
        } catch {
          /* session.bound is intentionally clear control metadata */
        }
      });
      return { sealed, frames };
    }
    const ptyBrowser = browser(terminalKind);
    if (untrustedEndpoint) {
      // Queue content before trust is established through the actual broker,
      // connector, and host. A valid connector binding cannot confer key trust.
      const opening = ptyBrowser.sealed.opened.then(() => null, (error: Error) => error.message);
      const sending = ptyBrowser.sealed.send({
        type: 'pty.input', data: Buffer.from(marker('pty')).toString('base64'),
      }).then(() => null, (error: Error) => error.message);
      await settle(pending);
      const refusal = { opening: await opening, sending: await sending };
      await settle(pending);
      return {
        root, captures, client, adapter, refusal, psuSpawns,
        receivedFrames: ptyBrowser.frames,
        hostWrites: ptys.flatMap((pty) => pty.writes),
        fetched, desktopSockets,
        delivered: Object.fromEntries(PLANES.map((plane) => [plane, false])) as Record<Plane, boolean>,
      };
    }
    await settle(pending);
    await ptyBrowser.sealed.opened;
    await ptyBrowser.sealed.send({ type: 'pty.input', data: Buffer.from(marker('pty')).toString('base64') });
    await settle(pending);
    ptys[0]?.output(marker('pty'));
    await settle(pending);
    await ptyBrowser.sealed.send(
      {
        type: 'file.write',
        requestId: 'file-1',
        path: 'marker.txt',
        encoding: 'utf8',
        data: marker('file'),
      },
    );
    await settle(pending);

    const operatorBrowser = browser('operator-http');
    await settle(pending);
    await operatorBrowser.sealed.opened;
    await operatorBrowser.sealed.send(
      {
        type: 'http.request',
        requestId: 'chat-1',
        method: 'POST',
        path: '/api/operator/conversations',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ message: marker('operator-http') })).toString('base64'),
      },
    );
    await settle(pending);

    let app!: ReturnType<HostedWorkspaceSessionBroker['openAppChannel']>;
    const appPackets: import('./byoc-sealed-channel').ByocSealedPacket[] = [];
    const appSealed = new ByocSealedChannel({
      initiator: true,
      localKeyPair: clientKey,
      expectedRemotePublicKey: hostKey.publicKey,
      sendPacket: (packet) => {
        if (!app) appPackets.push(packet);
        else if (!app.send(packet as unknown as Record<string, unknown>)) throw new Error('sealed app packet was refused');
      },
      onFrame: () => {},
      onError: (error) => hostWarnings.push(`app sealed channel: ${error.message}`),
    });
    app = broker.openAppChannel(
      { binding, lastSeenAt: new Date() },
      { onFrame: (frame) => { if (isByocSealedPacket(frame)) appSealed.receive(frame); }, onClose: () => {} },
      'app-http',
      { sealed: true },
    );
    if (!app) throw new Error('sealed app channel did not open');
    // Let relay.open build the host-side responder before delivering the
    // initiator fragment that SecretStream emitted during construction.
    await settle(pending);
    for (const packet of appPackets.splice(0)) {
      if (!app.send(packet as unknown as Record<string, unknown>)) throw new Error('sealed app handshake packet was refused');
    }
    await settle(pending);
    await Promise.race([
      appSealed.opened,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(
        `app sealed handshake stalled: ${JSON.stringify({ captures: captures.slice(-12), hostWarnings })}`,
      )), 1_000)),
    ]);
    await appSealed.send({
        type: 'http.request',
        requestId: 'app-1',
        method: 'POST',
        path: '/api/agent-tools/plans/list',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ args: marker('app-http') })).toString('base64'),
      });
    await settle(pending);

    const desktopBrowser = browser('desktop', 'desktop-1');
    await settle(pending);
    await desktopBrowser.sealed.opened;
    await desktopBrowser.sealed.send({ type: 'desktop.data', data: Buffer.from(marker('desktop')).toString('base64') });
    await settle(pending);
    desktopSockets[0]?.output(marker('desktop'));
    await settle(pending);

    captures.push({ surface: 'control-plane-audit-rows', bytes: JSON.stringify(brokerAudit) });
    captures.push({ surface: 'control-plane-telemetry', bytes: JSON.stringify(brokerAudit) });
    captures.push({ surface: 'control-plane-log-lines', bytes: JSON.stringify(controlLogs) });
    captures.push({ surface: 'host-audit-control', bytes: JSON.stringify(hostAudit) });
    captures.push({ surface: 'host-warning-log', bytes: JSON.stringify(hostWarnings) });
    return {
      root,
      captures,
      client,
      adapter,
      psuSpawns,
      delivered: {
        pty: ptys[0]?.writes.some((bytes) => bytes.toString().includes(marker('pty'))) ?? false,
        file: (await readFile(join(root, 'marker.txt'), 'utf8')) === marker('file'),
        'operator-http': fetched.some(
          (row) => row.url.includes('operator/conversations') && row.body.includes(marker('operator-http')),
        ),
        'app-http': fetched.some((row) => row.url.includes('agent-tools') && row.body.includes(marker('app-http'))),
        desktop: desktopSockets[0]?.writes.some((bytes) => bytes.toString().includes(marker('desktop'))) ?? false,
      } satisfies Record<Plane, boolean>,
    };
  } finally {
    for (const spy of logSpies) spy.mockRestore();
  }
}

describe('hosted BYOC content marker negative control (P-003)', () => {
  let run: Awaited<ReturnType<typeof runAssembledByoc>>;
  beforeAll(async () => {
    run = await runAssembledByoc();
  });
  afterAll(async () => {
    run?.client.stop();
    run?.adapter.close();
    if (run?.root) await rm(run.root, { recursive: true, force: true });
  });

  it('exercises every content plane through the assembled broker, connector, and host', () => {
    expect(PLANES.filter((plane) => run.delivered[plane])).toEqual(PLANES);
  });

  it('detects a deliberately leaked marker from every assembled content plane', () => {
    for (const plane of PLANES) {
      for (const [index, encoded] of encodings(marker(plane)).entries()) {
        const leaked = { surface: `${plane}-plaintext-negative-control-${index}`, bytes: encoded };
        expect(recoverable([...run.captures, leaked], marker(plane))).toContainEqual(leaked);
      }
    }
  });

  it('keeps every BYOC content marker unrecoverable from control-plane bytes, rows, logs and telemetry', () => {
    const leaks = PLANES.flatMap((plane) =>
      recoverable(run.captures, marker(plane)).map((capture) => ({ plane, surface: capture.surface })),
    );
    expect(leaks).toEqual([]);
  });

  it('carries an authorized psu channel through the sealed broker, connector and host without exposing terminal content', async () => {
    const psu = await runAssembledByoc(false, 'psu');
    try {
      expect(psu.psuSpawns).toEqual([['--agent=codex', '--no-picker']]);
      expect(psu.delivered.pty).toBe(true);
      expect(recoverable(psu.captures, marker('pty'))).toEqual([]);
      expect(psu.captures.some((capture) => capture.bytes.includes('"kind":"psu"'))).toBe(true);
    } finally {
      psu.client.stop();
      psu.adapter.close();
      await rm(psu.root, { recursive: true, force: true });
    }
  });

  it('refuses psu input from an endpoint that does not trust the customer host key', async () => {
    const refused = await runAssembledByoc(true, 'psu');
    try {
      expect(refused.refusal).toEqual({
        opening: 'BYOC sealed channel remote key mismatch',
        sending: 'BYOC sealed channel remote key mismatch',
      });
      expect(refused.hostWrites).toEqual([]);
      expect(refused.receivedFrames).toEqual([]);
      expect(recoverable(refused.captures, marker('pty'))).toEqual([]);
    } finally {
      refused.client.stop();
      refused.adapter.close();
      await rm(refused.root, { recursive: true, force: true });
    }
  });

  it('refuses queued customer content from an untrusted endpoint through the assembled relay and host', async () => {
    const refused = await runAssembledByoc(true);
    try {
      expect(refused.refusal).toEqual({
        opening: 'BYOC sealed channel remote key mismatch',
        sending: 'BYOC sealed channel remote key mismatch',
      });
      expect(refused.receivedFrames).toEqual([]);
      expect(refused.hostWrites).toEqual([]);
      expect(refused.fetched).toEqual([]);
      expect(refused.desktopSockets).toEqual([]);
      expect(refused.captures.flatMap((capture) => recoverable([capture], marker('pty')))).toEqual([]);
    } finally {
      refused.client.stop();
      refused.adapter.close();
      await rm(refused.root, { recursive: true, force: true });
    }
  });
});
