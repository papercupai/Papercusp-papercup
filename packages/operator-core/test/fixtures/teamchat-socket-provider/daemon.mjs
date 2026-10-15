// TeamChat provider daemon: an independent author's chat integration for Papercusp, built only
// against the published SDK (@papercusp/plugin-sdk, types only) and Node's builtins.
//
// The host runs this file sandboxed (no network, no host files, no credentials) and speaks
// newline-delimited JSON-RPC 2.0 with it on stdin/stdout:
//   host → daemon: papercup.ping, provider.describe, provider.syncPage, provider.invoke
//   daemon → host: host.fetch { callToken, source, request }, valid only during the call that
//   issued callToken; the host adds the pasted API token for api.teamchat.example itself.
// TeamChat messages arrive over the gateway socket the HOST holds (provider.ingress.socket in
// papercusp.json): the host opens it with the pasted gateway token, acks each delivery, and hands it
// to `ingress.normalize` here. Nothing in this file ever sees a token.
import fs from 'node:fs';
import readline from 'node:readline';

/** @typedef {import('@papercusp/plugin-sdk').ProviderDescriptor} ProviderDescriptor */
/** @typedef {import('@papercusp/plugin-sdk').ProviderRecord} ProviderRecord */
/** @typedef {import('@papercusp/plugin-sdk').ProviderIngressNormalizeResult} NormalizeResult */
/** @typedef {import('@papercusp/plugin-sdk').HostFetchRequest} HostFetchRequest */
/** @typedef {import('@papercusp/plugin-sdk').HostFetchResponse} HostFetchResponse */
/** @typedef {(request: HostFetchRequest) => Promise<HostFetchResponse>} CallFetch */

const API = 'https://api.teamchat.example/v1';

/** @type {{ provider: ProviderDescriptor }} */
const manifest = JSON.parse(fs.readFileSync(new URL('./papercusp.json', import.meta.url), 'utf8'));

/** @param {unknown} value @returns {string} */
const str = (value) => (typeof value === 'string' ? value : '');

/** @param {unknown} value @returns {Record<string, unknown>} */
const obj = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};

/**
 * One gateway delivery → chat-message records. A hello, a rotate notice, a bot's own post, or any
 * event that is not a new message yields no records.
 * @param {unknown} envelope
 * @returns {NormalizeResult}
 */
export function normalize(envelope) {
  const env = obj(envelope);
  if (env.kind !== 'event') return { records: [] };
  const event = obj(env.event);
  if (event.type !== 'message.created') return { records: [] };
  const message = obj(event.message);
  const author = obj(message.author);
  if (author.bot === true) return { records: [] };
  const id = str(message.id);
  const room = str(message.room);
  const text = str(message.body);
  const sender = str(author.id);
  if (!id || !room || !text || !sender) return { records: [] };
  const occurredAt = str(message.created_at) || undefined;
  /** @type {string[]} */
  const mentions = Array.isArray(message.mentions) ? message.mentions.filter((m) => typeof m === 'string') : [];
  /** @type {ProviderRecord} */
  const record = {
    datatype: 'chat-message',
    nativeId: `${room}:${id}`,
    event: 'message',
    // One delivery per message: a redelivered event dedupes even if its envelope differs.
    version: `message:${room}:${id}`,
    ...(occurredAt ? { occurredAt } : {}),
    payload: {
      id,
      channelId: room,
      threadId: str(message.thread) || id,
      sender,
      text,
      mentions,
      ...(occurredAt ? { occurredAt } : {}),
      extensions: { teamchat: { deliveryId: str(env.delivery_id), workspace: str(event.workspace) } },
    },
  };
  return { records: [record] };
}

/**
 * A TeamChat API JSON body, or a thrown error the host understands (`data.kind: 'auth'`).
 * @param {HostFetchResponse} response
 * @param {string} what
 * @returns {Record<string, unknown>}
 */
