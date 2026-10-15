/**
 * Google Calendar provider contract evidence (plan generalized-integrations-google-migration-cupboard-workflows-2026-10-05,
 * P-009 / D-021).
 *
 * The cutover deleted the host Calendar poll and its tests, so these drive the REAL bundled package
 * (`libs/papercusp/plugins/google-calendar`) through its public `providerAdapter` with `host.fetch`
 * stubbed: the canonical `calendar-event` mapping (the former host normalizer's rules), the cursor
 * phases (sync-token changes, then the upcoming window), the namespaced delivery versions, the
 * legacy-upcoming skip after adoption, calendar selection, the sync error classes the host
 * interprets, and the outbound calendar verbs.
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostFetch, HostFetchRequest, HostFetchResponse, ProviderAdapter, ProviderSyncPage } from '@papercusp/plugin-sdk';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const require = createRequire(import.meta.url);
const gcal = require(join(REPO_ROOT, 'libs/papercusp/plugins/google-calendar/index.cjs')) as {
  providerAdapter: ProviderAdapter;
  _internal: {
    normalizeEvent: (event: Record<string, unknown>) => Record<string, unknown>;
    decodeCursor: (raw: string | null) => Record<string, any> | null;
    adoptCursor: (prior: unknown) => { cursor: string | null; backfillComplete: boolean };
  };
};
const adapter = gcal.providerAdapter;
const SOURCE = '00000000-0000-4000-8000-0000000000cc';
const API = 'https://www.googleapis.com/calendar/v3';
const NOW = new Date('2026-10-06T12:00:00.000Z');

type Answer = { status?: number; json?: unknown; headers?: Record<string, string>; raw?: string };
type Route = (request: HostFetchRequest, url: URL) => Answer | undefined;

/** A host.fetch that answers by URL and records every request it saw. */
function host(route: Route) {
  const calls: HostFetchRequest[] = [];
  const fetch: HostFetch = async ({ source, request }) => {
    expect(source).toBe(SOURCE);
    calls.push(request);
    const answer = route(request, new URL(request.url));
    if (!answer) throw new Error(`unexpected request ${request.method ?? 'GET'} ${request.url}`);
    const response: HostFetchResponse = {
      status: answer.status ?? 200,
      headers: answer.headers ?? {},
      body: answer.raw ?? (answer.json === undefined ? '' : JSON.stringify(answer.json)),
      bodyEncoding: 'utf8',
    };
    return response;
  };
  return { fetch, calls };
}

function event(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    status: 'confirmed',
    summary: `Event ${id}`,
    created: '2026-10-01T09:00:00.000Z',
    updated: '2026-10-02T09:00:00.000Z',
    start: { dateTime: '2026-10-06T12:05:00.000Z' },
    end: { dateTime: '2026-10-06T12:35:00.000Z' },
    ...extra,
  };
}

async function syncPage(cursor: string | null, route: Route, config: Record<string, unknown> = {}) {
  const h = host(route);
  const page = (await adapter.syncPage(
    { source: SOURCE, cursor, mode: cursor ? 'incremental' : 'backfill', config },
    h,
  )) as ProviderSyncPage;
  return { page, calls: h.calls, urls: h.calls.map((c) => new URL(c.url)), cursor: gcal._internal.decodeCursor(page.nextCursor) };
}

async function syncError(route: Route, cursor: string | null = null) {
  return syncPage(cursor, route).then(
    () => {
      throw new Error('expected the page to fail');
    },
    (error: Error & { kind?: string; retryAfterSeconds?: number; notFound?: boolean }) => error,
  );
}

function invoke(capability: string, args: Record<string, unknown>, route: Route) {
  const h = host(route);
  return { result: adapter.invoke!({ source: SOURCE, capability, args }, h), calls: h.calls };
}

