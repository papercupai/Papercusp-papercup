/**
 * The `slack` provider package end to end on the host's real paths
 * (plan cupboard-distributable-integrations-2026-10-10 P-006; SPEC-R-4-P-006 integration layer).
 *
 * The package (libs/papercusp/plugins/slack) runs exactly as the Cupboard installs it: its manifest
 * daemon command is started by `startDaemonProvider` inside the provider sandbox (bubblewrap: no
 * network, no host files, no credentials). Around it everything is the production host:
 *   - the owner pastes both tokens through the P-001 credential store, which connects their source;
 *   - the generic socket ingress (P-003, D-009) opens the manifest's Socket Mode endpoint with the
 *     app-level token, holds the socket, acks, asks the daemon to normalize, and admits the records
 *     through `admitConnectorRecord` into `harness_shared.trigger_deliveries`;
 *   - the option-source route (P-004) asks the daemon for `chat.channels`, and `chat.reply` goes out
 *     through `createSourceHostFetch`, which injects the bot token for slack.com itself.
 *
 * Only Slack is a stand-in: a local HTTP server answers `apps.connections.open` and the Web API, and a
 * local WebSocket server plays the Socket Mode connection with Slack-shaped envelopes.
 */
import { promises as fs, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { ProviderDescriptor, ProviderInvokeRequest } from '@papercusp/plugin-sdk';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
// The token store mirrors to PG through getOrgPg; keep that mirror in the test database.
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { getDatatype, upsertDatatype } from '../../datatype-registry-store';
import { DEFAULT_SOURCE_TOKEN_HARNESS } from '../../external-triggers/source-store';
import { ingestExternalTriggerEvent } from '../../external-triggers/ingestion';
import { startDaemonProvider, type DaemonProviderRuntime } from '../../integrations/daemon-provider';
import { listProviderOptions } from '../../integrations/provider-options';
import { saveProviderCredentials, syncProviderCredentialSource } from '../../integrations/provider-credentials';
import { createProviderRegistry, type ProviderRegistry } from '../../integrations/provider-registry';
import { createSourceHostFetch } from '../../integrations/source-host-fetch';
import { admitConnectorRecord, type ConnectorRecordAdmission } from '../connector-runtime';
import { ProviderSocketIngressManager } from '../provider-socket-ingress';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const PACKAGE_DIR = resolve(REPO_ROOT, 'libs/papercusp/plugins/slack');
const manifest = JSON.parse(readFileSync(resolve(PACKAGE_DIR, 'papercusp.json'), 'utf8')) as {
  runtime: { kind: string; daemonCommand: string[] };
  provider: ProviderDescriptor;
};

const WS = 'slack-package-integration';
const OPEN_URL = 'https://slack.com/api/apps.connections.open';
/** Token-shaped fakes, assembled at runtime so no credential-shaped literal sits in the tree. */
const fakeToken = (prefix: string, tail: string) => [prefix, '1', 'A0FIXTURE', '0123456789', tail].join('-');
const APP_TOKEN = fakeToken('xapp', 'app');
const BOT_TOKEN = fakeToken('xoxb', 'bot');

let org: OrgTestDb;
let sql: Sql;
let home: string;
let runtime: DaemonProviderRuntime;
let registry: ProviderRegistry;
let manager: ProviderSocketIngressManager | null = null;

// Stand-in Slack: Web API (incl. apps.connections.open) and the Socket Mode server.
let http: Server;
let httpPort: number;
let wss: WebSocketServer;
let wsPort: number;
let apiCalls: Array<{ method: string; path: string; authorization: string | null; body: string }>;
let serverSockets: ServerSocket[];
let acks: string[];

let invocations: ProviderInvokeRequest[];
let admissions: ConnectorRecordAdmission[];
let logs: string[];

async function waitFor<T>(what: string, probe: () => T | Promise<T>, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
  });
}

