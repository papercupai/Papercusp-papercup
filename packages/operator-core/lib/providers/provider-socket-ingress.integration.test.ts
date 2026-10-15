/**
 * Host-held socket ingress against real Postgres, the real credential store and a real WebSocket
 * (plan cupboard-distributable-integrations-2026-10-10, P-003 / decision D-009; SPEC-R-4-P-003,
 * SPEC-R-7-P-003).
 *
 * The owner's path is driven end to end: the credential is pasted through the P-001 store
 * (`saveProviderCredentials`), which connects the owner's source (`syncProviderCredentialSource`);
 * the manager then finds that source in `harness_shared.data_sources`, reads the credential back
 * from the store, asks the vendor's open endpoint for a socket URL, holds a real `ws` socket, and
 * admits normalized records through `admitConnectorRecord` into `harness_shared.trigger_deliveries`.
 *
 * Only the vendor is a stand-in: a local HTTP server answers the descriptor's https open URL and a
 * local WebSocket server plays the vendor's socket (hello, events, a disconnect notice). The event
 * bus emit is stubbed, as in the connector-runtime suite.
 */
import { promises as fs } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { ProviderAdapter, ProviderDescriptor, ProviderInvokeRequest, ProviderRecord } from '@papercusp/plugin-sdk';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
// The token store mirrors to PG through getOrgPg; keep that mirror in the test database.
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getDatatype, upsertDatatype } from '../datatype-registry-store';
import { DEFAULT_SOURCE_TOKEN_HARNESS, upsertOwnedExternalTriggerSource } from '../external-triggers/source-store';
import { ingestExternalTriggerEvent } from '../external-triggers/ingestion';
import { saveProviderCredentials, syncProviderCredentialSource } from '../integrations/provider-credentials';
import { createProviderRegistry, type ProviderRegistry } from '../integrations/provider-registry';
import { admitConnectorRecord, connectorRecordDedupeKey, type ConnectorRecordAdmission } from './connector-runtime';
import { ProviderSocketIngressManager } from './provider-socket-ingress';

const WS = 'provider-socket-ingress-test';
const KIND = 'socket-ingress-fixture';
const OPEN_URL = 'https://api.socket-fixture.test/apps.connections.open';
const GOOD_TOKEN = 'xapp-1-A0FIXTURE-0123456789-good';
const BAD_TOKEN = 'xapp-1-A0FIXTURE-0123456789-revoked';

const descriptor: ProviderDescriptor = {
  id: KIND,
  contractVersion: 1,
  datatypes: ['chat-message'],
  capabilities: ['chat.send', 'ingress.normalize'],
  egressHosts: ['api.socket-fixture.test'],
  setup: { credentials: [{ key: 'app_token', label: 'App-level token' }] },
  ingress: {
    socket: {
      credential: 'app_token',
      open: { url: OPEN_URL, urlField: 'url' },
      ackField: 'envelope_id',
      reconnect: { field: 'type', values: ['disconnect'] },
    },
  },
};

let org: OrgTestDb;
let sql: Sql;
let home: string;
let registry: ProviderRegistry;
let manager: ProviderSocketIngressManager | null = null;

// Stand-in vendor: an open endpoint and a socket server.
let http: Server;
let httpPort: number;
let wss: WebSocketServer;
let wsPort: number;
let opens: Array<{ requestedUrl: string; method: string; authorization: string | null }>;
let serverSockets: ServerSocket[];
let acks: string[];

// What provider code saw, and what the host did.
let invocations: ProviderInvokeRequest[];
let admissions: ConnectorRecordAdmission[];
let logs: string[];

async function waitFor<T>(what: string, probe: () => T | Promise<T>, timeoutMs = 5_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.on('data', () => undefined);
    req.on('end', () => resolve());
  });
}

