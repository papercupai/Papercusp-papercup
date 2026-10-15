/**
 * The `slack` provider package (plan cupboard-distributable-integrations-2026-10-10 P-006):
 * libs/papercusp/plugins/slack — a Cupboard-installable sandboxed daemon provider that declares
 * pasted credentials, a Slack app manifest, a host-held Socket Mode ingress, the `chat-message`
 * datatype, and the `chat.channels` / `chat.reply` capabilities.
 *
 * Covers the package's pure logic (provider.mjs) and its JSON-RPC daemon wrapper (daemon.mjs)
 * spawned as a real process.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_INGRESS_NORMALIZE_CAPABILITY,
  PROVIDER_SEARCH_LIVE_CAPABILITY,
  providerAppRegistrationUrl,
  providerCredentialForHost,
  providerLiveSearchResultIssue,
  providerPrincipalCredentialForHost,
  validateProviderDeclaration,
  type HostFetchRequest,
  type HostFetchResponse,
} from '@papercusp/plugin-sdk';
import { validateDatatypePayload } from '../../datatype-payload-validation';
import { assertProviderRecords, classifyProviderSyncError } from '../connector-runtime';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const PACKAGE_DIR = resolve(REPO_ROOT, 'libs/papercusp/plugins/slack');
const manifest = JSON.parse(readFileSync(resolve(PACKAGE_DIR, 'papercusp.json'), 'utf8'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const provider: any = await import(pathToFileURL(resolve(PACKAGE_DIR, 'provider.mjs')).href);

/** A token-shaped fake, assembled at runtime so no credential-shaped literal sits in the tree. */
const fakeToken = (prefix: string) => [prefix, '1234567890', '0987654321', 'AbCdEf'].join('-');

/** The workspace's canonical chat-message payload schema (harness_shared.datatype_registry). */
const CHAT_MESSAGE_SCHEMA = {
  type: 'object',
  required: ['id', 'text'],
  properties: {
    id: { type: 'string', minLength: 1 },
    text: { type: 'string' },
    sender: { type: 'string' },
    mentions: { type: 'array', items: { type: 'string' } },
    threadId: { type: 'string' },
    channelId: { type: 'string' },
    occurredAt: { type: 'string' },
    attachments: { type: 'array', items: { type: 'object' } },
  },
  additionalProperties: true,
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): HostFetchResponse {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), bodyEncoding: 'utf8' };
}

function eventsEnvelope(event: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { envelope_id: 'env-1', type: 'events_api', payload: { event_id: 'Ev01', team_id: 'T1', event, ...extra } };
}

describe('slack package manifest', () => {
  it('is a valid provider declaration that the Cupboard installs as a sandboxed daemon', () => {
    expect(validateProviderDeclaration(manifest)).toEqual([]);
    expect(manifest.runtime).toEqual({ kind: 'daemon', daemonCommand: ['node', 'daemon.mjs'] });
    expect(manifest.provider.id).toBe('slack');
    expect(manifest.provider.datatypes).toEqual(['chat-message']);
    expect(manifest.provider.capabilities).toEqual(
      expect.arrayContaining([PROVIDER_INGRESS_NORMALIZE_CAPABILITY, 'chat.channels', 'chat.reply']),
    );
    // Setup is pasted, never OAuth: the package carries no client registration.
    expect(manifest.provider.oauth).toBeUndefined();
  });

  it('opens the socket with the app-level token and sends the bot token only to slack.com', () => {
    const socket = manifest.provider.ingress.socket;
    expect(socket.credential).toBe('app_token');
    expect(socket.open).toEqual({ url: 'https://slack.com/api/apps.connections.open', method: 'POST', urlField: 'url' });
    expect(socket.ackField).toBe('envelope_id');
    expect(socket.reconnect).toEqual({ field: 'type', values: ['disconnect'] });
    // Interactive envelopes skip the serialized chain so the report form opens inside Slack's
    // 3-second trigger_id window (D-025 ruling 2).
    expect(socket.immediate).toEqual({ field: 'type', values: ['interactive'] });
    expect(providerCredentialForHost(manifest.provider, 'slack.com')?.key).toBe('bot_token');
    const credential = (key: string) => manifest.provider.setup.credentials.find((c: { key: string }) => c.key === key);
    const matches = (key: string, value: string) => new RegExp(`^(?:${credential(key).pattern})$`).test(value);
    expect(credential('app_token').hosts).toBeUndefined();
    expect(matches('app_token', fakeToken('xapp'))).toBe(true);
    expect(matches('bot_token', fakeToken('xoxb'))).toBe(true);
    // Pasting one token into the other's field is refused on the card.
    expect(matches('bot_token', fakeToken('xapp'))).toBe(false);
    expect(matches('app_token', fakeToken('xoxb'))).toBe(false);
  });

  it('creates the Slack app from its manifest with Socket Mode and the scopes the capabilities use', () => {
    const registration = manifest.provider.setup.appRegistration;
    const url = new URL(providerAppRegistrationUrl(registration));
    expect(url.origin + url.pathname).toBe('https://api.slack.com/apps');
    const definition = JSON.parse(url.searchParams.get('manifest_json') ?? 'null');
    expect(definition).toEqual(registration.definition);
    expect(definition.settings.socket_mode_enabled).toBe(true);
    expect(definition.oauth_config.scopes.bot).toEqual(
      expect.arrayContaining(['chat:write', 'channels:read', 'groups:read', 'channels:history', 'app_mentions:read', 'reactions:read']),
    );
    expect(definition.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining(['app_mention', 'message.channels', 'message.groups', 'message.im', 'reaction_added']),
    );
    // The "Report a bug" message shortcut the provider answers with its form.
    expect(definition.features.shortcuts).toEqual([
      expect.objectContaining({ type: 'message', callback_id: provider.SLACK_REPORT_SHORTCUT_CALLBACK_ID }),
    ]);
    expect(definition.settings.interactivity).toEqual({ is_enabled: true });
  });

  it('declares channel readership, live search and a per-person user token that only search uses (D-026)', () => {
    expect(manifest.provider.membership).toEqual({ identityProvider: 'slack', containers: true });
    expect(manifest.provider.capabilities).toContain(PROVIDER_SEARCH_LIVE_CAPABILITY);
    // The source credential for slack.com stays the bot token; the user token is per person.
    expect(providerCredentialForHost(manifest.provider, 'slack.com')?.key).toBe('bot_token');
    const userToken = providerPrincipalCredentialForHost(manifest.provider, 'slack.com');
    expect(userToken).toMatchObject({ key: 'user_token', perPrincipal: true, hosts: ['slack.com'] });
    const matches = (value: string) => new RegExp(`^(?:${userToken?.pattern})$`).test(value);
    expect(matches(fakeToken('xoxp'))).toBe(true);
    expect(matches(fakeToken('xoxb'))).toBe(false);
    // The app asks for the user scopes assistant.search.context reads with.
    expect(manifest.provider.setup.appRegistration.definition.oauth_config.scopes.user).toEqual(
      expect.arrayContaining(['search:read.public', 'search:read.private', 'search:read.mpim', 'search:read.im']),
    );
  });
});

/** A host.fetch that must not be called: plain posts and ignored gestures read nothing from Slack. */
const noFetch = async (): Promise<HostFetchResponse> => {
  throw new Error('fetched');
};

/**
 * A fake slack.com behind host.fetch: conversations.replies answers from `messages` (keyed
 * `channel:ts`), views.open succeeds. Every request is recorded.
 */
function fakeSlack(messages: Record<string, { text: string; user: string; thread_ts?: string }> = {}) {
  const seen: HostFetchRequest[] = [];
  const fetchSlack = async (request: HostFetchRequest) => {
    seen.push(request);
    const url = new URL(request.url);
    if (url.pathname === '/api/conversations.replies') {
      const channel = url.searchParams.get('channel');
      const ts = url.searchParams.get('ts');
      const message = messages[`${channel}:${ts}`];
      return json({ ok: true, messages: message ? [{ ts, ...message }] : [] });
    }
    if (url.pathname === '/api/views.open') return json({ ok: true, view: { id: 'V-open' } });
    return json({ ok: false, error: 'unknown_method' });
  };
  return { seen, fetchSlack };
}

