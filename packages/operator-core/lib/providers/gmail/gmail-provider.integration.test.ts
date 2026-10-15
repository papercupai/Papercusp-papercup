/**
 * Gmail on the provider contract, end to end against a real database
 * (plan generalized-integrations-google-migration-cupboard-workflows-2026-10-05, P-008 / D-017..D-020).
 *
 * The REAL bundled package (`libs/papercusp/plugins/gmail`) is registered in a real provider
 * registry exactly as the plugin loader registers it, and only Gmail's REST API is scripted
 * behind `host.fetch`. Everything between is production code: the host connector driver
 * (`runConnectorSync`: lease, cursor commit, adoption, backoff), the ingestion ledger
 * (`harness_shared.trigger_deliveries`), the owner's Personal Vault sink, and the outbound mail
 * verbs (`mail:reply` / `mail:send` / `mail:draft`) through `resolveCapabilitySource` +
 * `invokeOutboundProvider`.
 *
 * Falsifiers pinned here: a Gmail message is delivered twice when history replays it; a source
 * a retired host path drove re-walks its whole mailbox instead of adopting the legacy
 * historyId (D-020); a Gmail 429 advances the cursor; a reply leaves the thread or loses its
 * In-Reply-To; a send drops a declared attachment; any of it reaches Gmail for a source other
 * than the one the call was bound to.
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { HostFetch, HostFetchRequest, HostFetchResponse, ProviderAdapter } from '@papercusp/plugin-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { allowAllMailboxProbe } from '../../capability-verbs/deliverability';
import { draftNewMail, replyToCanonicalMail, sendNewMail, type MailDeps } from '../../capability-verbs/mail';
import { CANONICAL_SOURCE_BY_DATATYPE, resolveCanonicalDocument } from '../../capability-verbs/resolve';
import { getDatatype, upsertDatatype } from '../../datatype-registry-store';
import { ingestExternalTriggerEvent, type IngestExternalTriggerInput } from '../../external-triggers/ingestion';
import { createProviderRegistry, type ProviderRegistry } from '../../integrations/provider-registry';
import { setPersonalVaultEnabled } from '../../personal-vault/store';
import { connectorRecordDedupeKey, runConnectorSync, type ConnectorSourceOutcome } from '../connector-runtime';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const require = createRequire(import.meta.url);
const gmail = require(join(REPO_ROOT, 'libs/papercusp/plugins/gmail/index.cjs')) as { providerAdapter: ProviderAdapter };

const WS = 'gmail-provider-integration';
const ACCOUNT = 'me@example.com';
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const OWNER_INSTRUCTION = { from: 'owner-instruction' } as const;

let org: OrgTestDb;
let registry: ProviderRegistry;
let userId: string;
/** Dedupe key of every REAL event-bus delivery (a deduped replay never emits). */
let emitted: string[];

const b64url = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
const decodeRaw = (raw: unknown) => Buffer.from(String(raw), 'base64url').toString('utf8');
/** The decoded text of a single-part, base64 transfer-encoded RFC 5322 message. */
function singlePartBody(raw: string): string {
  expect(raw).toMatch(/^Content-Transfer-Encoding: base64\r$/m);
  const [, ...body] = raw.split('\r\n\r\n');
  return Buffer.from(body.join('').replace(/\r\n/g, ''), 'base64').toString('utf8');
}

function message(id: string) {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: ['INBOX', 'UNREAD'],
    snippet: `snippet ${id}`,
    internalDate: '1767225600000',
    historyId: '501',
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: 'Ada <ada@example.com>' },
        { name: 'To', value: ACCOUNT },
        { name: 'Subject', value: `Subject ${id}` },
        { name: 'Message-ID', value: `<${id}@mail.example.com>` },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: b64url(`plain ${id}`) } },
        { mimeType: 'text/html', body: { data: b64url(`<p>html ${id}</p>`) } },
      ],
    },
  };
}

interface Mailbox {
  /** The connected account; `users.getProfile` answers with it. */
  account: string;
  /** Message ids `messages.get` answers for; any other id is a 404 (deleted before fetch). */
  messages: Set<string>;
  /** `history.list` answer per startHistoryId; an unscripted start returns an empty history. */
  history: Record<string, { status?: number; headers?: Record<string, string>; json: unknown }>;
  /** `messages.list` answer per pageToken (`start` = no token). */
  pages: Record<string, unknown>;
}

