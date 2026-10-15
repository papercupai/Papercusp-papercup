/**
 * Google Calendar on the provider contract, end to end against a real database
 * (plan generalized-integrations-google-migration-cupboard-workflows-2026-10-05, P-009 / D-021).
 *
 * The REAL bundled package (`libs/papercusp/plugins/google-calendar`) is registered in a real
 * provider registry exactly as the plugin loader registers it, and only the Calendar REST API is
 * scripted behind `host.fetch`. Everything between is production code: the host connector driver
 * (`runConnectorSync`: lease, cursor commit, adoption, cursor reset, backoff), the ingestion ledger
 * (`harness_shared.trigger_deliveries`), the owner's Personal Vault sink, and the outbound calendar
 * verbs (`calendar:propose` / `calendar:update`) through `resolveCapabilitySource` +
 * `invokeOutboundProvider`.
 *
 * Falsifiers pinned here: an unchanged event is delivered twice by a later pass or by a full
 * resync after an expired sync token (D-021.3); a source the retired host poll drove re-sweeps its
 * whole calendar instead of adopting the legacy sync token, or re-announces an upcoming event the
 * poll already announced (D-021.5 / D-021.6); a Calendar 429 advances the cursor; the configured
 * calendar is ignored; a proposal or update reaches the wrong account, drops sendUpdates=all, or
 * patches fields the caller did not supply.
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { HostFetch, HostFetchRequest, HostFetchResponse, ProviderAdapter } from '@papercusp/plugin-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { deleteCalendarEvent, proposeCalendarEvent, updateCalendarEvent, type CalendarDeps } from '../../capability-verbs/calendar';
import { CANONICAL_SOURCE_BY_DATATYPE, resolveCanonicalDocument } from '../../capability-verbs/resolve';
import { getDatatype, upsertDatatype } from '../../datatype-registry-store';
import { ingestExternalTriggerEvent, type IngestExternalTriggerInput } from '../../external-triggers/ingestion';
import { createProviderRegistry, type ProviderRegistry } from '../../integrations/provider-registry';
import { setPersonalVaultEnabled } from '../../personal-vault/store';
import { connectorRecordDedupeKey, runConnectorSync, type ConnectorSourceOutcome } from '../connector-runtime';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const require = createRequire(import.meta.url);
const gcal = require(join(REPO_ROOT, 'libs/papercusp/plugins/google-calendar/index.cjs')) as { providerAdapter: ProviderAdapter };

const WS = 'gcal-provider-integration';
const OWNER_INSTRUCTION = { from: 'owner-instruction' } as const;

let org: OrgTestDb;
let registry: ProviderRegistry;
let userId: string;
/** Dedupe key of every REAL event-bus delivery (a deduped replay never emits). */
let emitted: string[];

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function event(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    status: 'confirmed',
    summary: `Event ${id}`,
    organizer: { email: 'ada@example.com' },
    attendees: [{ email: 'ada@example.com' }, { email: 'bob@example.com', responseStatus: 'accepted' }],
    created: '2026-09-01T00:00:00.000Z',
    updated: '2026-09-02T00:00:00.000Z',
    start: { dateTime: '2026-11-02T15:00:00.000Z' },
    end: { dateTime: '2026-11-02T15:30:00.000Z' },
    ...extra,
  };
}

interface Calendar {
  /** Full-sweep events.list answers per pageToken (`start` = no token). */
  full: Record<string, unknown>;
  /** Incremental answers per syncToken; an unscripted token returns no changes and the same token. */
  incremental: Record<string, { status?: number; headers?: Record<string, string>; json: unknown }>;
  /** The single-event upcoming window (one page). */
  upcoming: unknown[];
}

interface SeenRequest {
  source: string;
  method: string;
  calendarId: string;
  url: URL;
  body: Record<string, unknown> | null;
}

