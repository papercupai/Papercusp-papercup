/**
 * R-13 / P-006 (D-023) — the email and calendar apps are provider-neutral, as
 * seen from the PLATFORM side of the seam, on real Postgres.
 *
 * Two registered providers, neither of them Google, are connected for one
 * owner and deliberately reuse ONE native id for both a message and an event.
 * Records enter through the production ingestion path into each source's own
 * Vault, and leave through the production reconcile sweep (`reconcileOnePair`)
 * into the exact JSON body each app's `/api/sync` receives. The test then plays
 * the APP's half of the contract: it writes back through the shared verbs with
 * only what the app holds for a row — its native id and its source id — which
 * is what the email app's `MailDraftGateway` (`mail:reply { mode:'draft' }`)
 * and the calendar app's update path send.
 *
 * Falsifiers pinned here:
 *  - the batch names a PROVIDER instead of the producer's sync stream, or the
 *    cursor probe asks for a provider-named stream (D-023 §2);
 *  - two providers' rows collapse onto one app row, or a row carries the other
 *    provider's source (D-010);
 *  - an app-originated reply or update reaches a provider other than the one
 *    owning the record's source, or silently picks one when the source is
 *    omitted for an id two sources share.
 *
 * HTTP is mocked at two boundaries only: the app (a recorder standing in for
 * `/api/sync`) and each provider's `host.fetch`. Everything between them is the
 * production code.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { HostFetch, ProviderAdapter, ProviderDescriptor } from '@papercusp/plugin-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getDatatype, upsertDatatype } from '../datatype-registry-store';
import { ingestExternalTriggerEvent } from '../external-triggers/ingestion';
import { createProviderRegistry, type ProviderRegistry } from '../integrations/provider-registry';
import { createPersonalVaultExternalSinkForSource } from '../personal-vault/live-sink';
import { setPersonalVaultEnabled } from '../personal-vault/store';
import { deleteCalendarEvent, updateCalendarEvent, type CalendarDeps } from '../capability-verbs/calendar';
import { allowAllMailboxProbe } from '../capability-verbs/deliverability';
import { replyToCanonicalMail, type MailDeps } from '../capability-verbs/mail';
import { APP_SYNC_SOURCE_REF, appRowId } from './app-rows';
import type { ProducerApp } from './owner-mapping';
import { reconcileOnePair } from './reconcile';

const WS = 'provider-neutral-apps-test';
const APP_SECRET = 'provider-neutral-apps-secret';
const APP_BASE = 'http://app.test';
const SHARED_MESSAGE = 'shared-native-message';
const SHARED_EVENT = 'shared-native-event';
const CORRESPONDENT = 'carol@example.com';

interface FakeProvider {
  kind: string;
  host: string;
  account: string;
}

/** Two non-Google providers: an Outlook-shaped kind and a second, distinct kind. */
const OUTLOOK: FakeProvider = { kind: 'outlook-fixture', host: 'api.outlook.test', account: 'me@outlook.test' };
const FASTMAIL: FakeProvider = { kind: 'fastmail-fixture', host: 'api.fastmail.test', account: 'me@fastmail.test' };
const PROVIDERS = [OUTLOOK, FASTMAIL] as const;

let org: OrgTestDb;
let registry: ProviderRegistry;
let userId: string;
const sourceOf = new Map<string, string>();

/** Every provider-boundary HTTP request, in order. */
let providerRequests: Array<{ host: string; path: string; body: Record<string, unknown> }>;
/** Every request the app recorder received, in order. */
let appRequests: Array<{ method: string; url: URL; body: Record<string, unknown> | null }>;

function descriptor(p: FakeProvider): ProviderDescriptor {
  return {
    id: p.kind,
    contractVersion: 1,
    datatypes: ['email-message', 'calendar-event'],
    capabilities: ['mail.read', 'mail.draft', 'calendar.read', 'calendar.write'],
    egressHosts: [p.host],
  };
}

