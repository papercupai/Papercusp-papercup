import { describe, expect, it } from 'vitest';
import { personalDocumentFromExternalEvent } from '../personal-vault/live-sink';
import {
  appForDatatype,
  appRowFromSourceRecord,
  appRowId,
  DATATYPE_FOR_APP,
  APP_SYNC_SOURCE_REF,
  buildAppSyncBatch,
  type ProducerSourceRecord,
} from './app-rows';
import { APP_DELIVERY_TIMEOUT_MS, deliverAppSyncBatch } from './live-sink';

const SECRET = 'delivery-test-secret';

const gmailEvent = {
  key: 'ext:gmail:message.received',
  datatypeId: 'email-message',
  externalId: 'm-1',
  occurredAt: '2026-08-30T01:02:03.000Z',
  payload: {
    id: 'm-1',
    threadId: 't-1',
    from: 'Sender <sender@example.com>',
    to: ['me@example.com'],
    cc: [],
    subject: 'Hello',
    text: 'Could you reply?',
    labels: ['INBOX', 'UNREAD'],
  },
};

const gcalEvent = {
  key: 'ext:gcal:event.upcoming',
  datatypeId: 'calendar-event',
  externalId: 'e-1',
  occurredAt: '2026-08-30T09:00:00.000Z',
  payload: {
    id: 'e-1',
    summary: 'Standup',
    description: 'Daily sync',
    organizer: 'organizer@example.com',
    attendees: [{ email: 'a@example.com' }],
    start: '2026-08-30T09:00:00.000Z',
    end: '2026-08-30T09:15:00.000Z',
    location: 'Room 1',
  },
};