const adapter: ProviderAdapter = {
  describe: () => descriptor,
  syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
  async invoke(request) {
    invocations.push(request);
    if (request.capability !== 'ingress.normalize') return { ok: true };
    const envelope = request.args.envelope as Record<string, unknown>;
    if (envelope.type !== 'events_api') return { records: [] };
    // The vendor must already hold the ack when normalizing starts: if the host acked only after
    // this returned, the wait below never ends and the envelope fails.
    const envelopeId = String(envelope.envelope_id);
    await waitFor(`the ack of ${envelopeId} to reach the vendor`, () => acks.includes(JSON.stringify({ envelope_id: envelopeId })), 2_000);
    const event = (envelope.payload as { event: { ts: string; text: string; channel: string } }).event;
    return { records: [chatRecord(event.channel, event.ts, event.text)] };
  },
};

/** The record the fixture provider normalizes a message event into. */
function chatRecord(channel: string, ts: string, text: string): ProviderRecord {
  return {
    datatype: 'chat-message',
    nativeId: `${channel}:${ts}`,
    event: 'message.received',
    payload: { id: `${channel}:${ts}`, text, channelId: channel },
  };
}

function startManager(): ProviderSocketIngressManager {
  manager = new ProviderSocketIngressManager({
    sql,
    workspaceId: () => WS,
    registry: async () => registry,
    // The descriptor's https open URL is answered by the local stand-in.
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url !== OPEN_URL) throw new Error(`unexpected host request: ${url}`);
      return fetch(`http://127.0.0.1:${httpPort}/open`, init);
    }) as typeof fetch,
    hostFetchFor: () => async () => {
      throw new Error('the fixture provider makes no host.fetch call');
    },
    admit: async (db, input) => {
      const outcome = await admitConnectorRecord(db, input, {
        ingest: (inner, args) =>
          ingestExternalTriggerEvent(inner, args, {
            emit: async (event) => ({ ok: true, key: event.key, woken: 0, notified: [], msgId: null, waiters: 0 }),
          }),
        sinksFor: async () => [],
      });
      admissions.push(outcome);
      return outcome;
    },
    log: (message) => logs.push(message),
  });
  return manager;
}

async function newOwner(): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`socket-ingress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, 'owner') RETURNING id`;
  return user!.id;
}

/** The owner pastes the credential: the P-001 store saves it and connects the owner's source. */
async function pasteCredential(ownerUserId: string, token: string): Promise<string> {
  const statuses = await saveProviderCredentials(descriptor, DEFAULT_SOURCE_TOKEN_HARNESS, { app_token: token });
  expect(await syncProviderCredentialSource(sql, { workspaceId: WS, ownerUserId }, descriptor, statuses)).toBe('connected');
  const [row] = await sql<{ id: string }[]>`
    SELECT id::text FROM harness_shared.data_sources
     WHERE workspace_id = ${WS} AND kind = ${KIND} AND owner_user_id = ${ownerUserId}`;
  return row!.id;
}

async function source(id: string) {
  const [row] = await sql<Array<{ status: string; last_error: string | null }>>`
    SELECT status, last_error FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND id = ${id}::uuid`;
  return row!;
}

async function deliveredKeys(sourceId: string): Promise<string[]> {
  const rows = await sql<Array<{ dedupe_key: string }>>`
    SELECT DISTINCT dedupe_key FROM harness_shared.trigger_deliveries
     WHERE workspace_id = ${WS} AND source_id = ${sourceId}::uuid ORDER BY dedupe_key`;
  return rows.map((row) => row.dedupe_key);
}