/** A provider that reaches its API only through `host.fetch`, as a real plugin must. */
function adapter(p: FakeProvider, desc: ProviderDescriptor): ProviderAdapter {
  return {
    describe: () => desc,
    syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
    invoke: async (request, providerHost: { fetch: HostFetch }) => {
      const response = await providerHost.fetch({
        source: request.source,
        request: {
          url: `https://${p.host}/${request.capability}/${String(request.args.operation)}`,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: request.source, ...request.args }),
        },
      });
      return JSON.parse(response.body) as Record<string, unknown>;
    },
  };
}

/** The mocked HTTP layer behind every provider's `host.fetch`. */
const providerHttp = (async (input: URL | RequestInfo, init?: RequestInit) => {
  const url = new URL(String(input));
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  providerRequests.push({ host: url.hostname, path: url.pathname, body });
  const tag = `${url.hostname}:${String(body.source)}`;
  return new Response(
    JSON.stringify({
      messageId: `msg@${tag}`,
      threadId: String(body.threadId ?? `thread@${tag}`),
      draftId: `draft@${tag}`,
      id: String(body.eventId ?? `event@${tag}`),
      htmlLink: `https://${url.hostname}/event`,
      status: 'confirmed',
      attendees: body.attendees ?? [],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}) as typeof fetch;

/** The app recorder: an empty cursor, then accept every batch. */
const appHttp = (async (input: URL | RequestInfo, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  appRequests.push({ method, url, body });
  const payload = url.pathname === '/api/sync/cursor' ? { ok: true, cursor: null } : { ok: true };
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const mailDeps = (): MailDeps => ({ registry, hostFetchImpl: providerHttp, probeMailbox: allowAllMailboxProbe });
const calendarDeps = (): CalendarDeps => ({ registry, hostFetchImpl: providerHttp });

async function copyDatatype(id: string): Promise<void> {
  const base = await getDatatype(org.adminSql, 'papercusp-workspace', id);
  if (!base) throw new Error(`provider_neutral_apps_test_datatype_missing:${id}`);
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
    createdBy: 'provider-neutral-apps-integration',
  });
}

async function connect(p: FakeProvider): Promise<string> {
  const [row] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, owner_user_id, provider_account_id, status)
    VALUES (${WS}, ${p.kind}, ${userId}, ${p.account}, 'ready')
    RETURNING id::text`;
  return row.id;
}

async function ingest(
  sourceId: string,
  kind: string,
  datatypeId: 'email-message' | 'calendar-event',
  externalId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const sink = await createPersonalVaultExternalSinkForSource(org.adminSql, WS, sourceId);
  await ingestExternalTriggerEvent(
    org.adminSql,
    {
      workspaceId: WS,
      sourceId,
      source: kind,
      event: datatypeId === 'email-message' ? 'message.received' : 'event-created',
      externalId,
      datatypeId,
      adapterPayload: payload,
      normalize: (p) => p as Record<string, unknown>,
      occurredAt: '2026-10-01T09:00:00Z',
      additionalSinks: [sink],
    },
    { emit: async (event) => ({ ok: true, key: event.key, woken: 0, notified: [], msgId: null, waiters: 0 }) },
  );
}

/**
 * Independent oracle for "the stream ref names no provider". Comparing against
 * `APP_SYNC_SOURCE_REF` alone would pass for any value of that constant,
 * including a provider name.
 */
function expectProviderNeutralStreamRef(ref: unknown): void {
  expect(ref).toBe(APP_SYNC_SOURCE_REF);
  expect(typeof ref === 'string' && ref.length > 0).toBe(true);
  expect(String(ref)).not.toMatch(/gmail|google|gcal|outlook|fastmail|microsoft|imap/i);
  for (const p of PROVIDERS) expect(String(ref)).not.toContain(p.kind);
}

/** Run the production reconcile for one app and return the body the app received. */
async function reconcileBatch(app: ProducerApp): Promise<Record<string, unknown>> {
  appRequests = [];
  const result = await reconcileOnePair(
    org.adminSql,
    WS,
    { userId, app, ownerId: `provider-neutral-${app}-owner` },
    { baseUrl: APP_BASE, secret: APP_SECRET, fetchImpl: appHttp },
  );
  expect(result, `${app} reconcile`).toMatchObject({ outcome: 'delivered', rowsDelivered: 2, batches: 1 });
  const posts = appRequests.filter((r) => r.method === 'POST' && r.url.pathname === '/api/sync');
  expect(posts).toHaveLength(1);
  return posts[0]!.body!;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  await copyDatatype('email-message');
  await copyDatatype('calendar-event');
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`provider-neutral-apps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, 'Neutral Owner')
    RETURNING id::text`;
  userId = user.id;
  await setPersonalVaultEnabled(org.adminSql, WS, userId, true, 'owner');

  registry = createProviderRegistry();
  for (const p of PROVIDERS) {
    const desc = descriptor(p);
    await registry.register({ descriptor: desc, adapter: adapter(p, desc), pluginName: `${p.kind}-plugin` });
    const sid = await connect(p);
    sourceOf.set(p.kind, sid);
    // Same native ids on both providers: only the source keeps them apart.
    await ingest(sid, p.kind, 'email-message', SHARED_MESSAGE, {
      id: SHARED_MESSAGE,
      from: CORRESPONDENT,
      to: [p.account],
      subject: `Hello via ${p.kind}`,
      text: 'Body',
      threadId: `${p.kind}-thread`,
      messageId: `<${SHARED_MESSAGE}@${p.host}>`,
      direction: 'inbound',
    });
    await ingest(sid, p.kind, 'calendar-event', SHARED_EVENT, {
      id: SHARED_EVENT,
      summary: `Standup on ${p.kind}`,
      organizer: p.account,
      attendees: [CORRESPONDENT],
    });
  }
});

afterAll(async () => {
  if (org && userId) {
    await org.adminSql`DELETE FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`.catch(() => {});
    await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${userId}::uuid`.catch(() => {});
  }
  await org?.cleanup();
});

