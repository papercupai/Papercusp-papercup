/**
 * Gmail provider contract evidence (plan generalized-integrations-google-migration-cupboard-workflows-2026-10-05,
 * P-008 / D-017).
 *
 * The cutover deleted the host Gmail functions and their tests, so these drive the REAL bundled
 * package (`libs/papercusp/plugins/gmail`) through its public `providerAdapter` with `host.fetch`
 * stubbed: the canonical `email-message` mapping (the former host normalizer's rules), the cursor
 * phases (pin historyId, drain history first, then one backfill page), the once-only delivery
 * version, the sync error classes the host interprets, RFC 5322 composition, and the outbound
 * mail verbs.
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { HostFetch, HostFetchRequest, HostFetchResponse, ProviderAdapter, ProviderSyncPage } from '@papercusp/plugin-sdk';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const require = createRequire(import.meta.url);
const gmail = require(join(REPO_ROOT, 'libs/papercusp/plugins/gmail/index.cjs')) as {
  providerAdapter: ProviderAdapter;
  _internal: {
    normalizeMessage: (message: Record<string, unknown>, mailbox: string | null) => Record<string, unknown>;
    buildRawMessage: (args: Record<string, unknown>) => { raw: string; threadId: string | null };
    decodeCursor: (raw: string | null) => Record<string, any> | null;
  };
};
const adapter = gmail.providerAdapter;
const SOURCE = '00000000-0000-4000-8000-0000000000bb';
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

const b64url = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

type Route = (request: HostFetchRequest) => { status?: number; json?: unknown; headers?: Record<string, string> } | undefined;

/** A host.fetch that answers by URL and records every request it saw. */
function host(route: Route) {
  const calls: HostFetchRequest[] = [];
  const fetch: HostFetch = async ({ source, request }) => {
    expect(source).toBe(SOURCE);
    calls.push(request);
    const answer = route(request);
    if (!answer) throw new Error(`unexpected request ${request.method ?? 'GET'} ${request.url}`);
    const response: HostFetchResponse = {
      status: answer.status ?? 200,
      headers: answer.headers ?? {},
      body: answer.json === undefined ? '' : JSON.stringify(answer.json),
      bodyEncoding: 'utf8',
    };
    return response;
  };
  return { fetch, calls };
}

function message(id: string, extra: Record<string, unknown> = {}) {
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
        { name: 'To', value: '"Lovelace, Ada" <ada@example.com>, bob@example.com' },
        { name: 'Subject', value: `Subject ${id}` },
        { name: 'Message-ID', value: `<${id}@mail.example.com>` },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: b64url(`plain ${id}`) } },
        { mimeType: 'text/html', body: { data: b64url(`<p>html ${id}</p>`) } },
      ],
    },
    ...extra,
  };
}

async function syncPage(cursor: string | null, route: Route) {
  const h = host(route);
  const page = (await adapter.syncPage({ source: SOURCE, cursor, mode: cursor ? 'incremental' : 'backfill' }, h)) as ProviderSyncPage;
  return { page, calls: h.calls, cursor: gmail._internal.decodeCursor(page.nextCursor) };
}

async function syncError(route: Route, cursor: string | null) {
  return syncPage(cursor, route).then(
    () => {
      throw new Error('expected the page to fail');
    },
    (error: unknown) => error as Error & { kind?: string; retryAfterSeconds?: number },
  );
}

const pinned = JSON.stringify({
  v: 1,
  emailAddress: 'me@example.com',
  historyId: '500',
  history: { pageToken: null },
  backfill: { status: 'complete', pageToken: null, messages: 3 },
  watch: {},
});