interface SeenRequest {
  source: string;
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

/** Gmail's REST API behind `host.fetch`, bound to one expected source. */
function gmailApi(expectedSource: () => string, mailbox: Mailbox) {
  const seen: SeenRequest[] = [];
  const respond = (status: number, json: unknown, headers: Record<string, string> = {}): HostFetchResponse => ({
    status,
    headers,
    body: JSON.stringify(json),
    bodyEncoding: 'utf8',
  });
  const fetch: HostFetch = async ({ source, request }: { source: string; request: HostFetchRequest }) => {
    const method = (request.method ?? 'GET').toUpperCase();
    const body = typeof request.body === 'string' && request.body ? (JSON.parse(request.body) as Record<string, unknown>) : null;
    seen.push({ source, method, url: request.url, body });
    // The provider must spend exactly the source the host bound this call to.
    expect(source).toBe(expectedSource());
    const url = new URL(request.url);
    const path = url.pathname.replace('/gmail/v1/users/me', '');
    if (method === 'GET' && path === '/profile') return respond(200, { emailAddress: mailbox.account, historyId: '500' });
    if (method === 'GET' && path === '/history') {
      const start = url.searchParams.get('startHistoryId') ?? '';
      const answer = mailbox.history[start] ?? { json: { historyId: start } };
      return respond(answer.status ?? 200, answer.json, answer.headers);
    }
    if (method === 'GET' && path === '/messages') {
      return respond(200, mailbox.pages[url.searchParams.get('pageToken') ?? 'start'] ?? { messages: [] });
    }
    const get = /^\/messages\/([^/]+)$/.exec(path);
    if (method === 'GET' && get) {
      return mailbox.messages.has(get[1]) ? respond(200, message(get[1])) : respond(404, { error: { message: 'Not Found' } });
    }
    if (method === 'POST' && path === '/drafts') {
      const threadId = (body?.message as { threadId?: string } | undefined)?.threadId ?? 'thread-new-draft';
      return respond(200, { id: `draft-${seen.length}`, message: { id: `draft-msg-${seen.length}`, threadId } });
    }
    if (method === 'POST' && path === '/messages/send') {
      return respond(200, { id: `sent-${seen.length}`, threadId: (body?.threadId as string | undefined) ?? 'thread-new-send' });
    }
    throw new Error(`gmail integration: unscripted request ${method} ${request.url}`);
  };
  return { fetch, seen };
}

async function ingest(sql: OrgTestDb['adminSql'], input: IngestExternalTriggerInput) {
  return ingestExternalTriggerEvent(sql, input, {
    emit: async (event) => {
      emitted.push(String((event.payload as { dedupeKey?: unknown } | undefined)?.dedupeKey));
      return { ok: true, key: event.key, woken: 0, notified: [], msgId: null, waiters: 0 };
    },
  });
}

/** A connected Gmail account owned by the test user; `cursor` seeds a retired host path's state. */
async function connectGmail(account: string, cursor: Record<string, unknown> = {}): Promise<string> {
  const [row] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, owner_user_id, provider_account_id, credential_ref, status, cursor)
    VALUES (${WS}, 'gmail', ${userId}, ${account}, 'test-credential-ref', 'ready', ${org.adminSql.json(cursor as never)})
    RETURNING id::text`;
  return row.id;
}

async function sync(sourceId: string, api: ReturnType<typeof gmailApi>): Promise<ConnectorSourceOutcome> {
  const result = await runConnectorSync(
    org.adminSql,
    { workspaceId: WS, harness: 'papercusp', sourceIds: [sourceId], pollIntervalSeconds: 300 },
    {
      registry,
      ingest,
      hostFetchFor: () => api.fetch,
      // Hermetic: no Pub/Sub service credential, so the push-wake leg makes no request.
      servicesFor: async () => undefined,
      leaseOwner: 'gmail-integration-driver',
    },
  );
  expect(result.sources).toHaveLength(1);
  return result.sources[0];
}

async function makeDue(sourceId: string): Promise<void> {
  await org.adminSql`
    UPDATE harness_shared.data_sources SET sync_next_attempt_at = now() - interval '1 second'
     WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
}