/** Every request to https://slack.com is answered by the local stand-in. */
const slackFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== 'slack.com') throw new Error(`unexpected host request: ${url.href}`);
  return fetch(`http://127.0.0.1:${httpPort}${url.pathname}${url.search}`, init);
}) as typeof fetch;

async function newOwner(): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`slack-package-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, 'owner') RETURNING id`;
  return user!.id;
}

/** The owner pastes both tokens on the card: the P-001 store saves them and connects the source. */
async function pasteTokens(ownerUserId: string): Promise<string> {
  const statuses = await saveProviderCredentials(manifest.provider, DEFAULT_SOURCE_TOKEN_HARNESS, {
    app_token: APP_TOKEN,
    bot_token: BOT_TOKEN,
  });
  expect(await syncProviderCredentialSource(sql, { workspaceId: WS, ownerUserId }, manifest.provider, statuses)).toBe('connected');
  const [row] = await sql<{ id: string }[]>`
    SELECT id::text FROM harness_shared.data_sources
     WHERE workspace_id = ${WS} AND kind = 'slack' AND owner_user_id = ${ownerUserId} AND status <> 'disabled'`;
  return row!.id;
}

/** `storeSinks` keeps the production destination sinks, so chat messages land in chat_messages. */
function startManager({ storeSinks = false } = {}): ProviderSocketIngressManager {
  manager = new ProviderSocketIngressManager({
    sql,
    workspaceId: () => WS,
    registry: async () => registry,
    fetch: slackFetch,
    // The production host.fetch (token store + egress allowlist), with only the network stood in.
    hostFetchFor: (provider, source, harness) =>
      createSourceHostFetch(sql, { providerId: provider.descriptor.id, workspaceId: WS, harness, registry, fetchImpl: slackFetch, sourceIds: [source.id] }),
    admit: async (db, input) => {
      const outcome = await admitConnectorRecord(db, input, {
        ingest: (inner, args) =>
          ingestExternalTriggerEvent(inner, args, {
            emit: async (event) => ({ ok: true, key: event.key, woken: 0, notified: [], msgId: null, waiters: 0 }),
          }),
        ...(storeSinks ? {} : { sinksFor: async () => [] }),
      });
      admissions.push(outcome);
      return outcome;
    },
    log: (message) => logs.push(message),
  });
  return manager;
}

/** A Socket Mode `events_api` envelope as Slack sends it. */
function eventsEnvelope(envelopeId: string, eventId: string, event: Record<string, unknown>) {
  return {
    envelope_id: envelopeId,
    type: 'events_api',
    accepts_response_payload: false,
    retry_attempt: 0,
    retry_reason: '',
    payload: { team_id: 'T0TEAM', api_app_id: 'A0APP', type: 'event_callback', event_id: eventId, event_time: 1712345678, event },
  };
}