describe('gmail provider maps a mailbox message to the canonical email-message', () => {
  it('keeps the former host normalizer rules and puts raw Gmail fields under extensions.gmail', () => {
    const normalized = gmail._internal.normalizeMessage(
      message('m1', {
        labelIds: ['SENT'],
        payload: {
          ...message('m1').payload,
          parts: [
            ...message('m1').payload.parts,
            { mimeType: 'application/pdf', filename: 'deck.pdf', partId: '2', body: { attachmentId: 'att-1', size: 1234 } },
          ],
        },
      }),
      'me@example.com',
    );
    expect(normalized).toMatchObject({
      id: 'm1',
      threadId: 't-m1',
      from: 'Ada <ada@example.com>',
      to: ['"Lovelace, Ada" <ada@example.com>', 'bob@example.com'],
      subject: 'Subject m1',
      messageId: '<m1@mail.example.com>',
      text: 'plain m1',
      html: '<p>html m1</p>',
      snippet: 'snippet m1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      labels: ['SENT'],
      tags: ['SENT'],
      direction: 'outbound',
      mailbox: 'me@example.com',
      attachments: [{ attachmentId: 'att-1', filename: 'deck.pdf', mimeType: 'application/pdf', size: 1234, partId: '2' }],
      extensions: { gmail: { historyId: '501', internalDate: '1767225600000' } },
    });
  });

  it('an inbox label reads as inbound, and a message without an id is refused', () => {
    expect(gmail._internal.normalizeMessage(message('m2'), null).direction).toBe('inbound');
    expect(() => gmail._internal.normalizeMessage({ payload: {} }, null)).toThrow(/gmail_message_id_required/);
  });
});

describe('gmail syncPage cursor phases (D-017.4)', () => {
  it('a null cursor pins the profile historyId, drains history, then reads one backfill page', async () => {
    const { page, cursor, calls } = await syncPage(null, (request) => {
      if (request.url === `${BASE}/profile`) return { json: { emailAddress: 'me@example.com', historyId: '500' } };
      if (request.url.startsWith(`${BASE}/history?`)) {
        expect(request.url).toContain('startHistoryId=500');
        return { json: { history: [{ messagesAdded: [{ message: { id: 'new1' } }] }], historyId: '520' } };
      }
      if (request.url.startsWith(`${BASE}/messages?`)) return { json: { messages: [{ id: 'old1' }, { id: 'new1' }], nextPageToken: 'bf-2' } };
      const id = /\/messages\/([^/?]+)\?/.exec(request.url)?.[1];
      return id ? { json: message(id) } : undefined;
    });
    expect(page.records.map((record) => [record.nativeId, record.event, record.datatype, record.version])).toEqual([
      ['new1', 'message.received', 'email-message', 'received'],
      ['old1', 'message.received', 'email-message', 'received'],
    ]);
    expect(cursor).toMatchObject({ historyId: '520', emailAddress: 'me@example.com', backfill: { status: 'pending', pageToken: 'bf-2', messages: 1 } });
    expect(page.hasMore).toBe(true);
    // A message seen in history is not fetched a second time by the backfill page.
    expect(calls.filter((request) => request.url.includes('/messages/new1?'))).toHaveLength(1);
  });

  it('a drained history with a complete backfill reports no more pages and advances historyId', async () => {
    const { page, cursor } = await syncPage(pinned, (request) =>
      request.url.startsWith(`${BASE}/history?`) ? { json: { historyId: '600' } } : undefined,
    );
    expect(page).toMatchObject({ records: [], hasMore: false });
    expect(cursor).toMatchObject({ historyId: '600', backfill: { status: 'complete' } });
  });

  it('a further history page is drained before any backfill, and a message deleted before fetch is skipped', async () => {
    const pending = JSON.stringify({ ...JSON.parse(pinned), backfill: { status: 'pending', pageToken: 'bf-9', messages: 0 } });
    const { page, cursor, calls } = await syncPage(pending, (request) => {
      if (request.url.startsWith(`${BASE}/history?`)) {
        return { json: { history: [{ messagesAdded: [{ message: { id: 'gone' } }, { message: { id: 'kept' } }] }], nextPageToken: 'h-2' } };
      }
      if (request.url.includes('/messages/gone?')) return { status: 404, json: { error: { message: 'Not Found' } } };
      if (request.url.includes('/messages/kept?')) return { json: message('kept') };
      return undefined;
    });
    expect(page.records.map((record) => record.nativeId)).toEqual(['kept']);
    expect(page.hasMore).toBe(true);
    expect(cursor).toMatchObject({ historyId: '500', history: { pageToken: 'h-2' }, backfill: { pageToken: 'bf-9' } });
    expect(calls.some((request) => request.url.startsWith(`${BASE}/messages?`))).toBe(false);
  });

  it('an unreadable cursor is cursor-expired, so the host restarts the source', async () => {
    const error = await syncError(() => undefined, '{not json');
    expect(error.kind).toBe('cursor-expired');
  });
});

