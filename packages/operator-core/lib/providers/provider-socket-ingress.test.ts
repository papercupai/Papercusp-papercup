/**
 * Host-held socket ingress (cupboard-distributable-integrations-2026-10-10 P-003, D-009):
 * the host opens the declared socket with the stored credential, acks before normalizing,
 * reconnects on a declared value, never hands the credential to provider code, and admits
 * normalized records through the connector admission path.
 */
import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { ProviderDescriptor, ProviderInvokeRequest, ProviderRecord } from '@papercusp/plugin-sdk';
import type { ProviderRegistry, RegisteredProvider } from '../integrations/provider-registry';
import type { ConnectorSourceRow } from './connector-runtime';
import {
  openIngressSocketUrl,
  ProviderSocketIngressManager,
  socketIngressProviders,
  type IngressSocketLike,
  type IngressSourceHealth,
} from './provider-socket-ingress';

const APP_TOKEN = 'xapp-1-secret-value';

const descriptor: ProviderDescriptor = {
  id: 'example-chat',
  contractVersion: 1,
  datatypes: ['chat-message'],
  capabilities: ['chat.send', 'ingress.normalize'],
  egressHosts: ['api.example.com'],
  setup: { credentials: [{ key: 'app_token', label: 'App token' }] },
  ingress: {
    socket: {
      credential: 'app_token',
      open: { url: 'https://api.example.com/apps.connections.open', urlField: 'url' },
      ackField: 'envelope_id',
      reconnect: { field: 'type', values: ['disconnect'] },
    },
  },
};

const source: ConnectorSourceRow = {
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: 'ws-test',
  kind: 'example-chat',
  ownerUserId: null,
  credentialRef: 'provider-setup:example-chat',
  status: 'connected',
  config: {},
  cursor: {},
  backfillStatus: 'complete',
  failureCount: 0,
  wakeRequestedAt: null,
};

