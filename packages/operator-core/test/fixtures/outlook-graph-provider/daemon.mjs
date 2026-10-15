// @ts-check
/**
 * Outlook mail and calendar provider for Papercusp, written against the public
 * plugin SDK and Microsoft Graph only. It runs as a sandboxed daemon: it has no
 * network and no credentials of its own, and reaches Graph through the host's
 * `host.fetch`, which injects the account's token on the host side.
 *
 * Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout. The host calls
 * `provider.describe`, `provider.syncPage` and `provider.invoke`; the daemon
 * calls back `host.fetch` with the `callToken` of the call it is serving.
 *
 * Sync walks Graph delta queries, one page per `syncPage` call: the inbox
 * message delta, then the calendar view delta. The cursor stores each stream's
 * pending `@odata.nextLink` and its last `@odata.deltaLink`, so the next round
 * resumes from the delta link instead of re-reading the mailbox.
 *
 * @typedef {import('@papercusp/plugin-sdk').ProviderDescriptor} ProviderDescriptor
 * @typedef {import('@papercusp/plugin-sdk').ProviderSyncRequest} ProviderSyncRequest
 * @typedef {import('@papercusp/plugin-sdk').ProviderSyncPage} ProviderSyncPage
 * @typedef {import('@papercusp/plugin-sdk').ProviderRecord} ProviderRecord
 * @typedef {import('@papercusp/plugin-sdk').ProviderSyncError} ProviderSyncError
 * @typedef {import('@papercusp/plugin-sdk').HostFetchRequest} HostFetchRequest
 * @typedef {import('@papercusp/plugin-sdk').HostFetchResponse} HostFetchResponse
 * @typedef {import('@papercusp/plugin-sdk').ProviderDaemonCallParams<ProviderSyncRequest>} SyncCallParams
 * @typedef {import('@microsoft/microsoft-graph-types').Message} GraphMessage
 * @typedef {import('@microsoft/microsoft-graph-types').Event} GraphEvent
 * @typedef {import('@microsoft/microsoft-graph-types').Recipient} GraphRecipient
 * @typedef {import('@microsoft/microsoft-graph-types').DateTimeTimeZone} GraphDateTime
 * @typedef {{ reason?: string }} GraphRemoved
 * @typedef {{ '@removed'?: GraphRemoved }} Removable
 * @typedef {'mail' | 'calendar'} Stream
 * @typedef {{ next: string | null, delta: string | null }} StreamCursor
 * @typedef {{ v: 1, stream: Stream, mail: StreamCursor, calendar: StreamCursor }} Cursor
 */

/**
 * One page of a Graph delta query.
 * @template T
 * @typedef {{ value?: Array<T & Removable>, '@odata.nextLink'?: string, '@odata.deltaLink'?: string }} DeltaPage
 */

import { readFileSync } from 'node:fs';
import readline from 'node:readline';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAIL_DELTA = `${GRAPH}/me/mailFolders/inbox/messages/delta`;
const CALENDAR_DELTA = `${GRAPH}/me/calendarView/delta`;
const DEFAULT_WINDOW = { start: '2026-10-01T00:00:00Z', end: '2027-01-01T00:00:00Z' };
const PROVIDER = 'outlook-graph';

/** @type {{ provider: ProviderDescriptor }} */
const manifest = JSON.parse(readFileSync(new URL('./papercusp.json', import.meta.url), 'utf8'));

/* ─── JSON-RPC ─── */

/** @type {Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>} */
const pending = new Map();
let nextId = 1;

/** @param {unknown} message */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * Ask the host to perform one HTTP request for the call `callToken` serves.
 * @param {string} callToken
 * @param {string} source
 * @param {HostFetchRequest} request
 * @returns {Promise<HostFetchResponse>}
 */
function hostFetch(callToken, source, request) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: (value) => resolve(/** @type {HostFetchResponse} */ (value)), reject });
    send({ jsonrpc: '2.0', id, method: 'host.fetch', params: { callToken, source, request } });
  });
}

/* ─── errors ─── */

class SyncError extends Error {
  /** @param {ProviderSyncError} failure */
  constructor(failure) {
    super(failure.message);
    this.failure = failure;
  }
}

/**
 * @param {ProviderSyncError['kind']} kind
 * @param {string} message
 * @param {number} [retryAfterSeconds]
 */
function syncError(kind, message, retryAfterSeconds) {
  return new SyncError(
    kind === 'rate-limited' && retryAfterSeconds !== undefined ? { kind, message, retryAfterSeconds } : { kind, message },
  );
}

/**
 * GET one Graph URL through the host and map its status to a sync signal.
 * @template T
 * @param {string} callToken
 * @param {string} source
 * @param {string} url
 * @returns {Promise<DeltaPage<T>>}
 */