async function sourceState(sourceId: string) {
  const [row] = await org.adminSql<
    { provider: string | null; backfill_status: string; next_in: number | null }[]
  >`
    SELECT cursor->>'provider' AS provider, backfill_status,
           EXTRACT(EPOCH FROM sync_next_attempt_at - now())::float8 AS next_in
      FROM harness_shared.data_sources
     WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
  return { ...row, cursor: row.provider ? (JSON.parse(row.provider) as Record<string, any>) : null };
}

async function ledger(sourceId: string): Promise<Array<{ dedupe_key: string; n: number }>> {
  return org.adminSql<Array<{ dedupe_key: string; n: number }>>`
    SELECT dedupe_key, count(*)::int AS n
      FROM harness_shared.trigger_deliveries
     WHERE workspace_id = ${WS} AND source_id = ${sourceId}::uuid
     GROUP BY dedupe_key, sink_kind
     ORDER BY dedupe_key`;
}

const receivedKey = (sourceId: string, nativeId: string) =>
  connectorRecordDedupeKey(sourceId, { datatype: 'email-message', nativeId, event: 'message.received', payload: {}, version: 'received' });

async function copyDatatype(id: string): Promise<void> {
  const base = await getDatatype(org.adminSql, 'papercusp-workspace', id);
  if (!base) throw new Error(`gmail_integration_datatype_missing:${id}`);
  await upsertDatatype(org.adminSql, {
    id: base.id,
    workspaceId: WS,
    potSlug: base.potSlug,
    title: base.title,
    description: base.description,
    tier: base.tier,
    nature: base.nature,
    audience: base.audience,
    workItemKind: base.workItemKind,
    payloadSchema: base.payloadSchema,
    authoritativeWriter: base.authoritativeWriter,
    selfImprovement: base.selfImprovement,
    published: base.published,
    tags: base.tags,
    createdBy: 'gmail-provider-integration',
  });
}

beforeAll(async () => {
  org = await createOrgTestDb();
  await copyDatatype('email-message');
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`gmail-provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, 'Gmail Owner')
    RETURNING id::text`;
  userId = user.id;
  await setPersonalVaultEnabled(org.adminSql, WS, userId, true, 'owner');
  registry = createProviderRegistry();
  const adapter = gmail.providerAdapter;
  await registry.register({ descriptor: await adapter.describe(), adapter, pluginName: 'gmail' });
});

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(() => {
  emitted = [];
});

describe('Gmail syncs through the host connector driver (D-017)', () => {
  it('backfills a fresh mailbox into the owner Vault exactly once, then a replayed history delivers nothing', async () => {
    const src = await connectGmail(ACCOUNT);
    const mailbox: Mailbox = {
      account: ACCOUNT,
      messages: new Set(['m1', 'm2', 'm3']),
      history: {
        '500': { json: { history: [{ messagesAdded: [{ message: { id: 'm3' } }] }], historyId: '510' } },
      },
      pages: { start: { messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'bf-2' }, 'bf-2': { messages: [{ id: 'm3' }] } },
    };
    const api = gmailApi(() => src, mailbox);

    const first = await sync(src, api);
    expect(first).toMatchObject({ outcome: 'synced', mode: 'backfill', admitted: 3, hasMore: false });
    const keys = ['m1', 'm2', 'm3'].map((id) => receivedKey(src, id)).sort();
    expect([...new Set((await ledger(src)).map((row) => row.dedupe_key))].sort()).toEqual(keys);
    for (const row of await ledger(src)) expect(row.n, row.dedupe_key).toBe(1);
    // The profile historyId was pinned before any read, and the cursor committed past every page.
    expect(api.seen.findIndex((r) => r.url.endsWith('/profile'))).toBe(0);
    const after = await sourceState(src);
    expect(after.backfill_status).toBe('complete');
    expect(after.cursor).toMatchObject({ v: 1, emailAddress: ACCOUNT, historyId: '510', backfill: { status: 'complete' } });

    // The message landed in the owner's Vault as the canonical email-message the reply rail reads.
    const doc = await resolveCanonicalDocument(org.adminSql, {
      workspaceId: WS,
      userId,
      source: CANONICAL_SOURCE_BY_DATATYPE['email-message'],
      externalId: 'm1',
      sourceId: src,
    });
    expect(doc.payload).toMatchObject({ threadId: 't-m1', messageId: '<m1@mail.example.com>', direction: 'inbound' });

    // Gmail replays m1 in a later history window: the same version, so no second delivery.
    mailbox.history['510'] = { json: { history: [{ messagesAdded: [{ message: { id: 'm1' } }] }], historyId: '520' } };
    const deliveredBefore = emitted.length;
    await makeDue(src);
    const replay = await sync(src, api);
    expect(replay).toMatchObject({ outcome: 'synced', mode: 'incremental', admitted: 0 });
    expect(replay.deduped).toBeGreaterThanOrEqual(1);
    expect(emitted.length).toBe(deliveredBefore);
    for (const row of await ledger(src)) expect(row.n, row.dedupe_key).toBe(1);
    expect((await sourceState(src)).cursor).toMatchObject({ historyId: '520' });
  });

  it('a source the retired host poller drove adopts its legacy historyId instead of re-walking the mailbox (D-020)', async () => {
    const src = await connectGmail('legacy@example.com', { historyId: '900', emailAddress: 'legacy@example.com' });
    const mailbox: Mailbox = {
      account: 'legacy@example.com',
      messages: new Set(['n1']),
      history: { '900': { json: { history: [{ messagesAdded: [{ message: { id: 'n1' } }] }], historyId: '905' } } },
      pages: {},
    };
    const api = gmailApi(() => src, mailbox);

    const outcome = await sync(src, api);
    expect(outcome).toMatchObject({ outcome: 'synced', mode: 'incremental', adopted: true, admitted: 1 });
    // No profile re-pin and no backfill listing: the legacy position was the start.
    expect(api.seen.some((r) => r.url.endsWith('/profile'))).toBe(false);
    expect(api.seen.some((r) => new URL(r.url).pathname.endsWith('/messages'))).toBe(false);
    expect(new URL(api.seen.find((r) => r.url.includes('/history?'))!.url).searchParams.get('startHistoryId')).toBe('900');
    expect((await sourceState(src)).cursor).toMatchObject({ historyId: '905', backfill: { status: 'complete' } });
    // One delivery key, admitted once into each of the source's sinks.
    expect([...new Set((await ledger(src)).map((row) => row.dedupe_key))]).toEqual([receivedKey(src, 'n1')]);
    for (const row of await ledger(src)) expect(row.n, row.dedupe_key).toBe(1);
  });

  it('a Gmail 429 backs the source off and leaves its committed cursor where it was', async () => {
    const src = await connectGmail('limited@example.com', { historyId: '700', emailAddress: 'limited@example.com' });
    const mailbox: Mailbox = {
      account: 'limited@example.com',
      messages: new Set(),
      history: { '700': { status: 429, headers: { 'retry-after': '120' }, json: { error: { message: 'Rate Limit Exceeded' } } } },
      pages: {},
    };
    const outcome = await sync(src, gmailApi(() => src, mailbox));
    expect(outcome.outcome).toBe('rate-limited');
    const state = await sourceState(src);
    expect(state.cursor).toMatchObject({ historyId: '700' });
    expect(state.next_in ?? 0).toBeGreaterThan(60);
    expect(await ledger(src)).toEqual([]);
  });

  // Negative control for the Google cutover (P-011 / R-15, D-003): the owner's 2026-09-29
  // instruction (directive #869) forbids automatic Gmail draft replies after sync or reconnect.
  // The real trigger-binding sink runs here, so an armed control binding on the same event proves
  // the deliveries reached the binding engine; only then is "the draft binding queued nothing"
  // a measurement rather than an absence.
  it('sync never auto-drafts: a disarmed draft-reply binding queues nothing and nothing is drafted or sent (D-003)', async () => {
    const account = 'no-auto-draft@example.com';
    const src = await connectGmail(account);
    const bind = async (operationId: string, armed: boolean): Promise<string> => {
      const [row] = await org.adminSql<{ id: string }[]>`
        INSERT INTO harness_shared.trigger_bindings (workspace_id, source_id, event_pattern, action, armed)
        VALUES (${WS}, ${src}::uuid, 'ext:gmail:message.received',
                ${JSON.stringify({ type: 'blueprint-operation', operationHarnessSlug: 'email', operationId })}::text::jsonb,
                ${armed})
        RETURNING id::text`;
      return row.id;
    };
    // The automatic draft-reply binding as the cutover carries it: disarmed.
    const draftReply = await bind('draft-reply-for-trigger', false);
    const control = await bind('p011-armed-control', true);
    const mailbox: Mailbox = {
      account,
      messages: new Set(['n1', 'n2']),
      history: {},
      pages: { start: { messages: [{ id: 'n1' }, { id: 'n2' }] } },
    };
    const api = gmailApi(() => src, mailbox);

    expect(await sync(src, api)).toMatchObject({ outcome: 'synced', mode: 'backfill', admitted: 2 });

    const runs = await org.adminSql<{ binding_id: string; n: number }[]>`
      SELECT binding_id::text, count(*)::int AS n
        FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND binding_id IN (${draftReply}::uuid, ${control}::uuid)
       GROUP BY binding_id`;
    expect(Object.fromEntries(runs.map((r) => [r.binding_id, r.n]))).toEqual({ [control]: 2 });
    const [binding] = await org.adminSql<{ armed: boolean }[]>`
      SELECT armed FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS} AND id = ${draftReply}::uuid`;
    expect(binding.armed).toBe(false);
    // Sync only reads: no draft, send or any other write reached Gmail.
    expect(api.seen.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.url}`)).toEqual([]);
  });
});