/** A cursor in the given state, encoded the way the plugin stores it. */
function cursorOf(state: Record<string, unknown>) {
  return JSON.stringify({
    v: 1,
    phase: 'changes',
    syncToken: null,
    pageToken: null,
    lastSyncAt: null,
    changesStartedAt: null,
    upcoming: { pageToken: null, windowStart: null },
    legacyUpcoming: null,
    ...state,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('calendar-event mapping (the former host normalizer rules)', () => {
  it('maps organizer, attendees, timed and all-day dates, recurrence and conference data', () => {
    const normalized = gcal._internal.normalizeEvent({
      id: 'e1',
      summary: 'Planning',
      description: 'Agenda',
      organizer: { email: 'ada@example.com', displayName: 'Ada' },
      attendees: [
        { email: 'bob@example.com', displayName: 'Bob', responseStatus: 'accepted', self: false, comment: 'dropped' },
        { email: 'me@example.com', self: true },
      ],
      start: { dateTime: '2026-10-07T10:00:00-04:00', timeZone: 'America/New_York' },
      end: { date: '2026-10-08' },
      location: 'Room 1',
      status: 'confirmed',
      htmlLink: 'https://calendar.google.com/e1',
      created: '2026-10-01T00:00:00Z',
      updated: '2026-10-02T00:00:00Z',
      recurringEventId: 'series-1',
      originalStartTime: { dateTime: '2026-10-07T10:00:00-04:00' },
      sequence: 2,
      attachments: [{ fileUrl: 'https://drive.example.com/f' }],
      conferenceData: { conferenceId: 'abc-defg-hij' },
      etag: '"not-mapped"',
    });
    expect(normalized).toEqual({
      id: 'e1',
      summary: 'Planning',
      description: 'Agenda',
      organizer: 'ada@example.com',
      attendees: [
        { email: 'bob@example.com', displayName: 'Bob', responseStatus: 'accepted', self: false },
        { email: 'me@example.com', self: true },
      ],
      start: '2026-10-07T10:00:00-04:00',
      end: '2026-10-08',
      location: 'Room 1',
      status: 'confirmed',
      htmlLink: 'https://calendar.google.com/e1',
      created: '2026-10-01T00:00:00Z',
      updated: '2026-10-02T00:00:00Z',
      recurringEventId: 'series-1',
      originalStart: '2026-10-07T10:00:00-04:00',
      sequence: 2,
      attachments: [{ fileUrl: 'https://drive.example.com/f' }],
      conferenceData: { conferenceId: 'abc-defg-hij' },
    });
  });

  it('falls back to the organizer display name and omits empty fields', () => {
    expect(gcal._internal.normalizeEvent({ id: 'e2', organizer: { displayName: 'Room' }, summary: '' })).toEqual({
      id: 'e2',
      organizer: 'Room',
    });
  });

  it('refuses an event without an id', () => {
    expect(() => gcal._internal.normalizeEvent({ summary: 'x' })).toThrow('google_calendar_event_id_required');
  });
});

describe('sync phases', () => {
  it('a fresh source sweeps every event as event-created, then hands over to the upcoming window', async () => {
    const first = await syncPage(null, (_r, url) =>
      url.searchParams.get('pageToken') ? undefined : { json: { items: [event('a')], nextPageToken: 'p2' } },
    );
    expect(first.urls[0]!.pathname).toBe('/calendar/v3/calendars/primary/events');
    expect(first.urls[0]!.searchParams.get('showDeleted')).toBe('true');
    expect(first.urls[0]!.searchParams.has('syncToken')).toBe(false);
    expect(first.page.records).toEqual([
      expect.objectContaining({
        datatype: 'calendar-event',
        nativeId: 'a',
        event: 'event-created',
        version: 'change:2026-10-02T09:00:00.000Z',
        occurredAt: '2026-10-06T12:05:00.000Z',
      }),
    ]);
    expect(first.page.hasMore).toBe(true);
    expect(first.cursor).toMatchObject({ phase: 'changes', pageToken: 'p2', syncToken: null, changesStartedAt: NOW.toISOString() });

    // The sweep started at NOW; it finishes a minute later, and lastSyncAt is the sweep START.
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const last = await syncPage(first.page.nextCursor, (_r, url) =>
      url.searchParams.get('pageToken') === 'p2' ? { json: { items: [event('b')], nextSyncToken: 'sync-1' } } : undefined,
    );
    expect(last.page.records.map((r) => [r.nativeId, r.event])).toEqual([['b', 'event-created']]);
    expect(last.page.hasMore).toBe(true);
    expect(last.cursor).toMatchObject({
      phase: 'upcoming',
      syncToken: 'sync-1',
      pageToken: null,
      lastSyncAt: NOW.toISOString(),
      changesStartedAt: null,
    });
  });

  it('an incremental sweep classifies events created after the last sweep as created, the rest (cancellations too) as updated', async () => {
    const cursor = cursorOf({ syncToken: 'sync-1', lastSyncAt: '2026-10-05T00:00:00.000Z' });
    const { page, urls } = await syncPage(cursor, () => ({
      json: {
        items: [
          event('new', { created: '2026-10-05T06:00:00.000Z', updated: '2026-10-05T06:00:00.000Z' }),
          event('old', { created: '2026-09-01T00:00:00.000Z', updated: undefined, etag: '"etag-7"' }),
          { id: 'gone', status: 'cancelled', sequence: 3 },
        ],
        nextSyncToken: 'sync-2',
      },
    }));
    expect(urls[0]!.searchParams.get('syncToken')).toBe('sync-1');
    expect(page.records.map((r) => [r.nativeId, r.event, r.version])).toEqual([
      ['new', 'event-created', 'change:2026-10-05T06:00:00.000Z'],
      ['old', 'event-updated', 'change:"etag-7"'],
      ['gone', 'event-updated', 'change:sequence-3'],
    ]);
    expect(page.records[2]!.payload).toEqual({ id: 'gone', status: 'cancelled', sequence: 3 });
  });

  it('the upcoming phase reads single events in [now, now + lead) and ends the pass', async () => {
    const cursor = cursorOf({ phase: 'upcoming', syncToken: 'sync-1', lastSyncAt: NOW.toISOString() });
    const { page, urls, cursor: next } = await syncPage(
      cursor,
      () => ({
        json: {
          items: [
            event('soon'),
            { id: 'all-day', start: { date: '2026-10-06' }, end: { date: '2026-10-07' }, updated: '2026-10-02T00:00:00Z' },
            { id: 'no-start', summary: 'skipped' },
          ],
        },
      }),
      { leadMinutes: 30 },
    );
    const params = urls[0]!.searchParams;
    expect(params.get('singleEvents')).toBe('true');
    expect(params.get('orderBy')).toBe('startTime');
    expect(params.get('showDeleted')).toBe('false');
    expect(params.get('timeMin')).toBe(NOW.toISOString());
    expect(params.get('timeMax')).toBe(new Date(NOW.getTime() + 30 * 60_000).toISOString());
    expect(page.records.map((r) => [r.nativeId, r.event, r.version])).toEqual([
      ['soon', 'event-upcoming', 'upcoming:2026-10-06T12:05:00.000Z'],
      ['all-day', 'event-upcoming', 'upcoming:2026-10-06'],
    ]);
    expect(page.hasMore).toBe(false);
    expect(next).toMatchObject({
      phase: 'changes',
      syncToken: 'sync-1',
      upcoming: { pageToken: null, windowStart: null, windowEnd: null, coveredUntil: new Date(NOW.getTime() + 30 * 60_000).toISOString() },
    });
  });

  it('pages the upcoming window on one fixed windowStart', async () => {
    const cursor = cursorOf({ phase: 'upcoming', syncToken: 'sync-1' });
    const first = await syncPage(cursor, () => ({ json: { items: [event('u1')], nextPageToken: 'up-2' } }));
    expect(first.page.hasMore).toBe(true);
    expect(first.cursor).toMatchObject({ phase: 'upcoming', upcoming: { pageToken: 'up-2', windowStart: NOW.toISOString() } });

    vi.setSystemTime(new Date(NOW.getTime() + 5_000));
    const second = await syncPage(first.page.nextCursor, (_r, url) =>
      url.searchParams.get('pageToken') === 'up-2' ? { json: { items: [] } } : undefined,
    );
    expect(second.urls[0]!.searchParams.get('timeMin')).toBe(NOW.toISOString());
    expect(second.page.hasMore).toBe(false);
  });

  describe('a sync outage longer than the lead (WI-10006640)', () => {
    const LEAD = 15 * 60_000;
    const DAY = 24 * 60 * 60_000;
    const t = NOW.getTime();
    const iso = (ms: number) => new Date(ms).toISOString();

    /** A calendar that answers the upcoming list with the events overlapping [timeMin, timeMax), like Google. */
    function calendar(events: Array<ReturnType<typeof event>>): Route {
      return (_r, url) => {
        if (url.searchParams.get('singleEvents') !== 'true') return { json: { items: [], nextSyncToken: 'sync-2' } };
        const min = Date.parse(url.searchParams.get('timeMin')!);
        const max = Date.parse(url.searchParams.get('timeMax')!);
        const overlapping = events.filter(
          (e) => Date.parse((e.end as { dateTime: string }).dateTime) > min && Date.parse((e.start as { dateTime: string }).dateTime) < max,
        );
        return { json: { items: overlapping } };
      };
    }

    it('announces an event that started and ended between two passes', async () => {
      const inGap = event('in-gap', { start: { dateTime: iso(t + LEAD + 60_000) }, end: { dateTime: iso(t + LEAD + 5 * 60_000) } });
      const route = calendar([inGap]);

      // A pass at t reads [t, t + lead): the event is not in it yet.
      const first = await syncPage(cursorOf({ phase: 'upcoming', syncToken: 'sync-1' }), route);
      expect(first.page.records).toEqual([]);
      expect(first.cursor!.upcoming).toEqual({ pageToken: null, windowStart: null, windowEnd: null, coveredUntil: iso(t + LEAD) });

      // No pass runs again until t + 2 * lead, by which time the event is over.
      vi.setSystemTime(new Date(t + 2 * LEAD));
      const changes = await syncPage(first.page.nextCursor, route);
      expect(changes.cursor).toMatchObject({ phase: 'upcoming', upcoming: { coveredUntil: iso(t + LEAD) } });

      const next = await syncPage(changes.page.nextCursor, route);
      expect(next.urls[0]!.searchParams.get('timeMin')).toBe(iso(t + LEAD));
      expect(next.urls[0]!.searchParams.get('timeMax')).toBe(iso(t + 3 * LEAD));
      expect(next.page.records.map((r) => [r.nativeId, r.event, r.version])).toEqual([
        ['in-gap', 'event-upcoming', `upcoming:${iso(t + LEAD + 60_000)}`],
      ]);
      expect(next.cursor!.upcoming.coveredUntil).toBe(iso(t + 3 * LEAD));
    });

    it('reaches back at most a day, and passes that overlap start at now', async () => {
      const stale = await syncPage(
        cursorOf({ phase: 'upcoming', syncToken: 's', upcoming: { pageToken: null, windowStart: null, coveredUntil: iso(t - 3 * DAY) } }),
        () => ({ json: { items: [] } }),
      );
      expect(stale.urls[0]!.searchParams.get('timeMin')).toBe(iso(t - DAY));
      expect(stale.urls[0]!.searchParams.get('timeMax')).toBe(iso(t + LEAD));

      const overlapping = await syncPage(
        cursorOf({ phase: 'upcoming', syncToken: 's', upcoming: { pageToken: null, windowStart: null, coveredUntil: iso(t + 10 * 60_000) } }),
        () => ({ json: { items: [] } }),
      );
      expect(overlapping.urls[0]!.searchParams.get('timeMin')).toBe(NOW.toISOString());
      expect(overlapping.urls[0]!.searchParams.get('timeMax')).toBe(iso(t + LEAD));
    });

    it('finishes a window opened by an older cursor without windowEnd on its own lead', async () => {
      const opened = iso(t - 60_000);
      const { urls, cursor } = await syncPage(
        cursorOf({ phase: 'upcoming', syncToken: 's', upcoming: { pageToken: 'up-2', windowStart: opened } }),
        (_r, url) => (url.searchParams.get('pageToken') === 'up-2' ? { json: { items: [] } } : undefined),
      );
      expect(urls[0]!.searchParams.get('timeMin')).toBe(opened);
      expect(urls[0]!.searchParams.get('timeMax')).toBe(iso(t - 60_000 + LEAD));
      expect(cursor!.upcoming.coveredUntil).toBe(iso(t - 60_000 + LEAD));
    });
  });

  it('defaults to a 15 minute lead, clamps it at a day, and reads the configured calendar', async () => {
    const upcoming = cursorOf({ phase: 'upcoming', syncToken: 's' });
    const byDefault = await syncPage(upcoming, () => ({ json: { items: [] } }));
    expect(byDefault.urls[0]!.searchParams.get('timeMax')).toBe(new Date(NOW.getTime() + 15 * 60_000).toISOString());

    const clamped = await syncPage(upcoming, () => ({ json: { items: [] } }), { leadMinutes: 99_999 });
    expect(clamped.urls[0]!.searchParams.get('timeMax')).toBe(new Date(NOW.getTime() + 24 * 60 * 60_000).toISOString());

    const team = await syncPage(null, () => ({ json: { items: [], nextSyncToken: 's' } }), { calendarId: 'team@group.calendar.google.com' });
    expect(team.urls[0]!.pathname).toBe('/calendar/v3/calendars/team%40group.calendar.google.com/events');
  });
});

describe('legacy upcoming skip after adoption (D-021.6)', () => {
  const FROM = '2026-10-06T11:55:00.000Z';
  const upcoming = cursorOf({ phase: 'upcoming', syncToken: 'sync-1', legacyUpcoming: { from: FROM } });

  it('skips what the retired poll already announced and re-announces what changed since', async () => {
    const { page } = await syncPage(upcoming, () => ({
      json: {
        items: [
          // existed at the poll's last run and starts inside its window -> already announced
          event('announced', { updated: '2026-10-06T11:00:00.000Z', start: { dateTime: '2026-10-06T12:05:00.000Z' } }),
          // moved after the poll's last run -> announce again
          event('moved', { updated: '2026-10-06T11:58:00.000Z', start: { dateTime: '2026-10-06T12:06:00.000Z' } }),
          // starts after from + lead: the poll never covered it
          event('later', { updated: '2026-10-06T11:00:00.000Z', start: { dateTime: '2026-10-06T12:11:00.000Z' } }),
          // no updated stamp: treated as announced rather than re-delivered
          { id: 'unstamped', start: { dateTime: '2026-10-06T12:01:00.000Z' } },
        ],
      },
    }));
    expect(page.records.map((r) => r.nativeId)).toEqual(['moved', 'later']);
  });

  it('keeps the marker across passes', async () => {
    const { cursor } = await syncPage(upcoming, () => ({ json: { items: [] } }));
    expect(cursor!.legacyUpcoming).toEqual({ from: FROM });
  });
});

describe('sync error classes the host interprets', () => {
  it('410 is cursor-expired', async () => {
    const error = await syncError(() => ({ status: 410, json: { error: { message: 'Sync token is no longer valid' } } }), cursorOf({ syncToken: 'old' }));
    expect(error.kind).toBe('cursor-expired');
  });

  it('429 is rate-limited and honours Retry-After', async () => {
    const error = await syncError(() => ({ status: 429, headers: { 'Retry-After': '120' } }));
    expect(error).toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 120 });
  });

  it('a quota 403 is rate-limited with the default back-off, any other 403 or 401 is auth', async () => {
    const quota = await syncError(() => ({
      status: 403,
      json: { error: { errors: [{ reason: 'rateLimitExceeded' }], message: 'Rate Limit Exceeded' } },
    }));
    expect(quota).toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 60 });
    expect((await syncError(() => ({ status: 403, json: { error: { message: 'Forbidden' } } }))).kind).toBe('auth');
    expect((await syncError(() => ({ status: 401 }))).kind).toBe('auth');
  });

  it('5xx, a non-JSON body and a missing next sync token are transient', async () => {
    expect((await syncError(() => ({ status: 503 }))).kind).toBe('transient');
    expect((await syncError(() => ({ raw: '<html>' }))).kind).toBe('transient');
    const missing = await syncError(() => ({ json: { items: [] } }));
    expect(missing).toMatchObject({ kind: 'transient', message: 'google_calendar_next_sync_token_missing' });
  });

  it('an unreadable or unrecognised cursor is cursor-expired, not a crash', async () => {
    expect((await syncError(() => ({ json: {} }), '{not json')).kind).toBe('cursor-expired');
    expect((await syncError(() => ({ json: {} }), JSON.stringify({ v: 2, phase: 'changes' }))).kind).toBe('cursor-expired');
  });
});