async function deliveries(sourceId: string) {
  return sql<Array<{ dedupe_key: string; datatype_id: string; payload: Record<string, unknown> }>>`
    SELECT DISTINCT ON (dedupe_key) dedupe_key, datatype_id, payload FROM harness_shared.trigger_deliveries
     WHERE workspace_id = ${WS} AND source_id = ${sourceId}::uuid ORDER BY dedupe_key, received_at`;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const base = await getDatatype(sql, 'papercusp-workspace', 'chat-message');
  if (!base) throw new Error('slack_package_test_datatype_missing:chat-message');
  await upsertDatatype(sql, { ...base, workspaceId: WS, createdBy: 'slack-package-integration' });

  // The package's own manifest command, sandboxed exactly as a Cupboard install runs it.
  expect(manifest.runtime.kind).toBe('daemon');
  runtime = await startDaemonProvider({
    pluginName: 'slack',
    pluginDir: PACKAGE_DIR,
    cmd: manifest.runtime.daemonCommand,
    declared: manifest.provider,
    healthIntervalMs: 0,
    callTimeoutMs: 15_000,
  });
  registry = createProviderRegistry();
  await registry.register({ descriptor: runtime.descriptor, adapter: runtime.adapter, pluginName: 'slack', runtime: 'daemon' });

  http = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = (req.url ?? '').split('?')[0]!;
    const authorization = req.headers.authorization ?? null;
    apiCalls.push({ method: req.method ?? '', path, authorization, body });
    res.setHeader('content-type', 'application/json');
    if (path === '/api/apps.connections.open') {
      res.end(JSON.stringify(authorization === `Bearer ${APP_TOKEN}` ? { ok: true, url: `ws://127.0.0.1:${wsPort}/link?n=${apiCalls.length}` } : { ok: false, error: 'invalid_auth' }));
      return;
    }
    if (authorization !== `Bearer ${BOT_TOKEN}`) {
      res.end(JSON.stringify({ ok: false, error: 'not_authed' }));
      return;
    }
    if (path === '/api/conversations.list') {
      res.end(JSON.stringify({ ok: true, channels: [{ id: 'C0BUGS', name: 'bugs', purpose: { value: 'Bug reports' } }, { id: 'C0GENERAL', name: 'general' }], response_metadata: { next_cursor: '' } }));
      return;
    }
    if (path === '/api/chat.postMessage') {
      const sent = JSON.parse(body || '{}') as { channel?: string };
      res.end(JSON.stringify({ ok: true, channel: sent.channel, ts: '1712345999.000100' }));
      return;
    }
    res.end(JSON.stringify({ ok: false, error: 'unknown_method' }));
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  httpPort = (http.address() as AddressInfo).port;

  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wsPort = (wss.address() as AddressInfo).port;
  wss.on('connection', (socket) => {
    serverSockets.push(socket);
    socket.on('message', (data) => acks.push(data.toString()));
    socket.send(JSON.stringify({ type: 'hello', num_connections: 1, connection_info: { app_id: 'A0APP' } }));
  });
}, 60_000);

afterAll(async () => {
  manager?.stop();
  await runtime?.shutdown();
  await new Promise<void>((r) => wss?.close(() => r()));
  await new Promise<void>((r) => http?.close(() => r()));
  await org?.cleanup();
});

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'paperhome-slack-package-'));
  vi.stubEnv('PAPERCUSP_HOME', home);
  apiCalls = [];
  serverSockets = [];
  acks = [];
  invocations = [];
  admissions = [];
  logs = [];
  // Record what the sandboxed daemon is asked, without changing how it is asked.
  const invoke = runtime.adapter.invoke.bind(runtime.adapter);
  runtime.adapter.invoke = async (request, host) => {
    invocations.push(request);
    return invoke(request, host);
  };
});