/** The Calendar REST API behind `host.fetch`, bound to one expected source. */
function calendarApi(expectedSource: () => string, calendar: Calendar) {
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
    const url = new URL(request.url);
    const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) throw new Error(`gcal integration: unscripted request ${method} ${request.url}`);
    const calendarId = decodeURIComponent(match[1]);
    const eventId = match[2] ? decodeURIComponent(match[2]) : null;
    seen.push({ source, method, calendarId, url, body });
    // The provider must spend exactly the source the host bound this call to.
    expect(source).toBe(expectedSource());
    if (method === 'GET' && !eventId) {
      if (url.searchParams.get('singleEvents') === 'true') return respond(200, { items: calendar.upcoming });
      const syncToken = url.searchParams.get('syncToken');
      if (syncToken) {
        const answer = calendar.incremental[syncToken] ?? { json: { items: [], nextSyncToken: syncToken } };
        return respond(answer.status ?? 200, answer.json, answer.headers);
      }
      return respond(200, calendar.full[url.searchParams.get('pageToken') ?? 'start'] ?? { items: [], nextSyncToken: 'sync-empty' });
    }
    if (method === 'POST' && !eventId) {
      return respond(200, {
        id: `created-${seen.length}`,
        htmlLink: `https://calendar.google.com/created-${seen.length}`,
        status: 'confirmed',
        attendees: body?.attendees ?? [],
      });
    }
    if (method === 'PATCH' && eventId) return respond(200, { id: eventId, status: 'confirmed', attendees: [] });
    if (method === 'DELETE' && eventId) return { status: 204, headers: {}, body: '', bodyEncoding: 'utf8' };
    throw new Error(`gcal integration: unscripted request ${method} ${request.url}`);
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

/** A connected calendar account owned by the test user; `cursor` seeds the retired host poll's state. */
async function connectCalendar(
  account: string,
  cursor: Record<string, unknown> = {},
  config: Record<string, unknown> = {},
): Promise<string> {
  const [row] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, owner_user_id, provider_account_id, credential_ref, status, cursor, config)
    VALUES (${WS}, 'gcal', ${userId}, ${account}, 'test-credential-ref', 'ready',
            ${org.adminSql.json(cursor as never)}, ${org.adminSql.json(config as never)})
    RETURNING id::text`;
  return row.id;
}

async function sync(sourceId: string, api: ReturnType<typeof calendarApi>): Promise<ConnectorSourceOutcome> {
  const result = await runConnectorSync(
    org.adminSql,
    { workspaceId: WS, harness: 'papercusp', sourceIds: [sourceId], pollIntervalSeconds: 300 },
    {
      registry,
      ingest,
      hostFetchFor: () => api.fetch,
      servicesFor: async () => undefined,
      leaseOwner: 'gcal-integration-driver',
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
  const [row] = await org.adminSql<{ provider: string | null; backfill_status: string; next_in: number | null }[]>`
    SELECT cursor->>'provider' AS provider, backfill_status,
           EXTRACT(EPOCH FROM sync_next_attempt_at - now())::float8 AS next_in
      FROM harness_shared.data_sources
     WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
  return { ...row, cursor: row.provider ? (JSON.parse(row.provider) as Record<string, any>) : null };
}

async function deliveryKeys(sourceId: string): Promise<Array<{ dedupe_key: string; n: number }>> {
  return org.adminSql<Array<{ dedupe_key: string; n: number }>>`
    SELECT dedupe_key, count(*)::int AS n
      FROM harness_shared.trigger_deliveries
     WHERE workspace_id = ${WS} AND source_id = ${sourceId}::uuid
     GROUP BY dedupe_key, sink_kind
     ORDER BY dedupe_key`;
}

const distinctKeys = async (sourceId: string) => [...new Set((await deliveryKeys(sourceId)).map((row) => row.dedupe_key))].sort();

const changeKey = (sourceId: string, nativeId: string, version: string) =>
  connectorRecordDedupeKey(sourceId, { datatype: 'calendar-event', nativeId, event: 'event-created', payload: {}, version: `change:${version}` });