describe('Gmail mail verbs dispatch through the registered provider (D-017 / D-019)', () => {
  let src: string;
  let api: ReturnType<typeof gmailApi>;
  let deps: MailDeps;

  beforeAll(async () => {
    src = await connectGmail('verbs@example.com');
    api = gmailApi(() => src, {
      account: 'verbs@example.com',
      messages: new Set(['r1']),
      history: {},
      pages: { start: { messages: [{ id: 'r1' }] } },
    });
    expect(await sync(src, api)).toMatchObject({ outcome: 'synced', admitted: 1 });
    deps = {
      registry,
      hostFetchFor: (_sql, target) => {
        expect(target.source.id).toBe(src);
        return api.fetch;
      },
      probeMailbox: allowAllMailboxProbe,
      readAttachment: async (path) => {
        if (!path.endsWith('deck.pdf')) throw new Error(`unexpected attachment ${path}`);
        return Buffer.from('%PDF-1.4 deck');
      },
    };
  });

  beforeEach(() => {
    api.seen.length = 0;
  });

  it('mail:reply drafts in the received thread with In-Reply-To from the stored message', async () => {
    const reply = await replyToCanonicalMail(
      org.adminSql,
      { workspaceId: WS, userId, messageId: 'r1', text: 'Thanks, Ada.', mode: 'draft', agentOwnerId: null },
      deps,
    );
    const posts = api.seen.filter((r) => r.method === 'POST');
    expect(posts.map((r) => new URL(r.url).pathname)).toEqual(['/gmail/v1/users/me/drafts']);
    const draft = posts[0].body?.message as { raw: string; threadId: string };
    expect(draft.threadId).toBe('t-r1');
    const raw = decodeRaw(draft.raw);
    expect(raw).toMatch(/^In-Reply-To: <r1@mail\.example\.com>\r$/m);
    expect(raw).toMatch(/^Subject: Re: Subject r1\r$/m);
    expect(raw).toMatch(/^To: .*ada@example\.com.*\r$/m);
    expect(singlePartBody(raw)).toContain('Thanks, Ada.');
    expect(reply).toMatchObject({ mode: 'draft', threadId: 't-r1', subject: 'Re: Subject r1' });
  });

  it('mail:send sends a new message carrying every declared attachment', async () => {
    const sent = await sendNewMail(
      org.adminSql,
      {
        workspaceId: WS,
        userId,
        to: ['carol@example.com'],
        subject: 'Deck',
        text: 'Attached.',
        provenance: OWNER_INSTRUCTION,
        sourceId: src,
        attachments: [{ path: '/virtual/deck.pdf' }],
        agentOwnerId: null,
      },
      deps,
    );
    const posts = api.seen.filter((r) => r.method === 'POST');
    expect(posts.map((r) => new URL(r.url).pathname)).toEqual(['/gmail/v1/users/me/messages/send']);
    expect(posts[0].body).not.toHaveProperty('threadId');
    const raw = decodeRaw(posts[0].body?.raw);
    expect(raw).toMatch(/^To: carol@example\.com\r$/m);
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('filename="deck.pdf"');
    expect(raw).toContain(Buffer.from('%PDF-1.4 deck').toString('base64'));
    expect(sent).toMatchObject({ threadId: 'thread-new-send' });
  });

  it('mail:draft creates an unthreaded draft in the chosen account', async () => {
    const drafted = await draftNewMail(
      org.adminSql,
      {
        workspaceId: WS,
        userId,
        to: ['carol@example.com'],
        subject: 'Notes',
        text: 'Draft body.',
        provenance: OWNER_INSTRUCTION,
        sourceId: src,
      },
      deps,
    );
    const posts = api.seen.filter((r) => r.method === 'POST');
    expect(posts.map((r) => new URL(r.url).pathname)).toEqual(['/gmail/v1/users/me/drafts']);
    expect(posts[0].body?.message).not.toHaveProperty('threadId');
    expect(decodeRaw((posts[0].body?.message as { raw: string }).raw)).toMatch(/^Subject: Notes\r$/m);
    expect(drafted).toMatchObject({ threadId: 'thread-new-draft' });
  });
});