beforeEach(() => {
  providerRequests = [];
  appRequests = [];
});

describe('R-13: the apps receive provider-neutral batches (D-023 §2)', () => {
  it('sends both providers\' messages in one batch under the stream ref, keyed and attributed by source', async () => {
    const body = await reconcileBatch('email');

    // The cursor probe and the batch name the producer's stream, never a provider.
    const cursorProbe = appRequests.find((r) => r.url.pathname === '/api/sync/cursor');
    expectProviderNeutralStreamRef(cursorProbe?.url.searchParams.get('sourceRef'));
    expectProviderNeutralStreamRef(body.sourceRef);

    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages.map((m) => m.id).sort()).toEqual(
      PROVIDERS.map((p) => appRowId(SHARED_MESSAGE, sourceOf.get(p.kind))).sort(),
    );
    for (const p of PROVIDERS) {
      const sid = sourceOf.get(p.kind)!;
      const row = messages.find((m) => m.id === appRowId(SHARED_MESSAGE, sid))!;
      expect(row.nativeId).toBe(SHARED_MESSAGE);
      // Provenance is the record's own source and account, never the other provider's.
      expect(row.mailbox).toMatchObject({ sourceId: sid, providerAccountId: p.account, key: `source:${sid}` });
      expect(row.threadId).toBe(`${p.kind}-thread`);
    }
  });

  it('sends both providers\' events in one batch under the stream ref, each carrying its source', async () => {
    const body = await reconcileBatch('calendar');
    expectProviderNeutralStreamRef(body.sourceRef);

    const events = body.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
    for (const p of PROVIDERS) {
      const sid = sourceOf.get(p.kind)!;
      const row = events.find((e) => e.id === appRowId(SHARED_EVENT, sid));
      expect(row, `${p.kind} event row`).toBeDefined();
      expect(row).toMatchObject({ nativeId: SHARED_EVENT, sourceId: sid, summary: `Standup on ${p.kind}` });
    }
  });
});