function messageEnvelope(envelopeId: string, ts: string, text: string) {
  return { envelope_id: envelopeId, type: 'events_api', payload: { event: { type: 'message', ts, text, channel: 'C0FIXTURE' } } };
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const base = await getDatatype(sql, 'papercusp-workspace', 'chat-message');
  if (!base) throw new Error('provider_socket_ingress_test_datatype_missing:chat-message');
  await upsertDatatype(sql, { ...base, workspaceId: WS, createdBy: 'provider-socket-ingress-integration' });
  registry = createProviderRegistry();
  await registry.register({ descriptor, adapter, pluginName: 'socket-ingress-fixture-plugin' });

  http = createServer(async (req, res) => {
    await readBody(req);
    const authorization = req.headers.authorization ?? null;
    opens.push({ requestedUrl: req.url ?? '', method: req.method ?? '', authorization });
    res.setHeader('content-type', 'application/json');
    // Vendors answer a refused token with 200 and `{ ok: false, error }` (Slack does).
    if (authorization !== `Bearer ${GOOD_TOKEN}`) {
      res.end(JSON.stringify({ ok: false, error: 'invalid_auth' }));
      return;
    }
    res.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${wsPort}/socket?n=${opens.length}` }));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  httpPort = (http.address() as AddressInfo).port;

  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  wsPort = (wss.address() as AddressInfo).port;
  wss.on('connection', (socket) => {
    serverSockets.push(socket);
    socket.on('message', (data) => acks.push(data.toString()));
    socket.send(JSON.stringify({ type: 'hello', num_connections: 1 }));
  });
});

afterAll(async () => {
  manager?.stop();
  await new Promise<void>((resolve) => wss?.close(() => resolve()));
  await new Promise<void>((resolve) => http?.close(() => resolve()));
  await org?.cleanup();
});

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'paperhome-provider-socket-ingress-'));
  vi.stubEnv('PAPERCUSP_HOME', home);
  opens = [];
  serverSockets = [];
  acks = [];
  invocations = [];
  admissions = [];
  logs = [];
});

afterEach(async () => {
  manager?.stop();
  manager = null;
  for (const socket of wss.clients) socket.terminate();
  // Each test owns its source; retire the previous ones so the next reconcile sees only its own.
  await sql`UPDATE harness_shared.data_sources SET status = 'disabled' WHERE workspace_id = ${WS}`;
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

describe('provider socket ingress (P-003, D-009)', () => {
  it('opens the declared socket with the pasted credential, acks before normalizing, and admits each record once', async () => {
    const sourceId = await pasteCredential(await newOwner(), GOOD_TOKEN);
    await startManager().reconcile();

    // The host called the declared open endpoint with the stored credential as a bearer token.
    expect(opens).toEqual([{ requestedUrl: '/open', method: 'POST', authorization: `Bearer ${GOOD_TOKEN}` }]);
    const vendor = await waitFor('the socket to connect', () => serverSockets[0]);
    await waitFor('the source to report connected', async () => (await source(sourceId)).status === 'connected');
    expect((await source(sourceId)).last_error).toBeNull();

    vendor.send(JSON.stringify(messageEnvelope('env-1', '1700000000.000100', 'the build is red')));
    await waitFor('the first record to be admitted', () => admissions.length === 1);
    // The same event delivered again under a new envelope (a vendor retry) is acked and deduped.
    vendor.send(JSON.stringify(messageEnvelope('env-2', '1700000000.000100', 'the build is red')));
    await waitFor('the redelivery to be processed', () => admissions.length === 2);

    expect(acks).toEqual([JSON.stringify({ envelope_id: 'env-1' }), JSON.stringify({ envelope_id: 'env-2' })]);
    expect(admissions).toEqual(['admitted', 'deduped']);
    const record = chatRecord('C0FIXTURE', '1700000000.000100', 'the build is red');
    expect(await deliveredKeys(sourceId)).toEqual([connectorRecordDedupeKey(sourceId, record)]);

    // Provider code received the envelopes (the hello included) and never the credential.
    expect(invocations.map((call) => (call.args.envelope as { type: string }).type)).toEqual(['hello', 'events_api', 'events_api']);
    expect(invocations.every((call) => call.capability === 'ingress.normalize' && call.source === sourceId)).toBe(true);
    expect(JSON.stringify(invocations)).not.toContain(GOOD_TOKEN);
    expect(logs.join('\n')).not.toContain(GOOD_TOKEN);
  });

  it('opens a fresh socket at once when the vendor announces a disconnect', async () => {
    const sourceId = await pasteCredential(await newOwner(), GOOD_TOKEN);
    await startManager().reconcile();
    const first = await waitFor('the first socket', () => serverSockets[0]);
    const firstClosed = new Promise<void>((resolve) => first.once('close', () => resolve()));

    first.send(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }));

    await firstClosed;
    const second = await waitFor('a second socket', () => serverSockets[1]);
    expect(opens).toHaveLength(2);
    expect(opens.every((open) => open.authorization === `Bearer ${GOOD_TOKEN}`)).toBe(true);
    expect(manager!.size).toBe(1);

    // The fresh socket carries traffic.
    second.send(JSON.stringify(messageEnvelope('env-3', '1700000001.000200', 'after reconnect')));
    await waitFor('the record on the fresh socket', () => admissions.length === 1);
    expect(admissions).toEqual(['admitted']);
    expect(await deliveredKeys(sourceId)).toHaveLength(1);
    // A disconnect notice is control traffic: it is neither acked nor normalized.
    expect(acks).toEqual([JSON.stringify({ envelope_id: 'env-3' })]);
    expect(invocations.some((call) => (call.args.envelope as { type: string }).type === 'disconnect')).toBe(false);
  });

  it('marks the source reconnect-required when the vendor refuses the credential, without leaking it', async () => {
    const sourceId = await pasteCredential(await newOwner(), BAD_TOKEN);
    const ingress = startManager();
    await ingress.reconcile();

    expect(opens).toEqual([{ requestedUrl: '/open', method: 'POST', authorization: `Bearer ${BAD_TOKEN}` }]);
    const after = await waitFor('the source to leave the connected state', async () => {
      const row = await source(sourceId);
      return row.status === 'error' ? row : null;
    });
    expect(after.last_error).toMatch(/^reconnect_required: socket_open_refused:invalid_auth/);
    expect(after.last_error).not.toContain(BAD_TOKEN);
    expect(serverSockets).toHaveLength(0);

    // Retrying cannot fix a refused credential: the source stays out of the reconcile set.
    await ingress.reconcile();
    expect(opens).toHaveLength(1);
    expect(logs.join('\n')).not.toContain(BAD_TOKEN);
  });

  // WI-6554700010008468. A source of the provider's kind connected some other way (the in-app
  // Slack OAuth/socket path writes `slack-socket:<field>`) belongs to that path. The manager used
  // to claim every row of the kind: with no pasted credential it wrote
  // `reconnect_required: credential_not_configured` onto the in-app source, which made the in-app
  // manager drop it; with one pasted, both paths opened sockets and split the vendor's events.
  it('leaves a source of the same kind that was connected another way untouched, with no credential pasted', async () => {
    const inAppId = await connectInApp(await newOwner());
    await startManager().reconcile();

    expect(opens).toEqual([]);
    expect(manager!.size).toBe(0);
    // Give a stray health write time to land before reading the row.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await source(inAppId)).toEqual({ status: 'connected', last_error: null });
  });

  it('serves only the pasted-credential source when a source of the same kind was connected another way', async () => {
    const inAppId = await connectInApp(await newOwner());
    const packageId = await pasteCredential(await newOwner(), GOOD_TOKEN);
    await startManager().reconcile();

    await waitFor('the package source to report connected', async () => (await source(packageId)).status === 'connected');
    expect(opens).toHaveLength(1);
    expect(manager!.size).toBe(1);
    await waitFor('the socket to connect', () => serverSockets[0]);
    expect(serverSockets).toHaveLength(1);
    expect(await source(inAppId)).toEqual({ status: 'connected', last_error: null });
  });
});

/**
 * A source of the fixture kind whose credential is not a pasted provider
 * credential. The ref has the shape the retired in-app Slack socket path wrote
 * (`slack-socket:<field>`); the ingress manager must leave such a source alone.
 */
async function connectInApp(ownerUserId: string): Promise<string> {
  const row = await upsertOwnedExternalTriggerSource(sql, {
    workspaceId: WS,
    kind: KIND,
    ownerUserId,
    credentialRef: 'slack-socket:bot_token',
    status: 'connected',
    createdBy: ownerUserId,
  });
  return row.id;
}