describe('gmail provisions its Pub/Sub topic and renews the push watch (D-018.3)', () => {
  // Every Pub/Sub and watch request is matched on METHOD as well as URL: Pub/Sub's
  // topics.getIamPolicy is a GET and a POST answers 404, which is how live Gmail sync
  // failed after the cutover (WI-10006554, a regression of WI-41682).
  it('creates the topic, reads its IAM policy with GET, grants Gmail publish, then watches it', async () => {
    const topic = 'projects/p-fixture/topics/gmail-push';
    const topicUrl = `https://pubsub.googleapis.com/v1/${topic}`;
    const expiresAt = Date.now() + 7 * 86_400_000;
    const h = host((request) => {
      const method = request.method ?? 'GET';
      if (request.url === topicUrl && method === 'PUT') return { status: 409, json: { error: { status: 'ALREADY_EXISTS' } } };
      if (request.url === `${topicUrl}:getIamPolicy` && method === 'GET') {
        return { json: { etag: 'etag-1', bindings: [{ role: 'roles/pubsub.viewer', members: ['user:me@example.com'] }] } };
      }
      if (request.url === `${topicUrl}:setIamPolicy` && method === 'POST') return { json: {} };
      if (request.url === `${BASE}/watch` && method === 'POST') return { json: { historyId: '500', expiration: String(expiresAt) } };
      if (request.url.startsWith(`${BASE}/history?`) && method === 'GET') return { json: { historyId: '600' } };
      return undefined;
    });

    const page = (await adapter.syncPage(
      {
        source: SOURCE,
        cursor: pinned,
        mode: 'incremental',
        services: { 'google-pubsub': { projectId: 'p-fixture', topicName: topic } },
      },
      h,
    )) as ProviderSyncPage;

    expect(h.calls.slice(0, 4).map((request) => `${request.method ?? 'GET'} ${request.url}`)).toEqual([
      `PUT ${topicUrl}`,
      `GET ${topicUrl}:getIamPolicy`,
      `POST ${topicUrl}:setIamPolicy`,
      `POST ${BASE}/watch`,
    ]);
    expect(h.calls[1].body).toBeUndefined();
    expect(JSON.parse(String(h.calls[2].body))).toEqual({
      policy: {
        etag: 'etag-1',
        bindings: [
          { role: 'roles/pubsub.viewer', members: ['user:me@example.com'] },
          { role: 'roles/pubsub.publisher', members: ['serviceAccount:gmail-api-push@system.gserviceaccount.com'] },
        ],
      },
    });
    expect(JSON.parse(String(h.calls[3].body))).toEqual({ topicName: topic });
    expect(gmail._internal.decodeCursor(page.nextCursor)).toMatchObject({
      historyId: '600',
      watch: { topicName: topic, topicReady: topic, expiration: new Date(expiresAt).toISOString() },
    });
  });
});