describe('app row mapping (P-011)', () => {
  it('routes each canonical datatype to its app (D-010), never a provider name', () => {
    expect(appForDatatype('email-message')).toBe('email');
    expect(appForDatatype('calendar-event')).toBe('calendar');
    expect(appForDatatype('social-post')).toBeNull();
    // Provider-named categories are not routing keys any more.
    expect(appForDatatype('gmail')).toBeNull();
    expect(appForDatatype('calendar')).toBeNull();
    expect(DATATYPE_FOR_APP).toEqual({ email: 'email-message', calendar: 'calendar-event' });
    expect(appRowId('m-1', '11111111-1111-4111-8111-111111111111')).toBe('11111111-1111-4111-8111-111111111111:m-1');
    expect(appRowId('m-1', null)).toBe('m-1');
  });

  // D-023 §2: the batch sourceRef names the producer's sync STREAM. A
  // provider-named ref ('gmail', 'google-calendar') would mislabel every other
  // provider's rows riding in the same batch.
  it('names the sync stream with one provider-neutral ref for both apps', () => {
    expect(APP_SYNC_SOURCE_REF).toBe('papercusp-vault');
    for (const app of ['email', 'calendar'] as const) {
      const body = buildAppSyncBatch(app, [{ id: 'x' }]).body;
      expect(body.sourceRef).toBe(APP_SYNC_SOURCE_REF);
      expect(String(body.sourceRef)).not.toMatch(/gmail|google|gcal|outlook/i);
    }
  });

  it('maps a gmail event to an email message row, passing the payload through', () => {
    const mapped = appRowFromSourceRecord(personalDocumentFromExternalEvent(gmailEvent));
    expect(mapped?.app).toBe('email');
    expect(mapped?.row).toMatchObject({
      id: 'm-1',
      threadId: 't-1',
      from: 'Sender <sender@example.com>',
      to: ['me@example.com'],
      subject: 'Hello',
      text: 'Could you reply?',
      labels: ['INBOX', 'UNREAD'],
    });
  });

  it('carries server-owned Gmail source and provider account provenance into the mailbox contract', () => {
    const mapped = appRowFromSourceRecord({
      source: 'gmail', datatypeId: 'email-message', kind: 'message', externalId: 'm-account',
      sourceId: '11111111-1111-4111-8111-111111111111',
      providerAccountId: 'work@example.com',
      metadata: { id: 'm-account', threadId: 'shared-thread' },
    });
    expect(mapped?.row).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111:m-account',
      nativeId: 'm-account',
      mailbox: {
        key: 'source:11111111-1111-4111-8111-111111111111',
        sourceId: '11111111-1111-4111-8111-111111111111',
        providerAccountId: 'work@example.com',
        address: 'work@example.com',
        provenance: 'explicit',
      },
    });
  });

  it('maps a gcal event to a calendar event row', () => {
    const mapped = appRowFromSourceRecord(personalDocumentFromExternalEvent(gcalEvent));
    expect(mapped?.app).toBe('calendar');
    expect(mapped?.row).toMatchObject({
      id: 'e-1',
      summary: 'Standup',
      description: 'Daily sync',
      organizer: 'organizer@example.com',
      start: '2026-08-30T09:00:00.000Z',
      end: '2026-08-30T09:15:00.000Z',
    });
  });

  // A vault-only source must be SKIPPED, not guessed at. Returning null lets
  // the sink report a delivered no-op instead of inventing a destination.
  it('returns null for a source no app owns', () => {
    const facebook = personalDocumentFromExternalEvent({
      key: 'ext:facebook:post.created',
      datatypeId: 'social-post',
      externalId: 'p-1',
      payload: { entityType: 'post', text: 'hi', author: 'Someone' },
    });
    expect(appRowFromSourceRecord(facebook)).toBeNull();
  });

  it('refuses a record with no external id — the apps upsert by id', () => {
    const record: ProducerSourceRecord = { source: 'gmail', datatypeId: 'email-message', kind: 'message', externalId: null, metadata: {} };
    expect(() => appRowFromSourceRecord(record)).toThrow('app_row_external_id_required:email-message:message');
  });

  it('fills subject/text from the canonical columns only when the payload lacks them', () => {
    const sparse: ProducerSourceRecord = {
      source: 'gmail', datatypeId: 'email-message', kind: 'message', externalId: 'm-9',
      title: 'Column subject', text: 'Column body', metadata: { id: 'm-9' },
    };
    expect(appRowFromSourceRecord(sparse)?.row).toMatchObject({ subject: 'Column subject', text: 'Column body' });

    const rich: ProducerSourceRecord = {
      ...sparse, metadata: { id: 'm-9', subject: 'Payload subject', text: 'Payload body' },
    };
    expect(appRowFromSourceRecord(rich)?.row).toMatchObject({ subject: 'Payload subject', text: 'Payload body' });
  });

  /**
   * THE PROPERTY P-011 TURNS ON: "a separate push-only payload shape is how the
   * two silently diverge." Push maps a freshly normalized event; reconcile maps
   * the row read back out of documents. This asserts the two produce
   * the IDENTICAL app row, rather than leaving it to be true by inspection.
   */
  it('push and reconcile produce byte-identical app rows', () => {
    for (const event of [gmailEvent, gcalEvent]) {
      // Push: straight from the normalized trigger event.
      const pushed = appRowFromSourceRecord(personalDocumentFromExternalEvent(event));

      // Reconcile: what a stored documents row looks like when read
      // back — same fields, metadata round-tripped through JSON as Postgres
      // jsonb would, occurredAt rehydrated as a Date by the driver.
      const stored = personalDocumentFromExternalEvent(event);
      const reconciled = appRowFromSourceRecord({
        source: stored.source,
        datatypeId: stored.datatypeId,
        kind: stored.kind,
        externalId: stored.externalId,
        occurredAt: stored.occurredAt ? new Date(stored.occurredAt as string) : null,
        title: stored.title,
        text: stored.text,
        metadata: JSON.parse(JSON.stringify(stored.metadata)) as Record<string, unknown>,
      });

      expect(reconciled).toEqual(pushed);
    }
  });

  it('builds the strict batch body each app accepts', () => {
    const email = buildAppSyncBatch('email', [{ id: 'm-1' }], { cursor: 'cur-1' });
    expect(email.body).toEqual({ messages: [{ id: 'm-1' }], sourceRef: 'papercusp-vault', cursor: 'cur-1' });
    expect(email.rowCount).toBe(1);

    const calendar = buildAppSyncBatch('calendar', [{ id: 'e-1' }]);
    expect(calendar.body).toEqual({ events: [{ id: 'e-1' }], calendars: [], sourceRef: 'papercusp-vault' });
    // crm P-003 (D-017 point 4): people come from the platform graph, so no app batch carries
    // a `contacts` key. The apps can only drop it from their strict schemas once this holds.
    expect('contacts' in email.body).toBe(false);
    expect('contacts' in calendar.body).toBe(false);
    // No cursor key at all when none is supplied — the schemas are .strict(),
    // so an explicit undefined would be a different (rejected) body.
    expect('cursor' in calendar.body).toBe(false);
  });

  // One row and many rows go through the SAME assembly, which is what makes the
  // push a genuine single-row batch rather than a parallel format.
  it('assembles one row and many rows identically apart from the rows', () => {
    const one = buildAppSyncBatch('email', [{ id: 'a' }]);
    const many = buildAppSyncBatch('email', [{ id: 'a' }, { id: 'b' }]);
    expect(Object.keys(one.body).sort()).toEqual(Object.keys(many.body).sort());
    expect(many.rowCount).toBe(2);
  });
});