function interactiveEnvelope(payload: Record<string, unknown>) {
  return { envelope_id: 'env-int', type: 'interactive', accepts_response_payload: false, payload };
}

const REPORTED_TS = '1712345678.000200';

describe('ingress.normalize', () => {
  it('records a channel post as a chat-message with its channel, author and text', async () => {
    const result = await provider.normalizeEnvelope(
      eventsEnvelope({ type: 'message', channel: 'C42', channel_type: 'channel', user: 'U7', text: 'The export button 500s <@U9>', ts: '1712345678.000200' }),
    );
    expect(result.records).toHaveLength(1);
    const [record] = result.records;
    expect(record).toMatchObject({ datatype: 'chat-message', nativeId: 'C42:1712345678.000200', event: 'message', version: 'message:C42:1712345678.000200' });
    // The channel is the record's readership container on an organization source (D-026), and the
    // host's record check accepts it because the descriptor declares containers.
    expect(record.aclRef).toBe('C42');
    expect(() => assertProviderRecords(result.records, { descriptor: manifest.provider })).not.toThrow();
    expect(record.payload).toMatchObject({
      id: 'Ev01',
      channelId: 'C42',
      threadId: '1712345678.000200',
      sender: 'U7',
      text: 'The export button 500s <@U9>',
      mentions: ['U9'],
      occurredAt: '2024-04-05T19:34:38.000Z',
      extensions: { slack: { ts: '1712345678.000200', eventType: 'message', channelType: 'channel', teamId: 'T1' } },
    });
    expect(validateDatatypePayload(CHAT_MESSAGE_SCHEMA, record.payload).ok).toBe(true);
  });

  it('keeps a reply in its thread and names the thread root', async () => {
    const [record] = (await provider.normalizeEnvelope(
      eventsEnvelope({ type: 'message', channel: 'C42', user: 'U7', text: 'Still broken', ts: '1712345700.000100', thread_ts: '1712345678.000200' }),
    )).records;
    expect(record.payload.threadId).toBe('1712345678.000200');
    expect(record.payload.extensions.slack.threadTs).toBe('1712345678.000200');
  });

  it('distinguishes mentions and direct messages, and delivers a mention and its channel post separately', async () => {
    const mention = (await provider.normalizeEnvelope(
      eventsEnvelope({ type: 'app_mention', channel: 'C42', user: 'U7', text: '<@UBOT> help', ts: '1712345678.000200' }),
      {},
      noFetch,
    )).records[0];
    const post = (await provider.normalizeEnvelope(
      eventsEnvelope({ type: 'message', channel: 'C42', channel_type: 'channel', user: 'U7', text: '<@UBOT> help', ts: '1712345678.000200' }),
    )).records[0];
    expect(mention.event).toBe('mention');
    expect(post.event).toBe('message');
    expect(mention.nativeId).toBe(post.nativeId);
    expect(mention.version).not.toBe(post.version);
    // A top-level mention is about itself: no target, and nothing read from Slack.
    expect(mention.payload.target).toBeUndefined();
    const dm = (await provider.normalizeEnvelope(
      eventsEnvelope({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U7', text: 'hi', ts: '1712345678.000300' }),
    )).records[0];
    expect(dm.event).toBe('dm');
  });

  it("carries a mention inside a thread with the thread's opening message as its target", async () => {
    const { seen, fetchSlack } = fakeSlack({ [`C42:${REPORTED_TS}`]: { text: 'Checkout spins forever', user: 'U3' } });
    const [record] = (await provider.normalizeEnvelope(
      eventsEnvelope({ type: 'app_mention', channel: 'C42', user: 'U7', text: '<@UBOT> this is a bug', ts: '1712345700.000100', thread_ts: REPORTED_TS }),
      {},
      fetchSlack,
    )).records;
    expect(record).toMatchObject({ event: 'mention', nativeId: 'C42:1712345700.000100' });
    expect(record.payload).toMatchObject({
      sender: 'U7',
      text: '<@UBOT> this is a bug',
      threadId: REPORTED_TS,
      target: { channelId: 'C42', ts: REPORTED_TS, sender: 'U3', text: 'Checkout spins forever' },
    });
    expect(seen).toHaveLength(1);
    const read = new URL(seen[0].url);
    expect(read.origin + read.pathname).toBe('https://slack.com/api/conversations.replies');
    expect(read.searchParams.get('channel')).toBe('C42');
    expect(read.searchParams.get('ts')).toBe(REPORTED_TS);
    expect(validateDatatypePayload(CHAT_MESSAGE_SCHEMA, record.payload).ok).toBe(true);
  });

  it('records a reaction as a record of the reacted message, with the reactor in gesture', async () => {
    const { seen, fetchSlack } = fakeSlack({ [`C42:${REPORTED_TS}`]: { text: 'Export 500s on big CSVs', user: 'U3' } });
    const reaction = {
      type: 'reaction_added',
      user: 'U5',
      reaction: 'bug::skin-tone-2',
      item: { type: 'message', channel: 'C42', ts: REPORTED_TS },
      item_user: 'U3',
      event_ts: '1712345800.000100',
    };
    const [record] = (await provider.normalizeEnvelope(eventsEnvelope(reaction), { botUserId: 'U0' }, fetchSlack)).records;
    expect(record).toMatchObject({
      datatype: 'chat-message',
      event: 'reaction',
      // The same message a channel post of it would be: one record, a new version per reactor.
      nativeId: `C42:${REPORTED_TS}`,
      version: `reaction:bug:U5:C42:${REPORTED_TS}`,
    });
    expect(record.payload).toMatchObject({
      channelId: 'C42',
      threadId: REPORTED_TS,
      sender: 'U3',
      text: 'Export 500s on big CSVs',
      gesture: { kind: 'reaction', by: 'U5', reaction: 'bug' },
      occurredAt: '2024-04-05T19:36:40.000Z',
      extensions: { slack: { ts: REPORTED_TS, eventType: 'reaction_added', teamId: 'T1' } },
    });
    expect(validateDatatypePayload(CHAT_MESSAGE_SCHEMA, record.payload).ok).toBe(true);
    // The daemon never handles a token: host.fetch injects the bot token for slack.com.
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0].headers ?? {}).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it("ignores the app's own reactions, reactions in DMs and reactions on files, without reading Slack", async () => {
    const base = { type: 'reaction_added', user: 'U5', reaction: 'bug', item: { type: 'message', channel: 'C42', ts: REPORTED_TS } };
    for (const event of [
      { ...base, user: 'U0' }, // the app's own bot user
      { ...base, item: { ...base.item, channel: 'D42' } },
      { ...base, item: { type: 'file', file: 'F1' } },
      { ...base, item: { ...base.item, ts: 'nope' } },
      { ...base, reaction: '' },
      { ...base, user: '' },
    ]) {
      expect((await provider.normalizeEnvelope(eventsEnvelope(event), { botUserId: 'U0' }, noFetch)).records).toEqual([]);
    }
  });

  it('fails loudly when the message a gesture is about cannot be read', async () => {
    const reaction = { type: 'reaction_added', user: 'U5', reaction: 'bug', item: { type: 'message', channel: 'C42', ts: REPORTED_TS } };
    await expect(provider.normalizeEnvelope(eventsEnvelope(reaction), {}, fakeSlack().fetchSlack)).rejects.toThrow(
      `slack_message_unavailable:C42:${REPORTED_TS}`,
    );
    await expect(
      provider.normalizeEnvelope(eventsEnvelope(reaction), {}, async () => json({ ok: false, error: 'missing_scope' })),
    ).rejects.toMatchObject({ message: 'slack_conversations_replies_missing_scope', data: { kind: 'auth' } });
    await expect(provider.normalizeEnvelope(eventsEnvelope(reaction), {})).rejects.toThrow('slack_message_fetch_unavailable');
  });

  it('opens the report form for a "Report a bug" shortcut click and records nothing for the click', async () => {
    const { seen, fetchSlack } = fakeSlack();
    const result = await provider.normalizeEnvelope(
      interactiveEnvelope({
        type: 'message_action',
        callback_id: provider.SLACK_REPORT_SHORTCUT_CALLBACK_ID,
        trigger_id: 'trig-9',
        user: { id: 'U5' },
        channel: { id: 'C42' },
        message: { ts: REPORTED_TS, text: 'Export 500s on big CSVs' },
        team: { id: 'T1' },
      }),
      {},
      fetchSlack,
    );
    expect(result.records).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: 'https://slack.com/api/views.open', method: 'POST' });
    const body = JSON.parse(seen[0].body ?? '{}');
    expect(body.trigger_id).toBe('trig-9');
    expect(body.view).toEqual(provider.reportFormView({ channelId: 'C42', ts: REPORTED_TS }));
    expect(body.view.callback_id).toBe(provider.SLACK_REPORT_FORM_CALLBACK_ID);
    expect(JSON.parse(body.view.private_metadata)).toEqual({ channelId: 'C42', ts: REPORTED_TS });
    // A refused views.open (an expired trigger) surfaces by Slack's own code.
    await expect(
      provider.normalizeEnvelope(
        interactiveEnvelope({ type: 'message_action', callback_id: 'report_bug', trigger_id: 'trig-9', user: { id: 'U5' }, channel: { id: 'C42' }, message: { ts: REPORTED_TS } }),
        {},
        async () => json({ ok: false, error: 'expired_trigger_id' }),
      ),
    ).rejects.toThrow('slack_views_open_expired_trigger_id');
  });

  it("records the form's submission as a report of the reported message, with the reporter's note", async () => {
    const { seen, fetchSlack } = fakeSlack({ [`C42:${REPORTED_TS}`]: { text: 'Export 500s on big CSVs', user: 'U3', thread_ts: REPORTED_TS } });
    const submission = (values: Record<string, unknown>, view: Record<string, unknown> = {}) =>
      interactiveEnvelope({
        type: 'view_submission',
        user: { id: 'U5' },
        team: { id: 'T1' },
        view: {
          id: 'V1',
          callback_id: provider.SLACK_REPORT_FORM_CALLBACK_ID,
          private_metadata: JSON.stringify({ channelId: 'C42', ts: REPORTED_TS }),
          state: { values },
          ...view,
        },
      });
    const [record] = (await provider.normalizeEnvelope(submission({ note: { note: { type: 'plain_text_input', value: '  Every time, since Monday.  ' } } }), {}, fetchSlack)).records;
    expect(record).toMatchObject({ datatype: 'chat-message', event: 'report', nativeId: `C42:${REPORTED_TS}`, version: 'report:V1' });
    expect(record.payload).toMatchObject({
      channelId: 'C42',
      threadId: REPORTED_TS,
      sender: 'U3',
      text: 'Export 500s on big CSVs',
      gesture: { kind: 'report', by: 'U5', note: 'Every time, since Monday.' },
      extensions: { slack: { ts: REPORTED_TS, eventType: 'view_submission', teamId: 'T1' } },
    });
    expect(validateDatatypePayload(CHAT_MESSAGE_SCHEMA, record.payload).ok).toBe(true);
    expect(seen).toHaveLength(1);

    // An empty note is left out; an over-long one is cut to the form's limit.
    const [bare] = (await provider.normalizeEnvelope(submission({ note: { note: { value: '   ' } } }), {}, fetchSlack)).records;
    expect(bare.payload.gesture).toEqual({ kind: 'report', by: 'U5' });
    const [long] = (await provider.normalizeEnvelope(submission({ note: { note: { value: 'x'.repeat(5_000) } } }), {}, fetchSlack)).records;
    expect(long.payload.gesture.note).toHaveLength(provider.SLACK_REPORT_NOTE_MAX_LENGTH);

    // Another app's view, a mangled form, and other interactions record nothing and read nothing.
    for (const envelope of [
      submission({}, { callback_id: 'some_other_form' }),
      submission({}, { private_metadata: 'not json' }),
      submission({}, { private_metadata: JSON.stringify({ channelId: 'C42' }) }),
      submission({}, { id: '' }),
      interactiveEnvelope({ type: 'block_actions', user: { id: 'U5' }, actions: [] }),
      interactiveEnvelope({ type: 'message_action', callback_id: 'another_shortcut', trigger_id: 't', user: { id: 'U5' }, channel: { id: 'C42' }, message: { ts: REPORTED_TS } }),
      interactiveEnvelope({ type: 'message_action', callback_id: 'report_bug', user: { id: 'U5' }, channel: { id: 'C42' }, message: { ts: REPORTED_TS } }),
    ]) {
      expect((await provider.normalizeEnvelope(envelope, {}, noFetch)).records).toEqual([]);
    }
  });

  it('records an edit as a new version of the same message that keeps its post time', async () => {
    const original = { type: 'message', user: 'U7', text: 'The export 500s', ts: '1712345678.000200' };
    const edit = {
      type: 'message', subtype: 'message_changed', hidden: true, channel: 'C42', channel_type: 'channel',
      ts: '1712345800.000100', event_ts: '1712345800.000100',
      message: { ...original, text: 'The export 500s on staging', edited: { user: 'U7', ts: '1712345799.000000' } },
      previous_message: original,
    };
    const result = await provider.normalizeEnvelope(eventsEnvelope(edit));
    expect(result.records).toHaveLength(1);
    const [record] = result.records;
    // The same message (native id, readership), under its own event, so new-message workflows do not fire.
    expect(record).toMatchObject({
      datatype: 'chat-message', event: 'edited', nativeId: 'C42:1712345678.000200', aclRef: 'C42',
      version: 'edited:C42:1712345678.000200:1712345799.000000:', occurredAt: '2024-04-05T19:34:38.000Z',
    });
    expect(record.deleted).toBeUndefined();
    expect(record.payload).toMatchObject({
      channelId: 'C42', sender: 'U7', text: 'The export 500s on staging', occurredAt: '2024-04-05T19:34:38.000Z',
      editedAt: '2024-04-05T19:36:39.000Z',
      extensions: { slack: { ts: '1712345678.000200', subtype: 'message_changed', editedTs: '1712345799.000000' } },
    });
    expect(validateDatatypePayload(CHAT_MESSAGE_SCHEMA, record.payload).ok).toBe(true);
    expect(() => assertProviderRecords(result.records, { descriptor: manifest.provider })).not.toThrow();

    // A second edit is a new version; a root that gains its first reply joins its thread once.
    const [again] = (await provider.normalizeEnvelope(eventsEnvelope({
      ...edit, message: { ...edit.message, text: 'fixed', edited: { user: 'U7', ts: '1712345900.000000' } },
    }))).records;
    expect(again.version).toBe('edited:C42:1712345678.000200:1712345900.000000:');
    const threaded = { ...original, thread_ts: original.ts, reply_count: 1 };
    const [joined] = (await provider.normalizeEnvelope(eventsEnvelope({ ...edit, message: threaded }))).records;
    expect(joined).toMatchObject({ event: 'edited', version: 'edited:C42:1712345678.000200:1712345678.000200:1712345678.000200' });
    expect(joined.payload.threadKey).toBe('1712345678.000200');
    expect(joined.payload.editedAt).toBeUndefined();

    // A change that alters neither text nor thread (an unfurl, a later reply count) records nothing.
    for (const message of [
      { ...original, attachments: [{ title: 'unfurl' }] },
      { ...threaded, reply_count: 2 },
    ]) {
      const previous = 'thread_ts' in message ? threaded : original;
      expect((await provider.normalizeEnvelope(eventsEnvelope({ ...edit, message, previous_message: previous }))).records).toEqual([]);
    }
    // Edits of posts this provider never records stay unrecorded: another bot, an app, a group DM.
    for (const event of [
      { ...edit, message: { ...edit.message, bot_id: 'B1' } },
      { ...edit, message: { ...edit.message, app_id: 'A1' } },
      { ...edit, channel: 'G1', channel_type: 'mpim' },
      { ...edit, message: undefined },
      { ...edit, message: { ...edit.message, text: '' } },
    ]) {
      expect((await provider.normalizeEnvelope(eventsEnvelope(event))).records).toEqual([]);
    }
  });

  it('records a deletion, and the tombstone of a deleted thread root, as a deleted record of the message', async () => {
    const original = { type: 'message', user: 'U7', text: 'my password is hunter2', ts: '1712345678.000200', thread_ts: '1712345600.000100' };
    const deletion = {
      type: 'message', subtype: 'message_deleted', hidden: true, channel: 'C42', channel_type: 'channel',
      ts: '1712345900.000100', event_ts: '1712345900.000100', deleted_ts: original.ts, previous_message: original,
    };
    const result = await provider.normalizeEnvelope(eventsEnvelope(deletion));
    expect(result.records).toHaveLength(1);
    const [record] = result.records;
    expect(record).toMatchObject({
      datatype: 'chat-message', event: 'deleted', deleted: true, nativeId: 'C42:1712345678.000200', aclRef: 'C42',
      version: 'deleted:C42:1712345678.000200', occurredAt: '2024-04-05T19:38:20.000Z',
    });
    // The deleted text is never carried forward.
    expect(record.payload).toMatchObject({ channelId: 'C42', threadKey: '1712345600.000100', sender: 'U7', text: '' });
    expect(JSON.stringify(record)).not.toContain('hunter2');
    expect(validateDatatypePayload(CHAT_MESSAGE_SCHEMA, record.payload).ok).toBe(true);
    expect(() => assertProviderRecords(result.records, { descriptor: manifest.provider })).not.toThrow();

    // A deleted root that has replies stays as a tombstone: Slack reports it as a change.
    const [tombstone] = (await provider.normalizeEnvelope(eventsEnvelope({
      type: 'message', subtype: 'message_changed', hidden: true, channel: 'C42', channel_type: 'channel',
      ts: '1712345900.000200', event_ts: '1712345900.000200',
      message: { type: 'message', subtype: 'tombstone', text: 'This message was deleted.', user: 'USLACKBOT', ts: '1712345600.000100', thread_ts: '1712345600.000100', hidden: true },
      previous_message: { type: 'message', user: 'U8', text: 'the root', ts: '1712345600.000100', thread_ts: '1712345600.000100' },
    }))).records;
    expect(tombstone).toMatchObject({ event: 'deleted', deleted: true, nativeId: 'C42:1712345600.000100', version: 'deleted:C42:1712345600.000100' });
    expect(tombstone.payload).toMatchObject({ text: '', sender: 'U8' });

    // A deletion with no previous message still removes the message; one of another bot's posts or
    // in a group DM, which were never recorded, records nothing.
    const [bare] = (await provider.normalizeEnvelope(eventsEnvelope({ ...deletion, previous_message: undefined }))).records;
    expect(bare).toMatchObject({ deleted: true, nativeId: 'C42:1712345678.000200' });
    for (const event of [
      { ...deletion, previous_message: { ...original, bot_id: 'B1' } },
      { ...deletion, channel: 'G1', channel_type: 'mpim' },
      { ...deletion, deleted_ts: 'not-a-ts' },
    ]) {
      expect((await provider.normalizeEnvelope(eventsEnvelope(event))).records).toEqual([]);
    }
  });

  it('ignores bot and app posts, system subtypes, group DMs, and control envelopes', async () => {
    const base = { type: 'message', channel: 'C42', user: 'U7', text: 'x', ts: '1712345678.000200' };
    for (const event of [
      { ...base, bot_id: 'B1' },
      { ...base, app_id: 'A1' },
      // A change event with no changed message is malformed.
      { ...base, subtype: 'message_changed' },
      { ...base, subtype: 'channel_join' },
      { ...base, channel: 'G1', channel_type: 'mpim' },
      { ...base, type: 'reaction_added' },
      { ...base, text: '' },
      { ...base, user: '' },
      { ...base, ts: 'not-a-ts' },
    ]) {
      expect((await provider.normalizeEnvelope(eventsEnvelope(event), {}, noFetch)).records).toEqual([]);
    }
    expect((await provider.normalizeEnvelope({ type: 'hello', num_connections: 1 })).records).toEqual([]);
    expect((await provider.normalizeEnvelope({ type: 'disconnect', reason: 'refresh_requested' })).records).toEqual([]);
    expect((await provider.normalizeEnvelope(null)).records).toEqual([]);
    expect((await provider.normalizeEnvelope('{"type":"events_api"}')).records).toEqual([]);
  });

  it("records the source's declared drill bot, and only it, as a plain channel message (D-023)", async () => {
    const allowance = { botId: 'B9', appId: 'A9', userId: 'U9', channelId: 'C42' };
    const config = { botId: 'B0', botUserId: 'U0', channels: ['C42', 'C43'], testBotAllowance: allowance };
    const drill = { type: 'message', channel: 'C42', channel_type: 'channel', user: 'U9', bot_id: 'B9', app_id: 'A9', text: 'checkout is broken', ts: '1712345678.000300' };

    const [admitted] = (await provider.normalizeEnvelope(eventsEnvelope(drill), config)).records;
    expect(admitted).toMatchObject({ datatype: 'chat-message', event: 'message', nativeId: 'C42:1712345678.000300' });
    expect(admitted.payload).toMatchObject({ channelId: 'C42', sender: 'U9', text: 'checkout is broken' });
    // The same allowance reaches the package through invokeCapability's args.sourceConfig.
    return provider.invokeCapability({ capability: 'ingress.normalize', args: { envelope: eventsEnvelope(drill), sourceConfig: config } })
      .then(async (result: { records: unknown[] }) => {
        expect(result.records).toHaveLength(1);
        for (const [event, cfg] of [
          [drill, {}], // no allowance declared: the in-app default, every bot post dropped
          [drill, { ...config, testBotAllowance: { ...allowance, appId: '' } }], // incomplete identity
          [{ ...drill, bot_id: 'B8' }, config], // another bot
          [{ ...drill, app_id: 'A8' }, config], // another app
          [{ ...drill, user: 'U8' }, config], // another bot user
          [{ ...drill, channel: 'C43' }, config], // a watched channel, but not the drill's
          [drill, { ...config, channels: ['C43'] }], // the drill's channel is not watched
          [{ ...drill, type: 'app_mention' }, config], // a mention, not a channel message
          [{ ...drill, channel: 'D42', channel_type: 'im' }, { ...config, testBotAllowance: { ...allowance, channelId: 'D42' }, channels: ['D42'] }],
          [{ ...drill, subtype: 'bot_message' }, config],
          [drill, { ...config, botId: 'B9' }], // the allowance can never name this app's own bot
          [drill, { ...config, botUserId: 'U9' }],
        ] as Array<[Record<string, unknown>, Record<string, unknown>]>) {
          expect((await provider.normalizeEnvelope(eventsEnvelope(event), cfg, noFetch)).records).toEqual([]);
        }
      });
  });

  it('records the /papercusp command as a slash-command chat message', async () => {
    const [record] = (await provider.normalizeEnvelope({
      envelope_id: 'env-9',
      type: 'slash_commands',
      payload: { trigger_id: 'trig-1', command: '/papercusp', text: 'triage the export bug', user_id: 'U7', channel_id: 'C42', team_id: 'T1' },
    })).records;
    expect(record).toMatchObject({ event: 'slash-command', nativeId: 'command:trig-1', version: 'slash-command:trig-1' });
    expect(record.payload).toMatchObject({ id: 'trig-1', channelId: 'C42', sender: 'U7', text: '/papercusp triage the export bug' });
    expect(validateDatatypePayload(CHAT_MESSAGE_SCHEMA, record.payload).ok).toBe(true);
  });
});

