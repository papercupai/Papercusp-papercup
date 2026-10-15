/**
 * Host-held socket ingress for descriptor providers (cupboard-distributable-integrations-2026-10-10
 * P-003, plan decision D-009). Visible through schedule:inventory as `provider-socket-ingress`.
 *
 * A provider package declares `ingress.socket` as data. For every connected source of such a
 * provider the HOST:
 *   1. reads the declared setup credential from the provider credential store (P-001) — the value
 *      never reaches provider code;
 *   2. calls `open.url` with it as a bearer token and reads a fresh socket URL from `open.urlField`;
 *   3. holds the socket, echoes `{ [ackField]: value }` for each envelope BEFORE anything else (so a
 *      slow provider cannot miss the vendor's ack window), and opens a fresh socket when an envelope's
 *      `reconnect.field` carries one of `reconnect.values`;
 *   4. hands each envelope to the provider's `ingress.normalize` capability and admits the returned
 *      records through {@link admitConnectorRecord} — the same path a synced page takes, so dedupe,
 *      sinks and trigger bindings behave identically whichever way a record arrived.
 * Nothing here branches on a provider name.
 */
import { WebSocket } from 'ws';
import type postgres from 'postgres';
import { pinModuleState } from '@papercusp/module-singleton';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { getOrgPg } from '@papercusp/db-org';
import {
  PROVIDER_INGRESS_NORMALIZE_CAPABILITY,
  type HostFetch,
  type ProviderIngressNormalizeArgs,
  type ProviderSocketIngressDescriptor,
} from '@papercusp/plugin-sdk';
import { activeWorkspaceId } from '../workspace-registry';
import {
  readyProviderRegistry,
  type ProviderRegistry,
  type RegisteredProvider,
} from '../integrations/provider-registry';
import { isPastedCredentialSource, readProviderCredentialValue } from '../integrations/provider-credentials';
import { createSourceHostFetch } from '../integrations/source-host-fetch';
import {
  DEFAULT_SOURCE_TOKEN_HARNESS,
  updateExternalTriggerSourceSyncState,
  type ExternalTriggerSourceSyncState,
} from '../external-triggers/source-store';
import {
  admitConnectorRecord,
  assertProviderRecords,
  listActiveConnectorSources,
  ProviderSyncFailure,
  type ConnectorRecordAdmission,
  type ConnectorSourceRow,
} from './connector-runtime';

/** The source-health write the manager makes (status, last error, connected-at). */
export type IngressSourceHealth = Omit<ExternalTriggerSourceSyncState, 'cursor'>;

const RECONCILE_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;

export interface IngressSocketLike {
  send(payload: string): void;
  close(): void;
  on(event: string, listener: (...args: any[]) => void): void;
}

/** A provider whose descriptor declares a socket ingress, with that declaration. */
export interface SocketIngressProvider {
  provider: RegisteredProvider;
  socket: ProviderSocketIngressDescriptor;
}

export interface ProviderSocketIngressDeps {
  sql?: postgres.Sql;
  workspaceId?: () => string;
  registry?: () => Promise<ProviderRegistry>;
  listSources?: (sql: postgres.Sql, workspaceId: string, kinds: readonly string[]) => Promise<ConnectorSourceRow[]>;
  /** Host-internal credential read (P-001 store). */
  readCredential?: (provider: RegisteredProvider, harness: string, key: string) => Promise<string | null>;
  /** The HTTP call behind `open`. */
  fetch?: typeof fetch;
  createSocket?: (url: string) => IngressSocketLike;
  /** `host.fetch` handed to `ingress.normalize`, bound to the source's provider. */
  hostFetchFor?: (provider: RegisteredProvider, source: ConnectorSourceRow, harness: string) => HostFetch;
  admit?: (
    sql: postgres.Sql,
    input: { source: ConnectorSourceRow; providerId: string; record: Parameters<typeof admitConnectorRecord>[1]['record'] },
  ) => Promise<ConnectorRecordAdmission>;
  updateSource?: (
    sql: postgres.Sql,
    source: ConnectorSourceRow,
    input: IngressSourceHealth,
  ) => Promise<unknown>;
  now?: () => number;
  log?: (message: string) => void;
}