describe('gmail maps HTTP failures to the host sync signals (D-017.4)', () => {
  const failingHistory = (status: number, json: unknown, headers?: Record<string, string>): Route => (request) =>
    request.url.startsWith(`${BASE}/history?`) ? { status, json, headers } : undefined;

  it('429 is rate-limited with the Retry-After seconds', async () => {
    const error = await syncError(failingHistory(429, { error: { message: 'slow down' } }, { 'Retry-After': '120' }), pinned);
    expect(error).toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 120 });
  });

  it('a quota 403 is rate-limited, while another 403 or a 401 is auth', async () => {
    const quota = await syncError(failingHistory(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }], message: 'x' } }), pinned);
    expect(quota.kind).toBe('rate-limited');
    expect((await syncError(failingHistory(403, { error: { message: 'insufficient scope' } }), pinned)).kind).toBe('auth');
    expect((await syncError(failingHistory(401, { error: { message: 'expired' } }), pinned)).kind).toBe('auth');
  });

  it('a history 404 is cursor-expired and a 5xx is transient', async () => {
    expect((await syncError(failingHistory(404, { error: { message: 'gone' } }), pinned)).kind).toBe('cursor-expired');
    expect((await syncError(failingHistory(503, { error: { message: 'busy' } }), pinned)).kind).toBe('transient');
  });
});