describe('outbound calendar verbs', () => {
  it('calendar.write create posts with sendUpdates=all and returns the event identity', async () => {
    const { result, calls } = invoke(
      'calendar.write',
      {
        operation: 'create',
        summary: '  Sync  ',
        start: '2026-10-07T10:00:00-04:00',
        end: '2026-10-07T10:30:00-04:00',
        timeZone: 'America/New_York',
        description: 'notes',
        attendees: ['bob@example.com'],
      },
      () => ({
        json: { id: 'new-1', htmlLink: 'https://calendar.google.com/new-1', status: 'confirmed', attendees: [{ email: 'bob@example.com' }] },
      }),
    );
    await expect(result).resolves.toEqual({
      id: 'new-1',
      htmlLink: 'https://calendar.google.com/new-1',
      status: 'confirmed',
      attendees: ['bob@example.com'],
    });
    const url = new URL(calls[0]!.url);
    expect(calls[0]!.method).toBe('POST');
    expect(url.pathname).toBe('/calendar/v3/calendars/primary/events');
    expect(url.searchParams.get('sendUpdates')).toBe('all');
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      summary: 'Sync',
      start: { dateTime: '2026-10-07T10:00:00-04:00', timeZone: 'America/New_York' },
      end: { dateTime: '2026-10-07T10:30:00-04:00', timeZone: 'America/New_York' },
      description: 'notes',
      attendees: [{ email: 'bob@example.com' }],
    });
  });

  it('a bare date creates an all-day event; an empty summary or unparseable time is refused before any request', async () => {
    const allDay = invoke('calendar.write', { operation: 'create', summary: 'Offsite', start: '2026-10-09', end: '2026-10-10' }, () => ({
      json: { id: 'd1' },
    }));
    await allDay.result;
    expect(JSON.parse(allDay.calls[0]!.body!)).toMatchObject({ start: { date: '2026-10-09' }, end: { date: '2026-10-10' } });

    const blank = invoke('calendar.write', { operation: 'create', summary: ' ', start: '2026-10-09', end: '2026-10-10' }, () => undefined);
    await expect(blank.result).rejects.toThrow('google_calendar_event_summary_invalid');
    const badTime = invoke('calendar.write', { operation: 'create', summary: 'x', start: 'tomorrow', end: '2026-10-10' }, () => undefined);
    await expect(badTime.result).rejects.toThrow('google_calendar_event_time_invalid:tomorrow');
    expect(blank.calls.length + badTime.calls.length).toBe(0);
  });

  it('calendar.write update patches only the supplied fields of the named event on the named calendar', async () => {
    const { result, calls } = invoke(
      'calendar.write',
      { operation: 'update', calendarId: 'team@x', eventId: 'ev/1', location: 'Room 2', description: null },
      () => ({ json: { id: 'ev/1' } }),
    );
    await result;
    const url = new URL(calls[0]!.url);
    expect(calls[0]!.method).toBe('PATCH');
    expect(url.pathname).toBe('/calendar/v3/calendars/team%40x/events/ev%2F1');
    expect(url.searchParams.get('sendUpdates')).toBe('all');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ location: 'Room 2', description: '' });

    await expect(invoke('calendar.write', { operation: 'update', eventId: 'e' }, () => undefined).result).rejects.toThrow(
      'google_calendar_event_patch_empty',
    );
    await expect(invoke('calendar.write', { operation: 'update', summary: 'x' }, () => undefined).result).rejects.toThrow(
      'google_calendar_event_id_required',
    );
  });

  it('calendar.write delete cancels the named event with sendUpdates=all; an already-cancelled event (410) is not a failure, a 404 is', async () => {
    const { result, calls } = invoke(
      'calendar.write',
      { operation: 'delete', calendarId: 'team@x', eventId: 'ev/1' },
      () => ({ status: 204 }),
    );
    await expect(result).resolves.toEqual({ id: 'ev/1', htmlLink: null, status: 'cancelled', attendees: [] });
    const url = new URL(calls[0]!.url);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.body).toBeUndefined();
    expect(url.pathname).toBe('/calendar/v3/calendars/team%40x/events/ev%2F1');
    expect(url.searchParams.get('sendUpdates')).toBe('all');

    const gone = invoke('calendar.write', { operation: 'delete', eventId: 'e1' }, () => ({
      status: 410,
      json: { error: { code: 410, message: 'Resource has been deleted' } },
    }));
    await expect(gone.result).resolves.toMatchObject({ id: 'e1', status: 'cancelled' });
    expect(new URL(gone.calls[0]!.url).pathname).toBe('/calendar/v3/calendars/primary/events/e1');

    const missing = invoke('calendar.write', { operation: 'delete', eventId: 'e1' }, () => ({ status: 404 }));
    await expect(missing.result).rejects.toMatchObject({ status: 404, notFound: true });
    await expect(invoke('calendar.write', { operation: 'delete' }, () => undefined).result).rejects.toThrow(
      'google_calendar_event_id_required',
    );
  });

  it('a write is not retried: a 5xx surfaces once', async () => {
    const { result, calls } = invoke('calendar.write', { operation: 'create', summary: 'x', start: '2026-10-09', end: '2026-10-10' }, () => ({
      status: 500,
    }));
    await expect(result).rejects.toMatchObject({ kind: 'transient', status: 500 });
    expect(calls).toHaveLength(1);
  });

  it('calendar.read returns the normalized event', async () => {
    const { result, calls } = invoke('calendar.read', { eventId: 'e1' }, () => ({ json: event('e1') }));
    await expect(result).resolves.toEqual({ event: expect.objectContaining({ id: 'e1', summary: 'Event e1', start: '2026-10-06T12:05:00.000Z' }) });
    expect(new URL(calls[0]!.url).pathname).toBe('/calendar/v3/calendars/primary/events/e1');
  });

  it('an undeclared capability is refused without a request', async () => {
    const { result, calls } = invoke('mail.send', {}, () => undefined);
    await expect(result).rejects.toThrow('provider_capability_unsupported:mail.send');
    expect(calls).toHaveLength(0);
  });
});