const upcomingKey = (sourceId: string, nativeId: string, start: string) =>
  connectorRecordDedupeKey(sourceId, { datatype: 'calendar-event', nativeId, event: 'event-upcoming', payload: {}, version: `upcoming:${start}` });

async function copyDatatype(id: string): Promise<void> {
  const base = await getDatatype(org.adminSql, 'papercusp-workspace', id);
  if (!base) throw new Error(`gcal_integration_datatype_missing:${id}`);
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
    createdBy: 'gcal-provider-integration',
  });
}

beforeAll(async () => {
  org = await createOrgTestDb();
  await copyDatatype('calendar-event');
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`gcal-provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, 'Calendar Owner')
    RETURNING id::text`;
  userId = user.id;
  await setPersonalVaultEnabled(org.adminSql, WS, userId, true, 'owner');
  registry = createProviderRegistry();
  const adapter = gcal.providerAdapter;
  await registry.register({ descriptor: await adapter.describe(), adapter, pluginName: 'google-calendar' });
});

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(() => {
  emitted = [];
});

describe('Google Calendar syncs through the host connector driver (D-021)', () => {
  it('sweeps a fresh calendar into the owner Vault once; a later pass and a full resync after an expired token deliver nothing new', async () => {
    const src = await connectCalendar('owner@example.com');
    const soonStart = iso(5 * 60_000);
    const calendar: Calendar = {
      full: {
        start: { items: [event('a'), event('b')], nextPageToken: 'p2' },
        p2: { items: [event('c', { start: { dateTime: soonStart }, end: { dateTime: iso(35 * 60_000) } })], nextSyncToken: 'sync-1' },
      },
      incremental: {},
      upcoming: [event('c', { start: { dateTime: soonStart }, end: { dateTime: iso(35 * 60_000) } })],
    };
    const api = calendarApi(() => src, calendar);

    const first = await sync(src, api);
    expect(first).toMatchObject({ outcome: 'synced', admitted: 4, hasMore: false });
    const expected = [
      changeKey(src, 'a', '2026-09-02T00:00:00.000Z'),
      changeKey(src, 'b', '2026-09-02T00:00:00.000Z'),
      changeKey(src, 'c', '2026-09-02T00:00:00.000Z'),
      upcomingKey(src, 'c', soonStart),
    ].sort();
    expect(await distinctKeys(src)).toEqual(expected);
    for (const row of await deliveryKeys(src)) expect(row.n, row.dedupe_key).toBe(1);
    // Every list read the owner's primary calendar; the changes sweep showed deletions.
    expect(new Set(api.seen.map((r) => r.calendarId))).toEqual(new Set(['primary']));
    expect(api.seen[0].url.searchParams.get('showDeleted')).toBe('true');
    expect((await sourceState(src)).cursor).toMatchObject({ v: 1, phase: 'changes', syncToken: 'sync-1' });

    // The event landed in the owner's Vault as the canonical calendar-event the update rail reads.
    const doc = await resolveCanonicalDocument(org.adminSql, {
      workspaceId: WS,
      userId,
      source: CANONICAL_SOURCE_BY_DATATYPE['calendar-event'],
      externalId: 'a',
      sourceId: src,
    });
    expect(doc.payload).toMatchObject({ id: 'a', summary: 'Event a', organizer: 'ada@example.com', start: '2026-11-02T15:00:00.000Z' });

    // A later pass: Google reports b again unchanged and c is still upcoming. Same versions, no delivery.
    const deliveredBefore = emitted.length;
    expect(deliveredBefore).toBeGreaterThan(0);
    calendar.incremental['sync-1'] = { json: { items: [event('b')], nextSyncToken: 'sync-2' } };
    await makeDue(src);
    const again = await sync(src, api);
    expect(again).toMatchObject({ outcome: 'synced', admitted: 0 });
    expect(again.deduped).toBeGreaterThanOrEqual(2);
    expect(emitted.length).toBe(deliveredBefore);

    // The sync token expires: the driver resets the cursor and re-sweeps, and the resync is deduped.
    calendar.incremental['sync-2'] = { status: 410, json: { error: { message: 'Sync token is no longer valid, a full sync is required.' } } };
    calendar.full.p2 = { items: [event('c', { start: { dateTime: soonStart }, end: { dateTime: iso(35 * 60_000) } })], nextSyncToken: 'sync-3' };
    await makeDue(src);
    const reset = await sync(src, api);
    expect(reset).toMatchObject({ outcome: 'synced', cursorReset: true, admitted: 0 });
    expect(emitted.length).toBe(deliveredBefore);
    expect(await distinctKeys(src)).toEqual(expected);
    for (const row of await deliveryKeys(src)) expect(row.n, row.dedupe_key).toBe(1);
    expect((await sourceState(src)).cursor).toMatchObject({ syncToken: 'sync-3' });
  });

  it('a source the retired host poll drove adopts its sync token and skips upcoming events that poll already announced (D-021.5/.6)', async () => {
    const lastPoll = iso(-60_000);
    const src = await connectCalendar('legacy@example.com', { syncToken: 'legacy-tok', lastSyncAt: lastPoll });
    const announcedStart = iso(2 * 60_000);
    const freshStart = iso(4 * 60_000);
    const editedAt = iso(-30_000);
    const calendar: Calendar = {
      full: {},
      incremental: { 'legacy-tok': { json: { items: [event('edited', { updated: editedAt })], nextSyncToken: 'after-legacy' } } },
      upcoming: [
        event('announced', { updated: iso(-60 * 60_000), start: { dateTime: announcedStart }, end: { dateTime: iso(30 * 60_000) } }),
        event('fresh', { updated: iso(-10_000), start: { dateTime: freshStart }, end: { dateTime: iso(30 * 60_000) } }),
      ],
    };
    const api = calendarApi(() => src, calendar);

    const outcome = await sync(src, api);
    expect(outcome).toMatchObject({ outcome: 'synced', mode: 'incremental', adopted: true, admitted: 2 });
    // No full sweep: the first list read continued from the legacy token.
    const lists = api.seen.filter((r) => r.method === 'GET' && r.url.searchParams.get('singleEvents') !== 'true');
    expect(lists.map((r) => r.url.searchParams.get('syncToken'))).toEqual(['legacy-tok']);
    // The change continues from the legacy token; 'announced' is skipped, 'fresh' changed after the poll ran.
    expect(await distinctKeys(src)).toEqual([changeKey(src, 'edited', editedAt), upcomingKey(src, 'fresh', freshStart)].sort());
    expect((await sourceState(src)).cursor).toMatchObject({ syncToken: 'after-legacy', legacyUpcoming: { from: lastPoll } });
  });

  it('a Calendar 429 backs the source off and leaves its committed cursor where it was', async () => {
    const src = await connectCalendar('limited@example.com', { syncToken: 'limited-tok', lastSyncAt: iso(-60_000) });
    // The first pass adopts the legacy cursor and commits it before the limit hits.
    const calendar: Calendar = {
      full: {},
      incremental: {
        'limited-tok': { status: 429, headers: { 'retry-after': '120' }, json: { error: { message: 'Rate Limit Exceeded' } } },
      },
      upcoming: [],
    };
    const outcome = await sync(src, calendarApi(() => src, calendar));
    expect(outcome.outcome).toBe('rate-limited');
    const state = await sourceState(src);
    expect(state.cursor).toMatchObject({ syncToken: 'limited-tok' });
    expect(state.next_in ?? 0).toBeGreaterThan(60);
    expect(await deliveryKeys(src)).toEqual([]);
  });

  it('reads the calendar the source is configured for', async () => {
    const src = await connectCalendar('team@example.com', {}, { calendarId: 'team@group.calendar.google.com' });
    const api = calendarApi(() => src, { full: { start: { items: [], nextSyncToken: 't' } }, incremental: {}, upcoming: [] });
    expect(await sync(src, api)).toMatchObject({ outcome: 'synced' });
    expect(new Set(api.seen.map((r) => r.calendarId))).toEqual(new Set(['team@group.calendar.google.com']));
  });
});