interface Connection {
  source: ConnectorSourceRow;
  ingress: SocketIngressProvider;
  socket: IngressSocketLike;
  processing: Promise<void>;
  /**
   * The chain for envelopes the descriptor marks `immediate` (a short vendor response window):
   * they never wait behind `processing`, only behind each other.
   */
  immediate: Promise<void>;
  /** Set when an envelope announced the drop: reconnect at once instead of backing off. */
  reconnectRequested: boolean;
  /**
   * The registry the latest reconcile pass awaited ready (WI-10006703): envelope handling reuses it
   * instead of reading providerRegistry() bare, which is empty on a request-only host until plugin
   * discovery runs.
   */
  registry: ProviderRegistry;
}

/** Providers in `registry` that declare a socket ingress and the capability that normalizes it. */
export function socketIngressProviders(registry: ProviderRegistry): SocketIngressProvider[] {
  const out: SocketIngressProvider[] = [];
  for (const provider of registry.list()) {
    const socket = provider.descriptor.ingress?.socket;
    if (socket && provider.descriptor.capabilities.includes(PROVIDER_INGRESS_NORMALIZE_CAPABILITY)) out.push({ provider, socket });
  }
  return out;
}

/** The value at a dot path of a parsed JSON body, or undefined. */
export function valueAtPath(body: unknown, path: string): unknown {
  let current: unknown = body;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** A credential failure no retry can fix: the source waits for the owner to re-enter the credential. */
export class SocketIngressCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocketIngressCredentialError';
  }
}

/**
 * Ask the provider's open endpoint for a fresh socket URL. The credential goes ONLY into this
 * request's Authorization header and never into a log line or an error message.
 */