describe('cursor adoption from the retired host poll (D-021.5)', () => {
  it('maps the legacy syncToken and lastSyncAt (either casing) and records the poll run as the legacy marker', async () => {
    const camel = await adapter.invoke!(
      { source: SOURCE, capability: 'sync.adopt', args: { prior: { syncToken: 'legacy-tok', lastSyncAt: '2026-10-06T05:36:00Z' } } },
      host(() => undefined),
    );
    expect(camel).toMatchObject({ backfillComplete: true });
    expect(gcal._internal.decodeCursor((camel as { cursor: string }).cursor)).toEqual({
      v: 1,
      phase: 'changes',
      syncToken: 'legacy-tok',
      pageToken: null,
      lastSyncAt: '2026-10-06T05:36:00.000Z',
      changesStartedAt: null,
      upcoming: { pageToken: null, windowStart: null, windowEnd: null, coveredUntil: null },
      legacyUpcoming: { from: '2026-10-06T05:36:00.000Z' },
    });

    const snake = gcal._internal.adoptCursor({ sync_token: 'tok-2', last_sync_at: '2026-10-06T05:00:00Z' });
    expect(gcal._internal.decodeCursor(snake.cursor)).toMatchObject({ syncToken: 'tok-2', legacyUpcoming: { from: '2026-10-06T05:00:00.000Z' } });
  });

  it('adopts nothing without a sync token', () => {
    expect(gcal._internal.adoptCursor({ lastSyncAt: '2026-10-06T05:36:00Z' })).toEqual({ cursor: null, backfillComplete: false });
    expect(gcal._internal.adoptCursor(null)).toEqual({ cursor: null, backfillComplete: false });
  });

  it('the first pass after adoption continues from the legacy sync token instead of re-sweeping', async () => {
    const adopted = gcal._internal.adoptCursor({ syncToken: 'legacy-tok', lastSyncAt: '2026-10-06T05:36:00Z' }).cursor;
    const { urls, page } = await syncPage(adopted, () => ({
      json: { items: [event('edited', { created: '2026-09-01T00:00:00Z' })], nextSyncToken: 'next' },
    }));
    expect(urls[0]!.searchParams.get('syncToken')).toBe('legacy-tok');
    expect(page.records.map((r) => [r.nativeId, r.event])).toEqual([['edited', 'event-updated']]);
  });
});