async function graphGet(callToken, source, url) {
  /** @type {HostFetchResponse} */
  let response;
  try {
    response = await hostFetch(callToken, source, { url, method: 'GET', headers: { accept: 'application/json' } });
  } catch (error) {
    throw syncError('transient', `outlook_graph_host_fetch_refused: ${error instanceof Error ? error.message : String(error)}`);
  }
  const detail = `outlook_graph_${response.status}`;
  if (response.status === 401 || response.status === 403) throw syncError('auth', detail);
  if (response.status === 410) throw syncError('cursor-expired', detail);
  if (response.status === 429) throw syncError('rate-limited', detail, Number(response.headers['retry-after'] ?? 60));
  if (response.status >= 400) throw syncError('transient', detail);
  const text = response.bodyEncoding === 'base64' ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
  return /** @type {DeltaPage<T>} */ (JSON.parse(text));
}

/* ─── mapping: Graph -> canonical datatypes ─── */

/** @param {GraphRecipient | null | undefined} recipient */
function address(recipient) {
  const email = recipient?.emailAddress;
  if (!email?.address) return undefined;
  return email.name ? `${email.name} <${email.address}>` : email.address;
}

/** @param {Array<GraphRecipient> | null | undefined} recipients */
function addresses(recipients) {
  const list = (recipients ?? []).map(address).filter((value) => value !== undefined);
  return list.length ? list : undefined;
}

/**
 * Graph returns zone-local wall-clock times; this provider asks for UTC.
 * @param {GraphDateTime | null | undefined} value
 */
function isoInstant(value) {
  if (!value?.dateTime) return undefined;
  const wall = value.dateTime.replace(/\.\d+$/, '');
  return value.timeZone === 'UTC' ? `${wall}Z` : wall;
}

/**
 * Drop undefined fields so the canonical payload carries only what Graph sent.
 * @param {Record<string, unknown>} value
 */
function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined && field !== null));
}

/**
 * @param {GraphMessage & Removable} message
 * @returns {ProviderRecord}
 */
function mailRecord(message) {
  const id = message.id;
  if (!id) throw syncError('transient', 'outlook_graph_message_id_required');
  if (message['@removed']) {
    return { datatype: 'email-message', nativeId: id, event: 'message.deleted', payload: { id }, deleted: true, version: 'deleted' };
  }
  const body = message.body;
  const categories = message.categories ?? [];
  const payload = compact({
    id,
    threadId: message.conversationId ?? undefined,
    subject: message.subject ?? undefined,
    from: address(message.from),
    to: addresses(message.toRecipients),
    cc: addresses(message.ccRecipients),
    text: body?.contentType === 'text' ? body.content ?? undefined : undefined,
    html: body?.contentType === 'html' ? body.content ?? undefined : undefined,
    snippet: message.bodyPreview ?? undefined,
    occurredAt: message.receivedDateTime ?? undefined,
    labels: categories.length ? [...categories] : undefined,
    tags: categories.length ? [...categories] : undefined,
    messageId: message.internetMessageId ?? undefined,
    direction: 'inbound',
    extensions: { [PROVIDER]: compact({ isRead: message.isRead ?? undefined }) },
  });
  /** @type {ProviderRecord} */
  const record = { datatype: 'email-message', nativeId: id, event: 'message.received', payload, version: 'received' };
  if (message.receivedDateTime) record.occurredAt = message.receivedDateTime;
  return record;
}

/**
 * @param {GraphEvent & Removable} event
 * @returns {ProviderRecord}
 */
function calendarRecord(event) {
  const id = event.id;
  if (!id) throw syncError('transient', 'outlook_graph_event_id_required');
  if (event['@removed']) {
    return { datatype: 'calendar-event', nativeId: id, event: 'event-updated', payload: { id, status: 'cancelled' }, deleted: true, version: 'removed' };
  }
  const pattern = event.recurrence?.pattern;
  const range = event.recurrence?.range;
  const payload = compact({
    id,
    summary: event.subject ?? undefined,
    organizer: event.organizer?.emailAddress?.address ?? undefined,
    attendees: event.attendees?.map((attendee) =>
      compact({
        email: attendee.emailAddress?.address ?? undefined,
        displayName: attendee.emailAddress?.name ?? undefined,
        responseStatus: attendee.status?.response ?? undefined,
      }),
    ),
    start: isoInstant(event.start),
    end: isoInstant(event.end),
    status: event.isCancelled ? 'cancelled' : 'confirmed',
    created: event.createdDateTime ?? undefined,
    updated: event.lastModifiedDateTime ?? undefined,
    recurringEventId: event.seriesMasterId ?? undefined,
    originalStart: event.originalStart ?? undefined,
    recurrence: pattern
      ? compact({
          type: pattern.type ?? undefined,
          interval: pattern.interval ?? undefined,
          daysOfWeek: pattern.daysOfWeek ?? undefined,
          range: range ? compact({ type: range.type ?? undefined, startDate: range.startDate ?? undefined, endDate: range.endDate ?? undefined }) : undefined,
        })
      : undefined,
    extensions: { [PROVIDER]: compact({ type: event.type ?? undefined }) },
  });
  const created = event.createdDateTime && event.createdDateTime === event.lastModifiedDateTime;
  /** @type {ProviderRecord} */
  const record = {
    datatype: 'calendar-event',
    nativeId: id,
    event: created ? 'event-created' : 'event-updated',
    payload,
    version: `change:${event.lastModifiedDateTime ?? 'unknown'}`,
  };
  const occurredAt = isoInstant(event.start);
  if (occurredAt) record.occurredAt = occurredAt;
  return record;
}