function body(response, what) {
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error(`teamchat_${what}_unauthorized`), { data: { kind: 'auth' } });
  }
  if (response.status < 200 || response.status >= 300) throw new Error(`teamchat_${what}_http_${response.status}`);
  const raw = response.bodyEncoding === 'base64' ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
  return obj(JSON.parse(raw));
}

/**
 * `chat.channels`: the rooms the app can read, as option-picker entries.
 * @param {CallFetch} call
 */
async function listRooms(call) {
  const data = body(await call({ url: `${API}/rooms`, method: 'GET', headers: { accept: 'application/json' } }), 'rooms');
  const rooms = (Array.isArray(data.rooms) ? data.rooms : []).map(obj).filter((room) => str(room.id) && str(room.name));
  return {
    options: rooms.map((room) => ({
      value: str(room.id),
      label: `#${str(room.name)}`,
      ...(str(room.topic) ? { description: str(room.topic) } : {}),
    })),
  };
}

/**
 * `chat.reply`: post `text` in the thread `{ channelId, threadId }`.
 * @param {CallFetch} call
 * @param {Record<string, unknown>} args
 */
async function reply(call, args) {
  const channelId = str(args.channelId).trim();
  const threadId = str(args.threadId).trim();
  const text = str(args.text).trim();
  if (!channelId || !threadId || !text) throw new Error('teamchat_reply_args_invalid');
  const data = body(
    await call({
      url: `${API}/rooms/${encodeURIComponent(channelId)}/messages`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thread: threadId, body: text }),
    }),
    'reply',
  );
  const messageId = str(obj(data.message).id);
  if (!messageId) throw new Error('teamchat_reply_id_missing');
  return { channelId, threadId, messageId };
}

/* ─── the provider daemon protocol ─── */

/** @type {Map<string, { resolve: (value: HostFetchResponse) => void, reject: (error: Error) => void }>} */
const pending = new Map();
let nextId = 1;

/** @param {unknown} message */
const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

/**
 * The call's host.fetch: the host checks egress and injects the token; the daemon only asks.
 * @param {unknown} callToken
 * @param {string} source
 * @returns {CallFetch}
 */
const hostFetch = (callToken, source) => (request) =>
  new Promise((resolve, reject) => {
    const id = `d${nextId++}`;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method: 'host.fetch', params: { callToken, source, request } });
  });

/**
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @returns {Promise<unknown>}
 */
async function handle(method, params) {
  if (method === 'papercup.ping') return 'pong';
  if (method === 'provider.describe') return manifest.provider;
  // Messages arrive over the host-held socket; there is nothing to crawl.
  if (method === 'provider.syncPage') return { records: [], nextCursor: null, hasMore: false };
  if (method === 'provider.invoke') {
    const request = obj(params.request);
    const args = obj(request.args);
    const call = hostFetch(params.callToken, str(request.source));
    if (request.capability === 'ingress.normalize') return normalize(args.envelope);
    if (request.capability === 'chat.channels') return listRooms(call);
    if (request.capability === 'chat.reply') return reply(call, args);
    throw new Error(`teamchat_capability_unsupported:${str(request.capability)}`);
  }
  throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  /** @type {Record<string, unknown>} */
  let message;
  try {
    message = obj(JSON.parse(line));
  } catch {
    return;
  }
  if (message.method === undefined) {
    // A reply to one of our host.fetch requests.
    const id = str(message.id);
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    if (message.error) {
      const error = obj(message.error);
      waiter.reject(Object.assign(new Error(str(error.message) || 'host.fetch failed'), { data: error.data }));
    } else {
      waiter.resolve(/** @type {HostFetchResponse} */ (message.result));
    }
    return;
  }
  if (message.id === undefined) return; // a notification; this provider takes none
  const id = message.id;
  handle(str(message.method), obj(message.params)).then(
    (result) => send({ jsonrpc: '2.0', id, result }),
    (error) =>
      send({
        jsonrpc: '2.0',
        id,
        error: {
          code: typeof error?.code === 'number' ? error.code : -32000,
          message: String(error?.message ?? error),
          ...(error?.data ? { data: error.data } : {}),
        },
      }),
  );
});