describe('chat.channels', () => {
  it('pages conversations.list through host.fetch into sorted picker options', async () => {
    const seen: HostFetchRequest[] = [];
    const fetchSlack = async (request: HostFetchRequest) => {
      seen.push(request);
      const cursor = new URL(request.url).searchParams.get('cursor');
      if (!cursor) {
        return json({ ok: true, channels: [{ id: 'C2', name: 'bugs', purpose: { value: 'Bug reports' } }, { id: 'C9', name: 'zz-private', is_private: true }], response_metadata: { next_cursor: 'page2' } });
      }
      return json({ ok: true, channels: [{ id: 'C1', name: 'announcements' }, { id: '', name: 'broken' }], response_metadata: { next_cursor: '' } });
    };
    const result = await provider.listChannels(fetchSlack, {});
    expect(result).toEqual({
      options: [
        { value: 'C1', label: '#announcements' },
        { value: 'C2', label: '#bugs', description: 'Bug reports' },
        { value: 'C9', label: '#zz-private', description: 'Private channel' },
      ],
    });
    expect(seen).toHaveLength(2);
    const first = new URL(seen[0].url);
    expect(first.origin + first.pathname).toBe('https://slack.com/api/conversations.list');
    expect(first.searchParams.get('types')).toBe('public_channel,private_channel');
    expect(first.searchParams.get('exclude_archived')).toBe('true');
    // The daemon never handles a token: host.fetch injects the bot token for slack.com.
    for (const request of seen) expect(Object.keys(request.headers ?? {}).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('stops after the page limit instead of following an endless cursor', async () => {
    let calls = 0;
    const fetchSlack = async () => {
      calls += 1;
      return json({ ok: true, channels: [{ id: `C${calls}`, name: `c${calls}` }], response_metadata: { next_cursor: 'again' } });
    };
    const result = await provider.listChannels(fetchSlack, { types: 'public' });
    expect(calls).toBe(provider.SLACK_CHANNEL_PAGE_LIMIT);
    expect(result.options).toHaveLength(provider.SLACK_CHANNEL_PAGE_LIMIT);
  });

  it('reports a revoked token as an auth error and a 429 as rate-limited', async () => {
    await expect(provider.listChannels(async () => json({ ok: false, error: 'invalid_auth' }))).rejects.toMatchObject({
      message: 'slack_conversations_list_invalid_auth',
      data: { kind: 'auth' },
    });
    await expect(provider.listChannels(async () => json({}, 429, { 'retry-after': '30' }))).rejects.toMatchObject({
      data: { kind: 'rate-limited', retryAfterSeconds: 30 },
    });
  });
});

describe('chat.reply', () => {
  it('posts the text in the thread through host.fetch and returns the new message ts', async () => {
    const seen: HostFetchRequest[] = [];
    const result = await provider.replyInThread(
      async (request: HostFetchRequest) => {
        seen.push(request);
        return json({ ok: true, channel: 'C42', ts: '1712345999.000100' });
      },
      { channelId: 'C42', threadId: '1712345678.000200', text: '  Filed as ASANA-12.  ' },
    );
    expect(result).toEqual({ channelId: 'C42', threadId: '1712345678.000200', messageTs: '1712345999.000100' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: 'https://slack.com/api/chat.postMessage', method: 'POST' });
    expect(JSON.parse(seen[0].body ?? '{}')).toEqual({ channel: 'C42', thread_ts: '1712345678.000200', text: 'Filed as ASANA-12.' });
  });

  it('refuses bad coordinates or text before any request', async () => {
    const never = async () => {
      throw new Error('fetched');
    };
    await expect(provider.replyInThread(never, { channelId: '', threadId: '1.2', text: 'x' })).rejects.toThrow('slack_reply_channel_invalid');
    await expect(provider.replyInThread(never, { channelId: 'C1', threadId: 'abc', text: 'x' })).rejects.toThrow('slack_reply_thread_invalid');
    await expect(provider.replyInThread(never, { channelId: 'C1', threadId: '1.2', text: '   ' })).rejects.toThrow('slack_reply_text_invalid');
    await expect(provider.replyInThread(never, { channelId: 'C1', threadId: '1.2', text: 'x'.repeat(4_001) })).rejects.toThrow('slack_reply_text_invalid');
  });

  it('surfaces Slack refusals by their own error code', async () => {
    await expect(
      provider.replyInThread(async () => json({ ok: false, error: 'channel_not_found' }), { channelId: 'C1', threadId: '1.2', text: 'x' }),
    ).rejects.toThrow('slack_chat_post_message_channel_not_found');
  });

  it('refuses a capability it does not declare', async () => {
    await expect(provider.invokeCapability({ capability: 'ticket.create', args: {} }, async () => json({ ok: true }))).rejects.toThrow(
      'provider_capability_unsupported:slack:ticket.create',
    );
  });
});

/**
 * A fake Slack workspace behind host.fetch for syncPage: channel list pages, members per channel,
 * history pages per channel (keyed `channel` or `channel:cursor`), replies per thread. A route may
 * be a function so a test can answer with a refusal or a rate limit.
 */
type SlackRoute = unknown | ((url: URL) => HostFetchResponse);
function fakeWorkspace(routes: {
  list?: SlackRoute[];
  members?: Record<string, SlackRoute>;
  history?: Record<string, SlackRoute>;
  replies?: Record<string, SlackRoute>;
}) {
  const seen: string[] = [];
  const answer = (route: SlackRoute | undefined, url: URL): HostFetchResponse => {
    if (route === undefined) return json({ ok: false, error: `unexpected:${url.pathname}${url.search}` });
    return typeof route === 'function' ? (route as (u: URL) => HostFetchResponse)(url) : json({ ok: true, ...(route as object) });
  };
  const fetchSlack = async (request: HostFetchRequest) => {
    const url = new URL(request.url);
    seen.push(`${url.pathname.replace('/api/', '')}?${url.searchParams}`);
    const channel = url.searchParams.get('channel') ?? '';
    const cursor = url.searchParams.get('cursor');
    if (url.pathname === '/api/conversations.list') return answer(routes.list?.[cursor ? Number(cursor) : 0], url);
    if (url.pathname === '/api/conversations.members') return answer(routes.members?.[cursor ? `${channel}:${cursor}` : channel], url);
    if (url.pathname === '/api/conversations.history') return answer(routes.history?.[cursor ? `${channel}:${cursor}` : channel], url);
    if (url.pathname === '/api/conversations.replies') return answer(routes.replies?.[`${channel}:${url.searchParams.get('ts')}`], url);
    return json({ ok: false, error: 'unknown_method' });
  };
  return { seen, fetchSlack };
}

const ORG = { source: 'src-org', mode: 'backfill', scope: 'organization' } as const;
const cursorState = (page: { nextCursor: string | null }) => JSON.parse(page.nextCursor ?? 'null');

describe('syncPage (organization history and channel readership, D-026)', () => {
  it('gives a personal source nothing to crawl and reads nothing from Slack', async () => {
    for (const scope of [undefined, 'personal', 'pot']) {
      expect(await provider.syncPage({ source: 'src-1', cursor: null, mode: 'backfill', ...(scope ? { scope } : {}) }, noFetch))
        .toEqual({ records: [], nextCursor: null, hasMore: false });
    }
  });

  it('starts with a membership page: every member channel with its complete members, then queues them for backfill', async () => {
    const slack = fakeWorkspace({
      list: [
        {
          channels: [
            { id: 'C1', name: 'general', is_member: true },
            { id: 'C2', name: 'random', is_member: false },
            { id: 'C3', name: 'old', is_member: true, is_archived: true },
          ],
          response_metadata: { next_cursor: '1' },
        },
        { channels: [{ id: 'G4', name: 'secret', is_member: true, is_private: true }] },
      ],
      members: {
        C1: { members: ['U1', 'U2'], response_metadata: { next_cursor: 'm2' } },
        'C1:m2': { members: ['U3'] },
        G4: { members: ['U1'] },
      },
    });
    const page = await provider.syncPage({ ...ORG, cursor: null }, slack.fetchSlack);
    expect(page.records).toEqual([]);
    expect(page.membership).toEqual({
      // Every record names its channel, so nobody reads through the source-wide list.
      members: [],
      containers: [
        { ref: 'C1', title: '#general', members: [{ providerUserId: 'U1' }, { providerUserId: 'U2' }, { providerUserId: 'U3' }] },
        { ref: 'G4', title: '#secret', members: [{ providerUserId: 'U1' }] },
      ],
    });
    expect(page.hasMore).toBe(true);
    // deepAt starts the whole-history re-walk clock (WI-6554700010012486).
    expect(cursorState(page)).toEqual({ queue: ['C1', 'G4'], seen: ['C1', 'G4'], deepAt: expect.any(String) });
    // Non-member and archived channels are never read.
    expect(slack.seen.filter((call) => call.startsWith('conversations.members'))).toHaveLength(3);
    expect(slack.seen.some((call) => /channel=C2|channel=C3/.test(call))).toBe(false);
  });

  it('walks one history page at a time, thread replies included, as history records of the channel', async () => {
    const slack = fakeWorkspace({
      history: {
        C1: {
          messages: [
            { ts: '1712345678.000200', user: 'U1', text: 'The export 500s', thread_ts: '1712345678.000200', reply_count: 1 },
            { ts: '1712345600.000100', subtype: 'channel_join', user: 'U2', text: '<@U2> has joined the channel' },
            { ts: '1712345500.000100', subtype: 'bot_message', bot_id: 'B9', text: 'Deploy finished' },
            { ts: '1712345400.000100', user: 'U3', text: 'edited words', edited: { ts: '1712345450.000000' } },
            { ts: '1712345300.000100', user: 'U3', text: '' },
          ],
          response_metadata: { next_cursor: 'h2' },
        },
        'C1:h2': { messages: [{ ts: '1712340000.000100', user: 'U1', text: 'first post' }] },
      },
      replies: {
        'C1:1712345678.000200': {
          messages: [
            { ts: '1712345678.000200', user: 'U1', text: 'The export 500s', thread_ts: '1712345678.000200' },
            { ts: '1712345700.000300', user: 'U2', text: 'Repro on staging', thread_ts: '1712345678.000200' },
          ],
        },
      },
    });
    const first = await provider.syncPage({ ...ORG, cursor: JSON.stringify({ queue: ['C1', 'G4'], seen: ['C1', 'G4'] }) }, slack.fetchSlack);
    expect(first.membership).toBeUndefined();
    expect(first.records.map((r: { nativeId: string }) => r.nativeId)).toEqual([
      'C1:1712345678.000200',
      'C1:1712345700.000300',
      'C1:1712345500.000100',
      'C1:1712345400.000100',
    ]);
    for (const record of first.records) {
      // A backfilled message is never a new-message event, so message workflows do not fire on it.
      expect(record).toMatchObject({ datatype: 'chat-message', event: 'history', aclRef: 'C1' });
      expect(validateDatatypePayload(CHAT_MESSAGE_SCHEMA, record.payload).ok).toBe(true);
    }
    expect(() => assertProviderRecords(first.records, { descriptor: manifest.provider })).not.toThrow();
    const [root, reply, bot, edited] = first.records;
    expect(root.payload).toMatchObject({ channelId: 'C1', threadId: '1712345678.000200', sender: 'U1', text: 'The export 500s', occurredAt: '2024-04-05T19:34:38.000Z' });
    expect(reply.payload).toMatchObject({ threadId: '1712345678.000200', sender: 'U2', text: 'Repro on staging' });
    expect(bot.payload).toMatchObject({ sender: 'B9', extensions: { slack: { subtype: 'bot_message' } } });
    // An edit is a new version, so the stored document follows it.
    expect(edited.version).toBe('history:C1:1712345400.000100:1712345450.000000');
    expect(root.version).toBe('history:C1:1712345678.000200:1712345678.000200');
    expect(first.hasMore).toBe(true);
    // Every page of the channel's read stops at the same `latest`, fixed on its first page.
    expect(cursorState(first)).toMatchObject({ queue: ['C1', 'G4'], seen: ['C1', 'G4'], page: 'h2', latest: expect.stringMatching(/^\d{10}\.\d{6}$/) });

    const second = await provider.syncPage({ ...ORG, cursor: first.nextCursor }, slack.fetchSlack);
    expect(second.records.map((r: { nativeId: string }) => r.nativeId)).toEqual(['C1:1712340000.000100']);
    expect(second.hasMore).toBe(true);
    expect(cursorState(second)).toEqual({ queue: ['G4'], seen: ['C1', 'G4'] });
  });

  it('reads a tombstone in history as a deletion and an edited message with its edit time', () => {
    const tombstone = provider.historyRecord('C1', {
      type: 'message', subtype: 'tombstone', text: 'This message was deleted.', user: 'USLACKBOT',
      ts: '1712345678.000200', thread_ts: '1712345678.000200', reply_count: 2,
    });
    expect(tombstone).toMatchObject({
      event: 'deleted', deleted: true, nativeId: 'C1:1712345678.000200', aclRef: 'C1', version: 'deleted:C1:1712345678.000200',
    });
    expect(tombstone.payload).toMatchObject({ text: '', threadKey: '1712345678.000200' });
    expect(validateDatatypePayload(CHAT_MESSAGE_SCHEMA, tombstone.payload).ok).toBe(true);
    expect(() => assertProviderRecords([tombstone], { descriptor: manifest.provider })).not.toThrow();

    const edited = provider.historyRecord('C1', { ts: '1712345400.000100', user: 'U3', text: 'edited words', edited: { ts: '1712345450.000000' } });
    expect(edited.payload.editedAt).toBe(new Date(1712345450_000).toISOString());
    expect(provider.historyRecord('C1', { ts: '1712345400.000100', user: 'U3', text: 'plain' }).payload.editedAt).toBeUndefined();
  });

  it('finishes the backfill on the last channel, and skips a channel whose history is gone', async () => {
    const slack = fakeWorkspace({
      history: {
        // The page cursor in flight reaches Slack with the request.
        'C1:h9': () => json({ ok: false, error: 'not_in_channel' }),
        G4: { messages: [{ ts: '1712345678.000200', user: 'U1', text: 'last' }] },
      },
    });
    const skipped = await provider.syncPage({ ...ORG, cursor: JSON.stringify({ queue: ['C1', 'G4'], seen: ['C1', 'G4'], page: 'h9' }) }, slack.fetchSlack);
    expect(skipped).toMatchObject({ records: [], hasMore: true });
    expect(cursorState(skipped)).toEqual({ queue: ['G4'], seen: ['C1', 'G4'] });
    const last = await provider.syncPage({ ...ORG, cursor: skipped.nextCursor }, slack.fetchSlack);
    expect(last.records).toHaveLength(1);
    expect(last.hasMore).toBe(false);
    expect(cursorState(last)).toEqual({ queue: [], seen: ['C1', 'G4'] });
  });

  it('after the backfill, refreshes membership each pass and backfills only channels it has not seen', async () => {
    const slack = fakeWorkspace({
      list: [{ channels: [{ id: 'C1', name: 'general', is_member: true }, { id: 'C5', name: 'new', is_member: true }] }],
      members: { C1: { members: ['U1'] }, C5: { members: ['U2'] } },
    });
    const page = await provider.syncPage({ ...ORG, mode: 'incremental', cursor: JSON.stringify({ queue: [], seen: ['C1', 'G4'] }) }, slack.fetchSlack);
    // G4 is gone from the snapshot, so its readers are removed (the host empties lists a full snapshot no longer names).
    expect(page.membership.containers.map((c: { ref: string }) => c.ref)).toEqual(['C1', 'C5']);
    expect(page.hasMore).toBe(true);
    // C1 was backfilled before, so this round also rescans its recent window (WI-6554700010012278).
    expect(cursorState(page)).toMatchObject({ queue: ['C5'], seen: ['C1', 'C5'], rescan: 'C1', rotate: 'C1' });

    const settled = await provider.syncPage({ ...ORG, mode: 'incremental', cursor: JSON.stringify({ queue: [], seen: ['C1', 'C5'] }) }, slack.fetchSlack);
    // Nothing new to backfill: the round only rescans the recent window of one known channel.
    expect(settled.hasMore).toBe(true);
    expect(cursorState(settled)).toMatchObject({ queue: [], seen: ['C1', 'C5'], rescan: 'C1', rotate: 'C1' });
  });

  it('starts over from membership on a cursor it cannot read', async () => {
    const slack = fakeWorkspace({ list: [{ channels: [] }] });
    const page = await provider.syncPage({ ...ORG, cursor: 'not-json' }, slack.fetchSlack);
    expect(page).toEqual({ records: [], membership: { members: [], containers: [] }, nextCursor: expect.any(String), hasMore: false });
    expect(cursorState(page)).toEqual({ queue: [], seen: [], deepAt: expect.any(String) });
  });

  it('raises Slack rate limits and auth refusals as the signals the host interprets', async () => {
    const limited = fakeWorkspace({ list: [() => json({ ok: false }, 429, { 'retry-after': '30' })] });
    const rateLimit = await provider.syncPage({ ...ORG, cursor: null }, limited.fetchSlack).catch((error: unknown) => error);
    expect(classifyProviderSyncError(rateLimit)).toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 30 });

    const revoked = fakeWorkspace({ history: { C1: () => json({ ok: false, error: 'token_revoked' }) } });
    const auth = await provider.syncPage({ ...ORG, cursor: JSON.stringify({ queue: ['C1'], seen: ['C1'] }) }, revoked.fetchSlack)
      .catch((error: unknown) => error);
    expect(classifyProviderSyncError(auth)).toMatchObject({ kind: 'auth' });
  });
});

describe('syncPage coverage: what each history page read completely (WI-6554700010012278)', () => {
  // 2024-04-06T00:00:00Z. Every page of one read stops at this ts, however long the read takes.
  const NOW_MS = Date.UTC(2024, 3, 6);
  const LATEST = '1712361600.000000';
  const BEFORE_LATEST = '2024-04-05T23:59:59.999Z';
  const ROOT = { ts: '1712345678.000200', user: 'U1', text: 'The export 500s', thread_ts: '1712345678.000200', reply_count: 1 };

  it('backfill pages cover their own slice of the channel and each re-read thread, down to the channel start', async () => {
    const slack = fakeWorkspace({
      history: {
        C1: { messages: [{ ts: '1712345700.000300', user: 'U1', text: 'newest' }, ROOT], response_metadata: { next_cursor: 'h2' } },
        'C1:h2': { messages: [
          { ts: '1712345650.000000', subtype: 'channel_join', user: 'U3', text: '<@U3> has joined the channel' },
          { ts: '1712345600.000500', user: 'U1', text: 'oldest' },
        ] },
      },
      replies: { 'C1:1712345678.000200': { messages: [ROOT, { ts: '1712345690.000100', thread_ts: ROOT.ts, user: 'U2', text: 'On it' }] } },
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    try {
      const first = await provider.syncPage({ ...ORG, cursor: JSON.stringify({ queue: ['C1'], seen: ['C1'] }) }, slack.fetchSlack);
      expect(first.coverage).toEqual([
        // Messages outside threads above the page's oldest one; the millisecond holding it is left out.
        { datatype: 'chat-message', containerRef: 'C1', from: '2024-04-05T19:34:38.001Z', to: BEFORE_LATEST,
          nativeIds: ['C1:1712345700.000300', 'C1:1712345678.000200'] },
        { datatype: 'chat-message', containerRef: 'C1', threadRef: ROOT.ts, to: BEFORE_LATEST,
          nativeIds: ['C1:1712345678.000200', 'C1:1712345690.000100'] },
      ]);
      expect(cursorState(first)).toEqual({ queue: ['C1'], seen: ['C1'], page: 'h2', latest: LATEST, upper: ROOT.ts });

      clock.mockReturnValue(NOW_MS + 60_000);
      const second = await provider.syncPage({ ...ORG, cursor: first.nextCursor }, slack.fetchSlack);
      // The last page reaches the channel's start, and names the join it keeps no record of: it is live.
      expect(second.coverage).toEqual([
        { datatype: 'chat-message', containerRef: 'C1', to: '2024-04-05T19:34:37.999Z', nativeIds: ['C1:1712345650.000000', 'C1:1712345600.000500'] },
      ]);
      expect(second.records.map((r: { nativeId: string }) => r.nativeId)).toEqual(['C1:1712345600.000500']);
      expect(second.hasMore).toBe(false);
      expect(cursorState(second)).toEqual({ queue: [], seen: ['C1'] });
      expect(slack.seen).toEqual([
        `conversations.history?channel=C1&limit=200&latest=${LATEST}`,
        `conversations.replies?channel=C1&ts=${ROOT.ts}&limit=200&latest=${LATEST}`,
        `conversations.history?channel=C1&limit=200&cursor=h2&latest=${LATEST}`,
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it('each round rescans the last week of one backfilled channel in turn; a message gone from history is missing from its window', async () => {
    const slack = fakeWorkspace({
      list: [{ channels: [{ id: 'C1', name: 'general', is_member: true }, { id: 'C5', name: 'new', is_member: true }] }],
      members: { C1: { members: ['U1'] }, C5: { members: ['U2'] } },
      // B (1712345710.000400) was deleted while the daemon was offline, so history returns only A.
      history: { C1: { messages: [{ ts: '1712345700.000300', user: 'U1', text: 'A' }] } },
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    try {
      const round = await provider.syncPage({ ...ORG, mode: 'incremental', cursor: JSON.stringify({ queue: [], seen: ['C1', 'C5'] }) }, slack.fetchSlack);
      expect(round.hasMore).toBe(true);
      expect(cursorState(round)).toEqual({ queue: [], seen: ['C1', 'C5'], rescan: 'C1', oldest: '1711756800.000000', rotate: 'C1', deepAt: String(NOW_MS) });

      const rescan = await provider.syncPage({ ...ORG, mode: 'incremental', cursor: round.nextCursor }, slack.fetchSlack);
      expect(slack.seen.at(-1)).toBe(`conversations.history?channel=C1&limit=200&oldest=1711756800.000000&latest=${LATEST}`);
      expect(rescan.coverage).toEqual([
        { datatype: 'chat-message', containerRef: 'C1', from: '2024-03-30T00:00:00.001Z', to: BEFORE_LATEST, nativeIds: ['C1:1712345700.000300'] },
      ]);
      expect(rescan.hasMore).toBe(false);
      expect(cursorState(rescan)).toEqual({ queue: [], seen: ['C1', 'C5'], rotate: 'C1', deepAt: String(NOW_MS) });

      const next = await provider.syncPage({ ...ORG, mode: 'incremental', cursor: rescan.nextCursor }, slack.fetchSlack);
      expect(cursorState(next)).toMatchObject({ rescan: 'C5', rotate: 'C5' });
      const wrapped = await provider.syncPage({ ...ORG, mode: 'incremental', cursor: JSON.stringify({ queue: [], seen: ['C1', 'C5'], rotate: 'C5' }) }, slack.fetchSlack);
      expect(cursorState(wrapped)).toMatchObject({ rescan: 'C1', rotate: 'C1' });
    } finally {
      clock.mockRestore();
    }
  });

  it('a deleted root that still has replies is left out of both live sets, and its replies stay live', async () => {
    const tombstone = { ts: ROOT.ts, thread_ts: ROOT.ts, subtype: 'tombstone', reply_count: 1, text: 'This message was deleted.' };
    const reply = { ts: '1712345690.000100', thread_ts: ROOT.ts, user: 'U2', text: 'On it' };
    const slack = fakeWorkspace({
      history: { C1: { messages: [tombstone] } },
      replies: { 'C1:1712345678.000200': { messages: [tombstone, reply] } },
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    try {
      const page = await provider.syncPage({ ...ORG, cursor: JSON.stringify({ queue: ['C1'], seen: ['C1'] }) }, slack.fetchSlack);
      expect(page.coverage).toEqual([
        { datatype: 'chat-message', containerRef: 'C1', to: BEFORE_LATEST, nativeIds: [] },
        { datatype: 'chat-message', containerRef: 'C1', threadRef: ROOT.ts, to: BEFORE_LATEST, nativeIds: ['C1:1712345690.000100'] },
      ]);
      expect(page.records).toMatchObject([{ nativeId: 'C1:1712345678.000200', deleted: true }, { nativeId: 'C1:1712345690.000100' }]);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('search.live (assistant.search.context with the searching person\'s token, D-026)', () => {
  it('asks Slack for the best messages the person can see and returns well-formed hits', async () => {
    const seen: HostFetchRequest[] = [];
    const result = await provider.invokeCapability(
      { source: 'src-org', capability: PROVIDER_SEARCH_LIVE_CAPABILITY, args: { query: '  export 500  ', limit: 50 } },
      async (request: HostFetchRequest) => {
        seen.push(request);
        return json({
          ok: true,
          results: {
            messages: [
              { author_user_id: 'U1', team_id: 'T1', channel_id: 'C1', channel_name: 'general', message_ts: '1712345678.000200', content: ' The export 500s ', permalink: 'https://example.slack.com/archives/C1/p1712345678000200' },
              { channel_id: 'D9', message_ts: '1712345700.000100', content: 'in a DM' },
              { channel_id: 'C1', message_ts: 'not-a-ts', content: 'dropped' },
              { channel_id: 'C1', message_ts: '1712345800.000100', content: '   ' },
            ],
          },
        });
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: 'https://slack.com/api/assistant.search.context', method: 'POST' });
    // No token in the request: the host injects the person's own user token for slack.com.
    expect(seen[0].headers?.authorization).toBeUndefined();
    expect(JSON.parse(seen[0].body ?? '{}')).toEqual({
      query: 'export 500',
      channel_types: ['public_channel', 'private_channel', 'mpim', 'im'],
      content_types: ['messages'],
      limit: 20,
      sort: 'score',
    });
    expect(providerLiveSearchResultIssue(result)).toBeNull();
    expect(result.hits).toEqual([
      {
        externalId: 'C1:1712345678.000200',
        title: '#general',
        text: 'The export 500s',
        occurredAt: '2024-04-05T19:34:38.000Z',
        participants: ['U1'],
        permalink: 'https://example.slack.com/archives/C1/p1712345678000200',
      },
      { externalId: 'D9:1712345700.000100', title: 'channel D9', text: 'in a DM', occurredAt: '2024-04-05T19:35:00.000Z', participants: [], permalink: null },
    ]);
  });

  it('refuses an empty query before any request, and names Slack refusals', async () => {
    await expect(provider.searchLive(noFetch, { query: '   ', limit: 5 })).rejects.toThrow('slack_search_query_invalid');
    const refused = await provider.searchLive(async () => json({ ok: false, error: 'missing_scope' }), { query: 'x', limit: 5 })
      .catch((error: { message: string; data?: unknown }) => error);
    expect(refused.message).toBe('slack_assistant_search_context_missing_scope');
    expect(refused.data).toEqual({ kind: 'auth' });
  });
});

describe('daemon.mjs (JSON-RPC over stdio)', () => {
  it('describes the manifest provider and routes chat.reply through host.fetch with its call token and source', async () => {
    const child = spawn(process.execPath, ['daemon.mjs'], { cwd: PACKAGE_DIR, stdio: ['pipe', 'pipe', 'inherit'] });
    const replies = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
    const hostFetches: Array<{ callToken: string; source: string; request: HostFetchRequest }> = [];
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.method === 'host.fetch') {
        hostFetches.push(message.params);
        send({ jsonrpc: '2.0', id: message.id, result: json({ ok: true, channel: 'C42', ts: '1712345999.000100' }) });
        return;
      }
      replies.get(message.id)?.(message);
    });
    const call = (id: number, method: string, params?: unknown) =>
      new Promise<{ result?: unknown; error?: unknown }>((resolveCall) => {
        replies.set(id, resolveCall);
        send({ jsonrpc: '2.0', id, method, params });
      });
    try {
      expect((await call(1, 'papercup.ping')).result).toBe('pong');
      expect((await call(2, 'provider.describe')).result).toEqual(manifest.provider);
      const reply = await call(3, 'provider.invoke', {
        callToken: 'call-123',
        request: { source: 'src-1', capability: 'chat.reply', args: { channelId: 'C42', threadId: '1712345678.000200', text: 'ok' } },
      });
      expect(reply.result).toEqual({ channelId: 'C42', threadId: '1712345678.000200', messageTs: '1712345999.000100' });
      expect(hostFetches).toHaveLength(1);
      expect(hostFetches[0]).toMatchObject({ callToken: 'call-123', source: 'src-1', request: { url: 'https://slack.com/api/chat.postMessage' } });
      const refused = await call(4, 'provider.invoke', { callToken: 'call-124', request: { source: 'src-1', capability: 'mail.send', args: {} } });
      expect(refused.error).toMatchObject({ message: 'provider_capability_unsupported:slack:mail.send' });
      const page = await call(5, 'provider.syncPage', { callToken: 'call-125', request: { source: 'src-1', cursor: null, mode: 'backfill' } });
      expect(page.result).toEqual({ records: [], nextCursor: null, hasMore: false });
      // ingress.normalize gets the call's host.fetch too: a shortcut click opens its form through it.
      const click = await call(6, 'provider.invoke', {
        callToken: 'call-126',
        request: {
          source: 'src-1',
          capability: 'ingress.normalize',
          args: {
            envelope: interactiveEnvelope({ type: 'message_action', callback_id: 'report_bug', trigger_id: 'trig-9', user: { id: 'U5' }, channel: { id: 'C42' }, message: { ts: REPORTED_TS } }),
            sourceConfig: {},
          },
        },
      });
      expect(click.result).toEqual({ records: [] });
      expect(hostFetches).toHaveLength(2);
      expect(hostFetches[1]).toMatchObject({ callToken: 'call-126', source: 'src-1', request: { url: 'https://slack.com/api/views.open', method: 'POST' } });
      // An organization source's sync reads Slack through the sync call's own host.fetch.
      const orgPage = await call(7, 'provider.syncPage', {
        callToken: 'call-127',
        request: { source: 'src-org', cursor: null, mode: 'backfill', scope: 'organization' },
      });
      expect(orgPage.result).toEqual({
        records: [],
        membership: { members: [], containers: [] },
        nextCursor: expect.any(String),
        hasMore: false,
      });
      expect(JSON.parse((orgPage.result as { nextCursor: string }).nextCursor)).toEqual({ queue: [], seen: [], deepAt: expect.any(String) });
      expect(hostFetches).toHaveLength(3);
      expect(hostFetches[2]).toMatchObject({ callToken: 'call-127', source: 'src-org' });
      expect(hostFetches[2].request.url).toMatch(/^https:\/\/slack\.com\/api\/conversations\.list\?/);
    } finally {
      child.kill();
    }
  });
});