describe('R-13: app-originated writes dispatch to the provider owning the record\'s source (D-023 §3)', () => {
  it('drafts a reply through mail:reply { mode:"draft" } on the provider that holds each message', async () => {
    const body = await reconcileBatch('email');
    providerRequests = [];
    const messages = body.messages as Array<{ nativeId: string; mailbox: { sourceId: string } }>;

    // Exactly what the email app's MailDraftGateway sends for a row it holds.
    for (const row of messages) {
      await replyToCanonicalMail(
        org.adminSql,
        { workspaceId: WS, userId, messageId: row.nativeId, sourceId: row.mailbox.sourceId, text: 'Thanks', mode: 'draft', agentOwnerId: null },
        mailDeps(),
      );
    }

    expect(providerRequests).toHaveLength(2);
    for (const p of PROVIDERS) {
      const sid = sourceOf.get(p.kind)!;
      const sent = providerRequests.filter((r) => r.body.source === sid);
      expect(sent, `${p.kind} reply`).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        host: p.host,
        path: '/mail.draft/create',
        body: { source: sid, to: [CORRESPONDENT], threadId: `${p.kind}-thread`, inReplyTo: `<${SHARED_MESSAGE}@${p.host}>` },
      });
    }
  });

  it('updates each event through the provider that holds it', async () => {
    const body = await reconcileBatch('calendar');
    providerRequests = [];
    const events = body.events as Array<{ nativeId: string; sourceId: string }>;

    for (const row of events) {
      await updateCalendarEvent(
        org.adminSql,
        { workspaceId: WS, userId, eventId: row.nativeId, sourceId: row.sourceId, summary: 'Moved', agentOwnerId: null },
        calendarDeps(),
      );
    }

    expect(providerRequests.map((r) => `${r.host}${r.path}:${String(r.body.source)}`).sort()).toEqual(
      PROVIDERS.map((p) => `${p.host}/calendar.write/update:${sourceOf.get(p.kind)}`).sort(),
    );
    for (const request of providerRequests) {
      expect(request.body).toMatchObject({ eventId: SHARED_EVENT, summary: 'Moved' });
    }
  });

  it('deletes each event through the provider that holds it (WI-10006509)', async () => {
    const body = await reconcileBatch('calendar');
    providerRequests = [];
    const events = body.events as Array<{ nativeId: string; sourceId: string }>;

    // Exactly what the calendar app's gateway sends for a stored row: its native id under its source.
    const results = [];
    for (const row of events) {
      results.push(await deleteCalendarEvent(
        org.adminSql,
        { workspaceId: WS, userId, eventId: row.nativeId, sourceId: row.sourceId, agentOwnerId: null },
        calendarDeps(),
      ));
    }

    expect(providerRequests.map((r) => `${r.host}${r.path}:${String(r.body.source)}`).sort()).toEqual(
      PROVIDERS.map((p) => `${p.host}/calendar.write/delete:${sourceOf.get(p.kind)}`).sort(),
    );
    for (const request of providerRequests) expect(request.body).toMatchObject({ operation: 'delete', eventId: SHARED_EVENT });
    expect(results.map((r) => r.sourceId).sort()).toEqual(events.map((row) => row.sourceId).sort());
  });

  it('refuses, before any provider call, a write that omits the source for an id two sources share', async () => {
    await expect(replyToCanonicalMail(
      org.adminSql,
      { workspaceId: WS, userId, messageId: SHARED_MESSAGE, text: 'Thanks', mode: 'draft', agentOwnerId: null },
      mailDeps(),
    )).rejects.toThrow(/canonical_document_ambiguous/);
    await expect(updateCalendarEvent(
      org.adminSql,
      { workspaceId: WS, userId, eventId: SHARED_EVENT, summary: 'Moved', agentOwnerId: null },
      calendarDeps(),
    )).rejects.toThrow(/canonical_document_ambiguous/);
    await expect(deleteCalendarEvent(
      org.adminSql,
      { workspaceId: WS, userId, eventId: SHARED_EVENT, agentOwnerId: null },
      calendarDeps(),
    )).rejects.toThrow(/canonical_document_ambiguous/);
    expect(providerRequests).toEqual([]);
  });
});