class FakeSocket implements IngressSocketLike {
  readonly sent: string[] = [];
  readonly order: string[];
  closed = false;
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();
  constructor(readonly url: string, order: string[]) { this.order = order; }
  on(event: string, listener: (...args: any[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  send(payload: string): void {
    this.sent.push(payload);
    this.order.push(`ack:${payload}`);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', 1000);
  }
}

interface Harness {
  manager: ProviderSocketIngressManager;
  sockets: FakeSocket[];
  invokes: ProviderInvokeRequest[];
  admitted: ProviderRecord[];
  health: IngressSourceHealth[];
  opens: Array<{ url: string; init: RequestInit | undefined }>;
  order: string[];
  logs: string[];
}

function harness(opts: {
  records?: (envelope: Record<string, unknown>) => unknown[];
  credential?: string | null;
  openResponse?: () => Response;
  descriptor?: ProviderDescriptor;
  sources?: () => ConnectorSourceRow[];
  /** Holds normalizing of an envelope until the returned promise settles. */
  gate?: (envelope: Record<string, unknown>) => Promise<void>;
} = {}): Harness {
  const sockets: FakeSocket[] = [];
  const invokes: ProviderInvokeRequest[] = [];
  const admitted: ProviderRecord[] = [];
  const health: IngressSourceHealth[] = [];
  const opens: Harness['opens'] = [];
  const order: string[] = [];
  const logs: string[] = [];
  const provider = {
    descriptor: opts.descriptor ?? descriptor,
    adapter: {
      describe: () => opts.descriptor ?? descriptor,
      syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
      invoke: async (request: ProviderInvokeRequest) => {
        invokes.push(request);
        order.push('normalize');
        const envelope = request.args.envelope as Record<string, unknown>;
        await opts.gate?.(envelope);
        return { records: opts.records ? opts.records(envelope) : [] };
      },
    },
  } as unknown as RegisteredProvider;
  const registry = { list: () => [provider] } as unknown as ProviderRegistry;
  const manager = new ProviderSocketIngressManager({
    sql: {} as postgres.Sql,
    workspaceId: () => 'ws-test',
    registry: async () => registry,
    listSources: async (_sql, _ws, kinds) => (kinds.includes(source.kind) ? (opts.sources?.() ?? [source]) : []),
    readCredential: async (_provider, _harness, key) => (key === 'app_token' ? (opts.credential === undefined ? APP_TOKEN : opts.credential) : null),
    fetch: (async (url: string, init?: RequestInit) => {
      opens.push({ url, init });
      return opts.openResponse ? opts.openResponse() : new Response(JSON.stringify({ ok: true, url: `wss://socket.example.com/link?n=${opens.length}` }), { status: 200 });
    }) as unknown as typeof fetch,
    createSocket: (url) => {
      const socket = new FakeSocket(url, order);
      sockets.push(socket);
      return socket;
    },
    hostFetchFor: () => async () => ({ status: 200, headers: {}, body: '{}', bodyEncoding: 'utf8' }),
    admit: async (_sql, input) => {
      admitted.push(input.record);
      return 'admitted';
    },
    updateSource: async (_sql, _row, input) => { health.push(input); },
    log: (message) => logs.push(message),
  });
  return { manager, sockets, invokes, admitted, health, opens, order, logs };
}

const record = (nativeId: string): ProviderRecord => ({
  datatype: 'chat-message',
  nativeId,
  event: 'message.posted',
  payload: { text: `hello ${nativeId}` },
});

describe('provider socket ingress (P-003, D-009)', () => {
  it('opens the declared socket with the stored credential as a bearer, and only there', async () => {
    const h = harness();
    await h.manager.reconcile();
    expect(h.opens).toHaveLength(1);
    expect(h.opens[0]!.url).toBe('https://api.example.com/apps.connections.open');
    expect(h.opens[0]!.init?.method).toBe('POST');
    expect((h.opens[0]!.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${APP_TOKEN}`);
    expect(h.sockets.map((s) => s.url)).toEqual(['wss://socket.example.com/link?n=1']);
    // A second reconcile keeps the live connection instead of opening another.
    await h.manager.reconcile();
    expect(h.sockets).toHaveLength(1);
  });

  it('acks each envelope before normalizing it, and admits the normalized records', async () => {
    const h = harness({ records: (envelope) => (envelope.type === 'events_api' ? [record('m1'), record('m2')] : []) });
    await h.manager.reconcile();
    const socket = h.sockets[0]!;
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ envelope_id: 'env-1', type: 'events_api', payload: { text: 'hi' } })));
    await vi.waitFor(() => expect(h.admitted.map((r) => r.nativeId)).toEqual(['m1', 'm2']));
    expect(socket.sent).toEqual([JSON.stringify({ envelope_id: 'env-1' })]);
    expect(h.order.slice(0, 2)).toEqual([`ack:${JSON.stringify({ envelope_id: 'env-1' })}`, 'normalize']);
    expect(h.health[0]).toEqual({ status: 'connected', lastError: null, connected: true });
  });

  it('never hands the credential to provider code', async () => {
    const h = harness({ records: () => [record('m1')] });
    await h.manager.reconcile();
    h.sockets[0]!.emit('message', JSON.stringify({ envelope_id: 'env-2', type: 'events_api' }));
    await vi.waitFor(() => expect(h.invokes).toHaveLength(1));
    // The source's config rides along so the provider can apply source-scoped rules (D-023).
    expect(h.invokes[0]).toEqual({
      source: source.id,
      capability: 'ingress.normalize',
      args: { envelope: { envelope_id: 'env-2', type: 'events_api' }, sourceConfig: source.config },
    });
    expect(JSON.stringify(h.invokes)).not.toContain(APP_TOKEN);
    expect(h.logs.join('\n')).not.toContain(APP_TOKEN);
  });

  it('uses refreshed source config on an existing socket after source reconciliation', async () => {
    let currentSource: ConnectorSourceRow = { ...source, config: { allowedBot: 'bot-old' } };
    const h = harness({
      sources: () => [currentSource],
      records: (envelope) => [record(String(envelope.type))],
    });
    await h.manager.reconcile();
    const socket = h.sockets[0]!;

    socket.emit('message', JSON.stringify({ envelope_id: 'env-old', type: 'before-update' }));
    await vi.waitFor(() => expect(h.invokes).toHaveLength(1));
    expect(h.invokes[0]!.args.sourceConfig).toEqual({ allowedBot: 'bot-old' });

    currentSource = { ...source, config: { allowedBot: 'bot-new' } };
    await h.manager.reconcile();
    expect(h.sockets).toEqual([socket]);
    expect(socket.closed).toBe(false);

    socket.emit('message', JSON.stringify({ envelope_id: 'env-new', type: 'after-update' }));
    await vi.waitFor(() => expect(h.invokes).toHaveLength(2));
    expect(h.invokes[1]!.args.sourceConfig).toEqual({ allowedBot: 'bot-new' });
  });

  it('opens a fresh socket at once when an envelope carries a declared reconnect value', async () => {
    const h = harness();
    await h.manager.reconcile();
    h.sockets[0]!.emit('message', JSON.stringify({ envelope_id: 'env-3', type: 'disconnect', reason: 'refresh_requested' }));
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.sockets[0]!.sent).toEqual([JSON.stringify({ envelope_id: 'env-3' })]);
    expect(h.opens).toHaveLength(2);
    expect(h.invokes).toEqual([]);
  });

  it('normalizes a declared immediate envelope at once instead of behind a slow one (D-025)', async () => {
    const envelopeIds = (h: Harness) => h.invokes.map((invoke) => (invoke.args.envelope as { envelope_id: string }).envelope_id);
    const run = async (socketDescriptor: ProviderDescriptor) => {
      let release!: () => void;
      const slow = new Promise<void>((resolveSlow) => { release = resolveSlow; });
      const h = harness({
        descriptor: socketDescriptor,
        gate: (envelope) => (envelope.envelope_id === 'env-slow' ? slow : Promise.resolve()),
        records: (envelope) => [record(String(envelope.envelope_id))],
      });
      await h.manager.reconcile();
      const socket = h.sockets[0]!;
      socket.emit('message', JSON.stringify({ envelope_id: 'env-slow', type: 'events_api' }));
      socket.emit('message', JSON.stringify({ envelope_id: 'env-queued', type: 'events_api' }));
      socket.emit('message', JSON.stringify({ envelope_id: 'env-click', type: 'interactive' }));
      // Every envelope is acked on arrival, whichever chain normalizes it.
      expect(socket.sent).toHaveLength(3);
      return { h, release };
    };

    const immediate = await run({
      ...descriptor,
      ingress: { socket: { ...descriptor.ingress!.socket!, immediate: { field: 'type', values: ['interactive'] } } },
    });
    await vi.waitFor(() => expect(immediate.h.admitted.map((r) => r.nativeId)).toEqual(['env-click']));
    // The serialized chain still holds the envelope that arrived behind the slow one.
    expect(envelopeIds(immediate.h)).toEqual(['env-slow', 'env-click']);
    immediate.release();
    await vi.waitFor(() => expect(immediate.h.admitted.map((r) => r.nativeId)).toEqual(['env-click', 'env-slow', 'env-queued']));

    // Control: without the declaration the click waits its turn behind the slow envelope.
    const serialized = await run(descriptor);
    await vi.waitFor(() => expect(envelopeIds(serialized.h)).toEqual(['env-slow']));
    await new Promise((settle) => setTimeout(settle, 20));
    expect(serialized.h.admitted).toEqual([]);
    serialized.release();
    await vi.waitFor(() => expect(serialized.h.admitted.map((r) => r.nativeId)).toEqual(['env-slow', 'env-queued', 'env-click']));
  });

  it('backs off after an unexpected close instead of reconnecting in a loop', async () => {
    let now = 1_000_000;
    const h = harness();
    (h.manager as unknown as { deps: { now: () => number } }).deps.now = () => now;
    await h.manager.reconcile();
    h.sockets[0]!.close();
    expect(h.health.at(-1)).toEqual({ status: 'degraded', lastError: 'socket_closed:1000' });
    await h.manager.reconcile();
    expect(h.sockets).toHaveLength(1);
    now += 1_500;
    await h.manager.reconcile();
    expect(h.sockets).toHaveLength(2);
  });

  it('marks the source reconnect-required when the credential is missing or refused', async () => {
    const missing = harness({ credential: null });
    await missing.manager.reconcile();
    expect(missing.opens).toEqual([]);
    expect(missing.health).toEqual([{ status: 'error', lastError: 'reconnect_required: credential_not_configured:app_token' }]);

    const refused = harness({ openResponse: () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 }) });
    await refused.manager.reconcile();
    expect(refused.sockets).toEqual([]);
    expect(refused.health).toEqual([{ status: 'error', lastError: 'reconnect_required: socket_open_refused:invalid_auth' }]);

    const unauthorized = harness({ openResponse: () => new Response('{}', { status: 401 }) });
    await unauthorized.manager.reconcile();
    expect(unauthorized.health[0]!.status).toBe('error');
  });

  it('refuses a normalized record with an undeclared datatype and reports it on the source', async () => {
    const h = harness({ records: () => [{ ...record('m9'), datatype: 'calendar-event' }] });
    await h.manager.reconcile();
    h.sockets[0]!.emit('message', JSON.stringify({ envelope_id: 'env-4', type: 'events_api' }));
    await vi.waitFor(() => expect(h.health.some((entry) => entry.lastError?.startsWith('ingress_envelope_failed:'))).toBe(true));
    expect(h.admitted).toEqual([]);
  });

  it('never claims a source of the same kind that was connected another way (WI-6554700010008468)', async () => {
    // The in-app Slack path writes `slack-socket:<field>`; an OAuth connect `<plugin>:<field>`.
    const inApp: ConnectorSourceRow = { ...source, id: '00000000-0000-4000-8000-000000000002', credentialRef: 'slack-socket:bot_token' };
    const oauth: ConnectorSourceRow = { ...source, id: '00000000-0000-4000-8000-000000000003', credentialRef: 'provider:example-chat:owner' };

    // No credential pasted: the other paths' sources get no health write at all.
    const unpasted = harness({ credential: null, sources: () => [inApp, oauth] });
    await unpasted.manager.reconcile();
    expect(unpasted.opens).toEqual([]);
    expect(unpasted.health).toEqual([]);

    // Credential pasted: only the pasted-credential source gets a socket.
    const pasted = harness({ sources: () => [inApp, source, oauth] });
    await pasted.manager.reconcile();
    expect(pasted.opens).toHaveLength(1);
    expect(pasted.sockets).toHaveLength(1);
    expect(pasted.manager.size).toBe(1);
    pasted.sockets[0]!.emit('message', JSON.stringify({ envelope_id: 'env-5', type: 'events_api' }));
    await vi.waitFor(() => expect(pasted.invokes).toHaveLength(1));
    expect(pasted.invokes[0]!.source).toBe(source.id);
  });

  it('closes the socket of a source that is no longer connected', async () => {
    let live = true;
    const h = harness({ sources: () => (live ? [source] : []) });
    await h.manager.reconcile();
    live = false;
    await h.manager.reconcile();
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.manager.size).toBe(0);
  });

  it('only manages providers that declare both the socket and ingress.normalize', () => {
    const registry = (descriptors: ProviderDescriptor[]) =>
      ({ list: () => descriptors.map((d) => ({ descriptor: d })) }) as unknown as ProviderRegistry;
    expect(socketIngressProviders(registry([descriptor])).map((p) => p.provider.descriptor.id)).toEqual(['example-chat']);
    expect(socketIngressProviders(registry([{ ...descriptor, capabilities: ['chat.send'] }]))).toEqual([]);
    expect(socketIngressProviders(registry([{ ...descriptor, ingress: undefined }]))).toEqual([]);
  });

  it('reads the socket URL at the declared dot path and refuses a non-socket URL', async () => {
    const socket = { ...descriptor.ingress!.socket, open: { url: 'https://api.example.com/open', method: 'GET' as const, urlField: 'data.link' } };
    const ok = (async () => new Response(JSON.stringify({ data: { link: 'wss://s.example.com/1' } }))) as unknown as typeof fetch;
    await expect(openIngressSocketUrl(socket, APP_TOKEN, ok)).resolves.toBe('wss://s.example.com/1');
    const http = (async () => new Response(JSON.stringify({ data: { link: 'https://s.example.com/1' } }))) as unknown as typeof fetch;
    await expect(openIngressSocketUrl(socket, APP_TOKEN, http)).rejects.toThrow('socket_open_no_url:data.link');
  });
});