describe('calendar verbs dispatch through the registered provider (D-021)', () => {
  let src: string;
  let api: ReturnType<typeof calendarApi>;
  let deps: CalendarDeps;

  beforeAll(async () => {
    src = await connectCalendar('verbs@example.com');
    api = calendarApi(() => src, { full: { start: { items: [event('held')], nextSyncToken: 'v-1' } }, incremental: {}, upcoming: [] });
    expect(await sync(src, api)).toMatchObject({ outcome: 'synced', admitted: 1 });
    deps = {
      registry,
      hostFetchFor: (_sql, target) => {
        expect(target.source.id).toBe(src);
        return api.fetch;
      },
    };
  });

  beforeEach(() => {
    api.seen.length = 0;
  });

  it('calendar:propose creates the event in the chosen account, in its time zone, notifying every invitee', async () => {
    const proposed = await proposeCalendarEvent(
      org.adminSql,
      {
        workspaceId: WS,
        userId,
        summary: 'Kickoff',
        start: '2026-11-03T10:00:00-05:00',
        end: '2026-11-03T10:30:00-05:00',
        timeZone: 'America/New_York',
        attendees: ['carol@example.com'],
        provenance: OWNER_INSTRUCTION,
        sourceId: src,
        agentOwnerId: null,
      },
      deps,
    );
    const writes = api.seen.filter((r) => r.method !== 'GET');
    expect(writes.map((r) => [r.method, r.calendarId])).toEqual([['POST', 'primary']]);
    expect(writes[0].url.searchParams.get('sendUpdates')).toBe('all');
    expect(writes[0].body).toEqual({
      summary: 'Kickoff',
      start: { dateTime: '2026-11-03T10:00:00-05:00', timeZone: 'America/New_York' },
      end: { dateTime: '2026-11-03T10:30:00-05:00', timeZone: 'America/New_York' },
      attendees: [{ email: 'carol@example.com' }],
    });
    expect(proposed).toMatchObject({ id: expect.stringMatching(/^created-/), summary: 'Kickoff', attendees: ['carol@example.com'] });
  });

  it('calendar:update patches only the supplied fields of a held event through the source that holds it', async () => {
    const updated = await updateCalendarEvent(
      org.adminSql,
      { workspaceId: WS, userId, eventId: 'held', location: 'Room 9', agentOwnerId: null },
      deps,
    );
    const writes = api.seen.filter((r) => r.method !== 'GET');
    expect(writes.map((r) => [r.method, r.calendarId, r.url.pathname.split('/').pop()])).toEqual([['PATCH', 'primary', 'held']]);
    expect(writes[0].url.searchParams.get('sendUpdates')).toBe('all');
    expect(writes[0].body).toEqual({ location: 'Room 9' });
    expect(updated).toMatchObject({ id: 'held', summary: 'Event held' });
  });

  it('calendar:delete cancels a held event through the source that holds it, and refuses an event the owner does not hold', async () => {
    const deleted = await deleteCalendarEvent(org.adminSql, { workspaceId: WS, userId, eventId: 'held', agentOwnerId: null }, deps);
    const writes = api.seen.filter((r) => r.method !== 'GET');
    expect(writes.map((r) => [r.method, r.calendarId, r.url.pathname.split('/').pop()])).toEqual([['DELETE', 'primary', 'held']]);
    expect(writes[0].url.searchParams.get('sendUpdates')).toBe('all');
    expect(deleted).toMatchObject({ id: 'held', nativeId: 'held', status: 'cancelled', summary: 'Event held' });
    expect(deleted.sourceId).toEqual(expect.any(String));

    api.seen.length = 0;
    await expect(
      deleteCalendarEvent(org.adminSql, { workspaceId: WS, userId, eventId: 'read-out-of-a-message', agentOwnerId: null }, deps),
    ).rejects.toThrow();
    expect(api.seen.filter((r) => r.method !== 'GET')).toEqual([]);
  });
});
