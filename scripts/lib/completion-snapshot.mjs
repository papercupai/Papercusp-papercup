// Keep the completion JSON wire format and digest without a document-sized string.
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import parser from 'stream-json/parser.js';
import Assembler from 'stream-json/assembler.js';
import fun from 'stream-chain/fun.js';
import { none } from 'stream-chain';

const CHUNK_CHARS = 64 * 1024;

function* tokens(value, key, parents) {
  if (value && typeof value.toJSON === 'function') value = value.toJSON(key);
  if (value instanceof Number || value instanceof String || value instanceof Boolean) value = value.valueOf();
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value);
    if (text !== undefined) yield text;
    return;
  }
  if (parents.has(value)) throw new TypeError('Converting circular structure to JSON');
  parents.add(value);
  try {
    if (Array.isArray(value)) {
      yield '[';
      for (let i = 0; i < value.length; i++) {
        if (i) yield ',';
        const item = tokens(value[i], String(i), parents);
        const first = item.next();
        if (first.done) yield 'null';
        else { yield first.value; yield* item; }
      }
      yield ']';
    } else {
      yield '{';
      let separator = '';
      for (const name of Object.keys(value)) {
        const item = tokens(value[name], name, parents);
        const first = item.next();
        if (first.done) continue;
        yield separator + JSON.stringify(name) + ':';
        yield first.value;
        yield* item;
        separator = ',';
      }
      yield '}';
    }
  } finally { parents.delete(value); }
}

export function* jsonChunks(value) {
  let chunk = '';
  for (const token of tokens(value, '', new Set())) {
    // Keep scalar strings intact: splitting surrogate pairs changes the UTF-8 digest.
    if (chunk.length + token.length > CHUNK_CHARS && chunk) {
      yield chunk;
      chunk = '';
    }
    chunk += token;
  }
  if (chunk) yield chunk;
}

export function jsonSha256(value) {
  const hash = createHash('sha256');
  for (const chunk of jsonChunks(value)) hash.update(chunk);
  return hash.digest('hex');
}

export function* completionSnapshotChunks(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('completion snapshot must be an object');
  const { completionIntegrity: _priorIntegrity, ...body } = payload;
  const hash = createHash('sha256');
  let previous = '', length = 0;
  for (const chunk of jsonChunks(body)) {
    hash.update(chunk);
    length += chunk.length;
    if (previous) yield previous;
    previous = chunk;
  }
  yield previous.slice(0, -1);
  yield `${length > 2 ? ',' : ''}"completionIntegrity":${JSON.stringify({ schemaVersion: 1, sha256: hash.digest('hex') })}}`;
}

/** Sync-first stream-chain composition preserves the synchronous continuation API.
 * Retain the parsed object, without a second document-sized buffer/string. */
export function readCompletionJsonSync(path, chunkBytes = 64 * 1024) {
  const assembler = new Assembler();
  // Match JSON.parse for own __proto__ keys rather than assigning a prototype.
  assembler._saveValue = function(value) {
    if (this.done) this.current = value;
    else if (Array.isArray(this.current)) this.current.push(value);
    else {
      Object.defineProperty(this.current, this.key, { value, writable: true, enumerable: true, configurable: true });
      this.key = null;
    }
  };
  assembler.stringValue = assembler._saveValue;
  const consume = fun.collect(token => assembler.consume(token), [parser({ streamValues: false })]);
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(chunkBytes);
    for (;;) {
      const length = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!length) break;
      consume(buffer.subarray(0, length));
    }
    consume(none);
    if (!assembler.done) throw new Error('incomplete completion JSON');
    return assembler.current;
  } finally { closeSync(descriptor); }
}