export async function openIngressSocketUrl(
  socket: ProviderSocketIngressDescriptor,
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(socket.open.url, {
    method: socket.open.method ?? 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/x-www-form-urlencoded' },
  });
  if (response.status === 401 || response.status === 403) {
    throw new SocketIngressCredentialError(`socket_open_${response.status}`);
  }
  if (!response.ok) throw new Error(`socket_open_http_${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('socket_open_not_json');
  }
  const url = valueAtPath(body, socket.open.urlField);
  if (typeof url !== 'string' || !isSocketUrl(url)) {
    // Vendors report a bad credential in the body too (Slack: 200 + `{ ok: false, error }`).
    const error = valueAtPath(body, 'error');
    if (typeof error === 'string' && /auth|token|invalid|revoked|not_allowed/i.test(error)) {
      throw new SocketIngressCredentialError(`socket_open_refused:${error.slice(0, 100)}`);
    }
    throw new Error(`socket_open_no_url:${socket.open.urlField}`);
  }
  return url;
}

function isSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'wss:' || (url.protocol === 'ws:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'));
  } catch {
    return false;
  }
}

function frameText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (Array.isArray(raw) && raw.every((part) => Buffer.isBuffer(part))) return Buffer.concat(raw).toString('utf8');
  return null;
}

function parseEnvelope(raw: unknown): Record<string, unknown> | null {
  const text = frameText(raw);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function harnessOf(source: ConnectorSourceRow): string {
  const value = source.config?.installSlug;
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_SOURCE_TOKEN_HARNESS;
}

function key(source: Pick<ConnectorSourceRow, 'workspaceId' | 'id'>): string {
  return `${source.workspaceId}\0${source.id}`;
}

export class ProviderSocketIngressManager {
  private readonly connections = new Map<string, Connection>();
  private readonly attempts = new Map<string, number>();
  private readonly retryAt = new Map<string, number>();
  private stopped = false;

  constructor(private readonly deps: ProviderSocketIngressDeps = {}) {}

  private sql(): postgres.Sql { return this.deps.sql ?? (getOrgPg().sql as unknown as postgres.Sql); }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private log(message: string): void { (this.deps.log ?? ((value) => console.warn(value)))(`[provider-socket-ingress] ${message}`); }

  /** Live connection count, for tests and inventory. */
  get size(): number { return this.connections.size; }

  private updateSource(source: ConnectorSourceRow, input: IngressSourceHealth): void {
    const update = this.deps.updateSource
      ?? ((sql, row, value) => updateExternalTriggerSourceSyncState(sql, row.workspaceId, row.id, value));
    void update(this.sql(), source, input).catch((error) => this.log(`source ${source.id} health update failed: ${String(error)}`));
  }

  private scheduleRetry(source: ConnectorSourceRow, cause: unknown, immediate = false): void {
    const id = key(source);
    const message = (cause instanceof Error ? cause.message : String(cause)).slice(0, 4000);
    if (immediate) {
      this.retryAt.delete(id);
    } else {
      const attempt = (this.attempts.get(id) ?? 0) + 1;
      this.attempts.set(id, attempt);
      this.retryAt.set(id, this.now() + Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempt - 1, 6)));
    }
    // A credential failure needs the owner: `error` takes the source out of the reconcile set
    // until it is reconnected. Anything else is `degraded` until the next socket opens.
    const terminal = cause instanceof SocketIngressCredentialError;
    this.updateSource(source, { status: terminal ? 'error' : 'degraded', lastError: terminal ? `reconnect_required: ${message}` : message });
  }

  private hostFetch(provider: RegisteredProvider, source: ConnectorSourceRow, registry: ProviderRegistry): HostFetch {
    const harness = harnessOf(source);
    if (this.deps.hostFetchFor) return this.deps.hostFetchFor(provider, source, harness);
    return createSourceHostFetch(this.sql(), {
      providerId: provider.descriptor.id,
      workspaceId: source.workspaceId,
      harness,
      registry,
      reconnectRequired: (reason) => new ProviderSyncFailure({ kind: 'auth', message: reason }),
    });
  }

  private async handleEnvelope(connection: Connection, envelope: Record<string, unknown>): Promise<void> {
    const { provider } = connection.ingress;
    // The source's non-secret config rides along so the provider can apply source-scoped admission
    // rules, e.g. Slack's declared drill-bot identity (cupboard-distributable-integrations D-023).
    const args: ProviderIngressNormalizeArgs = { envelope, sourceConfig: connection.source.config ?? {} };
    const result = await provider.adapter.invoke(
      { source: connection.source.id, capability: PROVIDER_INGRESS_NORMALIZE_CAPABILITY, args: { ...args } },
      { fetch: this.hostFetch(provider, connection.source, connection.registry) },
    );
    const records = (result as { records?: unknown } | null)?.records;
    assertProviderRecords(records, provider);
    const admit = this.deps.admit ?? ((sql, input) => admitConnectorRecord(sql, input));
    for (const record of records) {
      await admit(this.sql(), { source: connection.source, providerId: provider.descriptor.id, record });
    }
  }

  private attach(
    source: ConnectorSourceRow, ingress: SocketIngressProvider, socket: IngressSocketLike, registry: ProviderRegistry,
  ): void {
    const id = key(source);
    const connection: Connection = {
      source, ingress, socket, processing: Promise.resolve(), immediate: Promise.resolve(), reconnectRequested: false, registry,
    };
    this.connections.set(id, connection);
    const { ackField, reconnect, immediate } = ingress.socket;
    socket.on('open', () => {
      this.attempts.delete(id);
      this.retryAt.delete(id);
      this.updateSource(connection.source, { status: 'connected', lastError: null, connected: true });
    });
    socket.on('message', (raw: unknown) => {
      const envelope = parseEnvelope(raw);
      if (!envelope) return;
      // Ack first: the vendor's ack window must not depend on how long normalizing takes.
      const ackValue = ackField ? envelope[ackField] : undefined;
      if (typeof ackValue === 'string' || typeof ackValue === 'number') {
        try {
          socket.send(JSON.stringify({ [ackField as string]: ackValue }));
        } catch (error) {
          this.log(`source ${source.id} ack failed: ${String(error)}`);
          try { socket.close(); } catch { /* already closed */ }
          return;
        }
      }
      if (reconnect && reconnect.values.includes(String(envelope[reconnect.field]))) {
        connection.reconnectRequested = true;
        try { socket.close(); } catch { /* already closed */ }
        return;
      }
      const failed = (error: unknown) => {
        this.log(`source ${source.id} envelope failed: ${error instanceof Error ? error.message : String(error)}`);
        this.updateSource(connection.source, {
          status: 'degraded',
          lastError: `ingress_envelope_failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 3900)}`,
        });
      };
      // An `immediate` envelope (e.g. a click whose response window is seconds) must not wait for
      // a slow envelope ahead of it, so it runs on its own chain.
      if (immediate && immediate.values.includes(String(envelope[immediate.field]))) {
        connection.immediate = connection.immediate.then(() => this.handleEnvelope(connection, envelope)).catch(failed);
        return;
      }
      connection.processing = connection.processing.then(() => this.handleEnvelope(connection, envelope)).catch(failed);
    });
    socket.on('close', (code?: number) => {
      if (this.connections.get(id) !== connection) return;
      this.connections.delete(id);
      if (connection.reconnectRequested) {
        this.retryAt.delete(id);
        void this.reconcile().catch((error) => this.log(`reconnect of ${source.id} failed: ${String(error)}`));
        return;
      }
      this.scheduleRetry(connection.source, new Error(`socket_closed:${code ?? 0}`));
    });
    socket.on('error', (error: Error) => this.log(`source ${source.id} socket error: ${error.message}`));
  }

  async reconcile(): Promise<void> {
    if (this.stopped) return;
    const sql = this.sql();
    const registry = await (this.deps.registry ?? readyProviderRegistry)();
    const providers = new Map(socketIngressProviders(registry).map((entry) => [entry.provider.descriptor.id, entry]));
    const workspaceId = (this.deps.workspaceId ?? activeWorkspaceId)();
    const listed = await (this.deps.listSources ?? listActiveConnectorSources)(sql, workspaceId, [...providers.keys()]);
    const sources = listed.filter(isPastedCredentialSource);
    const live = new Set(sources.map(key));
    for (const [id, connection] of this.connections) {
      if (live.has(id)) continue;
      this.connections.delete(id);
      try { connection.socket.close(); } catch { /* already closed */ }
    }
    for (const source of sources) {
      const id = key(source);
      const ingress = providers.get(source.kind);
      if (!ingress) continue;
      const existing = this.connections.get(id);
      if (existing) {
        // The socket can stay open across source edits, but envelope normalization and admission
        // must see the current non-secret config and source metadata on every reconcile.
        existing.source = source;
        existing.registry = registry;
        continue;
      }
      if ((this.retryAt.get(id) ?? 0) > this.now()) continue;
      try {
        const credential = await (this.deps.readCredential
          ?? ((provider, harness, field) => readProviderCredentialValue(provider.descriptor, harness, field)))(
          ingress.provider,
          harnessOf(source),
          ingress.socket.credential,
        );
        if (!credential) throw new SocketIngressCredentialError(`credential_not_configured:${ingress.socket.credential}`);
        const url = await openIngressSocketUrl(ingress.socket, credential, this.deps.fetch ?? fetch);
        if (this.stopped) return;
        const create = this.deps.createSocket ?? ((value: string) => new WebSocket(value) as unknown as IngressSocketLike);
        this.attach(source, ingress, create(url), registry);
      } catch (error) {
        this.scheduleRetry(source, error);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    for (const connection of this.connections.values()) {
      try { connection.socket.close(); } catch { /* already closed */ }
    }
    this.connections.clear();
  }
}

type GlobalState = { manager: ProviderSocketIngressManager; timer: ManagedHandle };
interface GlobalStateHolder {
  current?: GlobalState;
}

const state = pinModuleState<GlobalStateHolder>('papercusp.providers.socket-ingress', () => ({}));

/** Start once in the background host. The managed timer is the schedule:inventory health row. */
export function startProviderSocketIngress(deps: ProviderSocketIngressDeps = {}): GlobalState {
  if (state.current) return state.current;
  const manager = new ProviderSocketIngressManager(deps);
  const timer = managedSetInterval('provider-socket-ingress-reconcile', RECONCILE_MS, () => manager.reconcile(), {
    category: 'lifecycle',
    classification: 'timeout-reaper',
    fireOnArm: true,
  });
  state.current = { manager, timer };
  return state.current;
}