/* ─── cursor ─── */

/** @returns {Cursor} */
function freshCursor() {
  return { v: 1, stream: 'mail', mail: { next: null, delta: null }, calendar: { next: null, delta: null } };
}

/**
 * @param {string | null} raw
 * @returns {Cursor}
 */
function decodeCursor(raw) {
  if (!raw) return freshCursor();
  /** @type {Partial<Cursor>} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw syncError('cursor-expired', 'outlook_graph_cursor_unreadable');
  }
  if (parsed?.v !== 1 || (parsed.stream !== 'mail' && parsed.stream !== 'calendar') || !parsed.mail || !parsed.calendar) {
    throw syncError('cursor-expired', 'outlook_graph_cursor_unrecognised');
  }
  return /** @type {Cursor} */ (parsed);
}

/** @param {Record<string, unknown> | undefined} config */
function calendarStart(config) {
  const start = typeof config?.calendarStart === 'string' ? config.calendarStart : DEFAULT_WINDOW.start;
  const end = typeof config?.calendarEnd === 'string' ? config.calendarEnd : DEFAULT_WINDOW.end;
  const url = new URL(CALENDAR_DELTA);
  url.searchParams.set('startDateTime', start);
  url.searchParams.set('endDateTime', end);
  return url.toString();
}

/* ─── provider methods ─── */

/**
 * One page of the current stream. A `nextLink` keeps the stream; a `deltaLink`
 * stores the stream's resume point and moves mail on to calendar, or ends the
 * round after calendar.
 * @param {SyncCallParams} params
 * @returns {Promise<ProviderSyncPage>}
 */
async function syncPage({ request, callToken }) {
  const cursor = decodeCursor(request.cursor);
  const stream = cursor.stream;
  const state = cursor[stream];
  const url = state.next ?? state.delta ?? (stream === 'mail' ? MAIL_DELTA : calendarStart(request.config));
  /** @type {ProviderRecord[]} */
  let records;
  /** @type {string | undefined} */
  let nextLink;
  /** @type {string | undefined} */
  let deltaLink;
  if (stream === 'mail') {
    const page = /** @type {DeltaPage<GraphMessage>} */ (await graphGet(callToken, request.source, url));
    records = (page.value ?? []).map(mailRecord);
    nextLink = page['@odata.nextLink'];
    deltaLink = page['@odata.deltaLink'];
  } else {
    const page = /** @type {DeltaPage<GraphEvent>} */ (await graphGet(callToken, request.source, url));
    records = (page.value ?? []).map(calendarRecord);
    nextLink = page['@odata.nextLink'];
    deltaLink = page['@odata.deltaLink'];
  }
  if (nextLink) {
    state.next = nextLink;
    return { records, nextCursor: JSON.stringify(cursor), hasMore: true };
  }
  state.next = null;
  if (deltaLink) state.delta = deltaLink;
  cursor.stream = stream === 'mail' ? 'calendar' : 'mail';
  return { records, nextCursor: JSON.stringify(cursor), hasMore: stream === 'mail' };
}

/**
 * @param {string} method
 * @param {unknown} params
 */
async function handle(method, params) {
  if (method === 'papercup.ping') return 'pong';
  if (method === 'provider.describe') return manifest.provider;
  if (method === 'provider.syncPage') return syncPage(/** @type {SyncCallParams} */ (params));
  if (method === 'provider.invoke') throw Object.assign(new Error('outlook_graph_capability_unsupported'), { code: -32601 });
  throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  /** @type {{ id?: number, method?: string, params?: unknown, result?: unknown, error?: { message?: string } }} */
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === undefined && message.id !== undefined) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error.message ?? 'host.fetch failed'));
    else waiter?.resolve(message.result);
    return;
  }
  try {
    send({ jsonrpc: '2.0', id: message.id, result: await handle(message.method ?? '', message.params) });
  } catch (error) {
    const failure = error instanceof SyncError ? error.failure : undefined;
    const code = /** @type {{ code?: unknown }} */ (error)?.code;
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: typeof code === 'number' ? code : -32000,
        message: error instanceof Error ? error.message : String(error),
        ...(failure ? { data: failure } : {}),
      },
    });
  }
});