afterEach(async () => {
  manager?.stop();
  manager = null;
  for (const socket of wss.clients) socket.terminate();
  await sql`UPDATE harness_shared.data_sources SET status = 'disabled' WHERE workspace_id = ${WS}`;
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

describe('slack package on the host (P-006)', () => {
  it('turns a Slack channel post into a chat-message delivery with its channel, author and text', async () => {
    const sourceId = await pasteTokens(await newOwner());
    await startManager().reconcile();

    // Socket Mode was opened with the app-level token, never the bot token.
    expect(apiCalls).toEqual([{ method: 'POST', path: '/api/apps.connections.open', authorization: `Bearer ${APP_TOKEN}`, body: expect.any(String) }]);
    const slack = await waitFor('the Socket Mode connection', () => serverSockets[0]);

    slack.send(JSON.stringify(eventsEnvelope('env-1', 'Ev0001', {
      type: 'message', channel: 'C0BUGS', channel_type: 'channel', user: 'U0REPORTER', text: 'The export button returns a 500 <@U0BOT>', ts: '1712345678.000200',
    })));
    // The bot's own reply in the thread is not an inbound message.
    slack.send(JSON.stringify(eventsEnvelope('env-2', 'Ev0002', {
      type: 'message', channel: 'C0BUGS', user: 'U0BOT', bot_id: 'B0BOT', text: 'Filed.', ts: '1712345680.000100', thread_ts: '1712345678.000200',
    })));
    // The app mention of the same post is delivered as its own event.
    slack.send(JSON.stringify(eventsEnvelope('env-3', 'Ev0003', {
      type: 'app_mention', channel: 'C0BUGS', user: 'U0REPORTER', text: 'The export button returns a 500 <@U0BOT>', ts: '1712345678.000200',
    })));
    await waitFor('both records to be admitted', () => admissions.length === 2);
    // Slack retries an event it thinks was not acked: same event, new envelope — acked and deduped.
    slack.send(JSON.stringify(eventsEnvelope('env-4', 'Ev0001', {
      type: 'message', channel: 'C0BUGS', channel_type: 'channel', user: 'U0REPORTER', text: 'The export button returns a 500 <@U0BOT>', ts: '1712345678.000200',
    })));
    await waitFor('the retry to be processed', () => admissions.length === 3);

    expect(acks).toEqual(['env-1', 'env-2', 'env-3', 'env-4'].map((id) => JSON.stringify({ envelope_id: id })));
    expect(admissions).toEqual(['admitted', 'admitted', 'deduped']);

    const rows = await deliveries(sourceId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.datatype_id).toBe('chat-message');
      expect(row.payload).toMatchObject({
        channelId: 'C0BUGS',
        threadId: '1712345678.000200',
        sender: 'U0REPORTER',
        text: 'The export button returns a 500 <@U0BOT>',
        mentions: ['U0BOT'],
        occurredAt: '2024-04-05T19:34:38.000Z',
      });
    }
    expect(rows.map((row) => (row.payload.extensions as { slack: { eventType: string } }).slack.eventType).sort()).toEqual(['app_mention', 'message']);
    expect((await sql`SELECT status, last_error FROM harness_shared.data_sources WHERE id = ${sourceId}::uuid`)[0]).toEqual({ status: 'connected', last_error: null });

    // The sandboxed daemon normalized every envelope and never saw a token.
    expect(invocations.every((call) => call.capability === 'ingress.normalize' && call.source === sourceId)).toBe(true);
    const seen = JSON.stringify(invocations);
    expect(seen).not.toContain(APP_TOKEN);
    expect(seen).not.toContain(BOT_TOKEN);
    expect(logs.join('\n')).not.toContain(APP_TOKEN);
  });

  it('follows an edit and a deletion of a Slack message into the stored chat message', async () => {
    const sourceId = await pasteTokens(await newOwner());
    await startManager({ storeSinks: true }).reconcile();
    const slack = await waitFor('the Socket Mode connection', () => serverSockets[0]);
    const post = { type: 'message', user: 'U0REPORTER', text: 'my password is hunter2', ts: '1712345678.000400' };
    const stored = async () => (await sql<Array<{ body: string | null; edited_at: Date | null; deleted_at: Date | null; posted_at: Date }>>`
      SELECT body, edited_at, deleted_at, posted_at FROM harness_shared.chat_messages
       WHERE workspace_id = ${WS} AND data_source_id = ${sourceId}::uuid
         AND channel_id = 'C0BUGS' AND provider_message_id = 'C0BUGS:1712345678.000400'`)[0];

    slack.send(JSON.stringify(eventsEnvelope('env-p', 'EvPost', { ...post, channel: 'C0BUGS', channel_type: 'channel' })));
    expect((await waitFor('the post to be stored', stored)).body).toBe('my password is hunter2');

    slack.send(JSON.stringify(eventsEnvelope('env-e', 'EvEdit', {
      type: 'message', subtype: 'message_changed', hidden: true, channel: 'C0BUGS', channel_type: 'channel',
      ts: '1712345700.000100', event_ts: '1712345700.000100',
      message: { ...post, text: 'please rotate my password', edited: { user: 'U0REPORTER', ts: '1712345699.000000' } },
      previous_message: post,
    })));
    const edited = await waitFor('the edit to be stored', async () => {
      const row = await stored();
      return row?.body === 'please rotate my password' ? row : null;
    });
    // The edit is the same message: its post time (and so its thread or time window) stays.
    expect(edited.posted_at.toISOString()).toBe('2024-04-05T19:34:38.000Z');
    expect(edited.edited_at?.toISOString()).toBe('2024-04-05T19:34:59.000Z');

    slack.send(JSON.stringify(eventsEnvelope('env-d', 'EvDelete', {
      type: 'message', subtype: 'message_deleted', hidden: true, channel: 'C0BUGS', channel_type: 'channel',
      ts: '1712345800.000100', event_ts: '1712345800.000100', deleted_ts: post.ts,
      previous_message: { ...post, text: 'please rotate my password' },
    })));
    const deleted = await waitFor('the deletion to be stored', async () => {
      const row = await stored();
      return row?.deleted_at ? row : null;
    });
    // With no legal hold the text is erased at once, not kept until the next retention pass.
    expect(deleted.body).toBeNull();
    expect(deleted.deleted_at?.toISOString()).toBe('2024-04-05T19:36:40.000Z');
    // The outcome is recorded after the sink write, so the stored row can be visible first.
    await waitFor('the deletion to be admitted', () => admissions.length === 3);
    expect(admissions).toEqual(['admitted', 'admitted', 'admitted']);
  });

  it('lists channels for the picker and replies in the thread with the bot token injected by the host', async () => {
    const ownerUserId = await newOwner();
    const sourceId = await pasteTokens(ownerUserId);
    const hostFetchFor = (db: Sql, input: { workspaceId: string; providerId: string; sourceId: string; harness: string }) =>
      createSourceHostFetch(db, { ...input, sourceIds: [input.sourceId], registry, fetchImpl: slackFetch });

    // P-004 option source: the trigger pack's `x-options: { capability: 'chat.channels' }` picker.
    const options = await listProviderOptions(sql, { workspaceId: WS, ownerUserId, capability: 'chat.channels' }, { registry, hostFetchFor });
    expect(options.groups).toHaveLength(1);
    expect(options.groups[0]).toMatchObject({
      sourceId,
      provider: 'slack',
      error: null,
      options: [
        { value: 'C0BUGS', label: '#bugs', description: 'Bug reports' },
        { value: 'C0GENERAL', label: '#general' },
      ],
    });

    // chat.reply from a workflow: the daemon asks host.fetch; the host adds the bot token for slack.com.
    const reply = await runtime.adapter.invoke(
      { source: sourceId, capability: 'chat.reply', args: { channelId: 'C0BUGS', threadId: '1712345678.000200', text: 'Filed as a ticket.' } },
      { fetch: hostFetchFor(sql, { workspaceId: WS, providerId: 'slack', sourceId, harness: DEFAULT_SOURCE_TOKEN_HARNESS }) },
    );
    expect(reply).toEqual({ channelId: 'C0BUGS', threadId: '1712345678.000200', messageTs: '1712345999.000100' });

    expect(apiCalls.map(({ method, path, authorization }) => ({ method, path, authorization }))).toEqual([
      { method: 'GET', path: '/api/conversations.list', authorization: `Bearer ${BOT_TOKEN}` },
      { method: 'POST', path: '/api/chat.postMessage', authorization: `Bearer ${BOT_TOKEN}` },
    ]);
    expect(JSON.parse(apiCalls[1]!.body)).toEqual({ channel: 'C0BUGS', thread_ts: '1712345678.000200', text: 'Filed as a ticket.' });
    // What the daemon was handed carries neither token.
    const seen = JSON.stringify(invocations);
    expect(seen).not.toContain(BOT_TOKEN);
    expect(seen).not.toContain(APP_TOKEN);
  });
});