describe('gmail composes RFC 5322 outbound messages', () => {
  const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');

  it('threads a reply with In-Reply-To and References and encodes non-ASCII headers', () => {
    const built = gmail._internal.buildRawMessage({
      to: ['Zoë <zoe@example.com>'],
      cc: ['carol@example.com'],
      subject: 'Re: Café',
      text: 'Thanks!',
      threadId: 'thread-7',
      inReplyTo: '<orig@example.com>',
      references: '<root@example.com>',
    });
    const mime = decode(built.raw);
    expect(built.threadId).toBe('thread-7');
    expect(mime).toContain('To: =?UTF-8?B?');
    expect(mime).toContain('<zoe@example.com>');
    expect(mime).toContain('Cc: carol@example.com');
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from('Re: Café', 'utf8').toString('base64')}?=`);
    expect(mime).toContain('In-Reply-To: <orig@example.com>');
    expect(mime).toContain('References: <root@example.com> <orig@example.com>');
    expect(mime).toContain(Buffer.from('Thanks!', 'utf8').toString('base64'));
  });

  it('attaches files as multipart/mixed and refuses header injection and empty bodies', () => {
    const mime = decode(
      gmail._internal.buildRawMessage({
        to: 'bob@example.com',
        subject: 'Deck',
        text: 'attached',
        attachments: [{ filename: 'deck.pdf', contentType: 'application/pdf', contentBase64: Buffer.from('%PDF').toString('base64') }],
      }).raw,
    );
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary="papercusp-[0-9a-f]+"/);
    expect(mime).toContain('Content-Disposition: attachment; filename="deck.pdf"');
    expect(() => gmail._internal.buildRawMessage({ to: 'a@example.com', subject: 'x\r\nBcc: evil@example.com', text: 'hi' })).toThrow(
      /gmail_draft_subject_invalid/,
    );
    expect(() => gmail._internal.buildRawMessage({ to: 'a@example.com', subject: 'x', text: '  ' })).toThrow(/gmail_draft_text_invalid/);
    expect(() => gmail._internal.buildRawMessage({ to: [], subject: 'x', text: 'hi' })).toThrow(/gmail_to_required/);
  });
});

describe('gmail outbound mail verbs through invoke', () => {
  const invoke = (capability: string, args: Record<string, unknown>, route: Route) => {
    const h = host(route);
    return { result: adapter.invoke({ source: SOURCE, capability, args }, h), calls: h.calls };
  };

  it('mail.draft create posts the raw message with its threadId and returns the draft ids', async () => {
    const { result, calls } = invoke(
      'mail.draft',
      { operation: 'create', to: 'bob@example.com', subject: 'Hi', text: 'Hello', threadId: 'thread-1' },
      (request) => (request.url === `${BASE}/drafts` && request.method === 'POST'
        ? { json: { id: 'd-1', message: { id: 'm-9', threadId: 'thread-1' } } }
        : undefined),
    );
    await expect(result).resolves.toEqual({ draftId: 'd-1', messageId: 'm-9', threadId: 'thread-1' });
    const body = JSON.parse(calls[0]!.body ?? '{}');
    expect(body.message.threadId).toBe('thread-1');
    expect(typeof body.message.raw).toBe('string');
  });

  it('a draft landing in another thread is refused rather than reported as a reply', async () => {
    const { result } = invoke(
      'mail.draft',
      { operation: 'create', to: 'bob@example.com', subject: 'Hi', text: 'Hello', threadId: 'thread-1' },
      () => ({ json: { id: 'd-1', message: { id: 'm-9', threadId: 'thread-OTHER' } } }),
    );
    await expect(result).rejects.toThrow(/gmail_draft_thread_mismatch/);
  });

  // Port of WI-10001658 (the deleted host updateGoogleGmailDraft): revising a live draft must be
  // one in-place PUT that keeps the draft id, never a delete plus recreate on the owner's mailbox.
  it('mail.draft update PUTs the existing draft in place and keeps its id', async () => {
    const { result, calls } = invoke(
      'mail.draft',
      { operation: 'update', draftId: 'd-7', to: 'bob@example.com', subject: 'Hi again', text: 'Revised', threadId: 'thread-1' },
      (request) => (request.url === `${BASE}/drafts/d-7` && request.method === 'PUT'
        ? { json: { id: 'd-7', message: { id: 'm-10', threadId: 'thread-1' } } }
        : undefined),
    );
    await expect(result).resolves.toEqual({ draftId: 'd-7', messageId: 'm-10', threadId: 'thread-1' });
    expect(calls.map((call) => `${call.method ?? 'GET'} ${call.url}`)).toEqual([`PUT ${BASE}/drafts/d-7`]);
    const body = JSON.parse(calls[0]!.body ?? '{}');
    expect(body.id).toBe('d-7');
    expect(body.message.threadId).toBe('thread-1');
    expect(Buffer.from(body.message.raw, 'base64url').toString('utf8')).toContain('Subject: Hi again');
  });

  it('mail.draft update needs a draft id, and a response naming another draft is refused', async () => {
    await expect(
      invoke('mail.draft', { operation: 'update', to: 'bob@example.com', subject: 'Hi', text: 'Hello' }, () => undefined).result,
    ).rejects.toThrow(/gmail_draft_id_required/);
    const { result } = invoke(
      'mail.draft',
      { operation: 'update', draftId: 'd-7', to: 'bob@example.com', subject: 'Hi', text: 'Hello' },
      () => ({ json: { id: 'd-OTHER', message: { id: 'm-10', threadId: 'thread-1' } } }),
    );
    await expect(result).rejects.toThrow(/gmail_draft_id_mismatch/);
  });

  it('mail.send sends a message or a stored draft', async () => {
    const sent = invoke('mail.send', { operation: 'message', to: 'bob@example.com', subject: 'Hi', text: 'Hello' }, (request) =>
      request.url === `${BASE}/messages/send` ? { json: { id: 'm-1', threadId: 't-1' } } : undefined,
    );
    await expect(sent.result).resolves.toEqual({ messageId: 'm-1', threadId: 't-1' });
    const draft = invoke('mail.send', { operation: 'draft', draftId: 'd-5' }, (request) =>
      request.url === `${BASE}/drafts/send` ? { json: { id: 'm-2', threadId: 't-2' } } : undefined,
    );
    await expect(draft.result).resolves.toEqual({ messageId: 'm-2', threadId: 't-2' });
    expect(JSON.parse(draft.calls[0]!.body ?? '{}')).toEqual({ id: 'd-5' });
  });

  it('mail.labels modify needs exactly one target, and an undeclared capability is refused', async () => {
    await expect(invoke('mail.labels', { operation: 'modify', add: ['STARRED'] }, () => undefined).result).rejects.toThrow(
      /gmail_labels_target_required/,
    );
    await expect(invoke('calendar.write', {}, () => undefined).result).rejects.toThrow(/provider_capability_unsupported:calendar.write/);
  });

  it('sync.wake without a configured Pub/Sub credential reports no wake and makes no request', async () => {
    const { result, calls } = invoke('sync.wake', { state: null }, () => undefined);
    await expect(result).resolves.toMatchObject({ wake: false });
    expect(calls).toHaveLength(0);
  });
});