describe('app delivery (P-011)', () => {
  function fetchStub(handler: (url: string, init: RequestInit) => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  const batch = buildAppSyncBatch('email', [{ id: 'm-1', subject: 'Hello' }]);

  it('POSTs the batch to /api/sync with a bearer token for the mapped owner', async () => {
    const { impl, calls } = fetchStub(() => new Response(JSON.stringify({ ok: true, messages: 1 }), { status: 200 }));
    const result = await deliverAppSyncBatch(batch, 'owner-42', {
      baseUrl: 'http://127.0.0.1:9999/', secret: SECRET, fetchImpl: impl,
    });

    expect(result).toMatchObject({ app: 'email', ownerId: 'owner-42', status: 200, rowCount: 1 });
    expect(calls).toHaveLength(1);
    // Trailing slash normalized — not '.../api/sync' doubled.
    expect(calls[0]!.url).toBe('http://127.0.0.1:9999/api/sync');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization.startsWith('Bearer ')).toBe(true);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(batch.body);
  });

  // The apps answer 200 with { ok:false, error } on a bad batch. Reading that
  // as success is exactly how a broken producer looks healthy.
  it('treats a 200 { ok:false } envelope as a REJECTION', async () => {
    const { impl } = fetchStub(() => new Response(JSON.stringify({ ok: false, error: 'bad_batch' }), { status: 200 }));
    await expect(deliverAppSyncBatch(batch, 'owner-42', { baseUrl: 'http://x', secret: SECRET, fetchImpl: impl }))
      .rejects.toThrow('app_delivery_rejected:email: bad_batch');
  });

  it('throws on a non-2xx, carrying the app error text into the delivery ledger', async () => {
    const { impl } = fetchStub(() => new Response('unauthorized', { status: 401 }));
    await expect(deliverAppSyncBatch(batch, 'owner-42', { baseUrl: 'http://x', secret: SECRET, fetchImpl: impl }))
      .rejects.toThrow('app_delivery_rejected:email:401');
  });

  it('throws a named error when the app is unreachable', async () => {
    const impl = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(deliverAppSyncBatch(batch, 'owner-42', { baseUrl: 'http://x', secret: SECRET, fetchImpl: impl }))
      .rejects.toThrow('app_delivery_unreachable:email');
  });

  it('bounds a delivery so a hung app cannot stall ingestion', async () => {
    const { impl, calls } = fetchStub(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await deliverAppSyncBatch(batch, 'owner-42', { baseUrl: 'http://x', secret: SECRET, fetchImpl: impl });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(APP_DELIVERY_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
