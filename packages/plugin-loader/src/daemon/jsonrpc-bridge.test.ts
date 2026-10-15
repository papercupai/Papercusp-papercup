/**
 * Tests for JsonRpcBridge — the newline-delimited JSON-RPC 2.0 framing used by
 * the subprocess daemon runtime: id correlation, reply/error dispatch,
 * notifications, garbage tolerance, partial-line buffering, timeout, shutdown.
 * Driven with in-memory PassThrough streams (no real subprocess).
 * Run with: npx vitest run packages/plugin-loader/src/daemon/jsonrpc-bridge.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { JsonRpcBridge, JsonRpcHandlerError, type JsonRpcNotification } from './jsonrpc-bridge';

let peerStdout: PassThrough; // peer → bridge (the bridge reads this)
let peerStdin: PassThrough; // bridge → peer (the bridge writes this)
let bridge: JsonRpcBridge;
let sent: string[];

const flush = () => new Promise((r) => setImmediate(r));
const lastSent = () => JSON.parse(sent.join('').trim().split('\n').pop()!);
/** Push a peer→bridge line. */
const peerSend = (obj: unknown) => peerStdout.write(`${JSON.stringify(obj)}\n`);

beforeEach(() => {
  peerStdout = new PassThrough();
  peerStdin = new PassThrough();
  sent = [];
  peerStdin.on('data', (c) => sent.push(c.toString()));
  bridge = new JsonRpcBridge(peerStdout, peerStdin);
});
afterEach(() => bridge.shutdown());

describe('call', () => {
  it('writes a tagged request and resolves with the matching reply result', async () => {
    const p = bridge.call('ping', { x: 1 });
    await flush();
    expect(lastSent()).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'ping', params: { x: 1 } });
    peerSend({ jsonrpc: '2.0', id: 1, result: 'pong' });
    expect(await p).toBe('pong');
  });

  it('rejects with the error code + message on an error reply', async () => {
    // .catch(e=>e) attaches the handler synchronously so the rejection is never "unhandled".
    const p = bridge.call('boom').catch((e: Error) => e);
    await flush();
    peerSend({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'kaboom' } });
    expect(String(await p)).toContain('-32000: kaboom');
  });

  it('keeps the error reply code and data on the rejected Error (a provider sync error kind rides in data)', async () => {
    // The host classifier (plugin-sdk providerSyncErrorOf) reads `cause.data`; dropping it turned every
    // daemon provider's rate limit or revoked token into a generic transient failure (P-011c, WI-6554700010012144).
    const p = bridge.call('sync').catch((e: unknown) => e);
    await flush();
    peerSend({ jsonrpc: '2.0', id: 1, error: { code: -32010, message: 'slack 429', data: { kind: 'rate-limited', retryAfterSeconds: 30 } } });
    const err = (await p) as Error & { code?: unknown; data?: unknown };
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(-32010);
    expect(err.data).toEqual({ kind: 'rate-limited', retryAfterSeconds: 30 });
  });

  it('leaves data undefined when the error reply carries none', async () => {
    const p = bridge.call('boom').catch((e: unknown) => e);
    await flush();
    peerSend({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'kaboom' } });
    const err = (await p) as Error & { code?: unknown; data?: unknown };
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(-32000);
    expect('data' in err).toBe(false);
  });

  it('assigns monotonic ids and routes each reply to its own caller', async () => {
    const a = bridge.call('a');
    const b = bridge.call('b');
    await flush();
    peerSend({ jsonrpc: '2.0', id: 2, result: 'B' }); // reply out of order
    peerSend({ jsonrpc: '2.0', id: 1, result: 'A' });
    expect(await a).toBe('A');
    expect(await b).toBe('B');
  });

  it('times out a call with no reply', async () => {
    const err = await bridge.call('slow', undefined, 20).catch((e: Error) => e);
    expect(String(err)).toMatch(/timed out after 20ms: slow/);
  });
});

describe('onData framing', () => {
  it('ignores garbage lines without crashing the bridge', async () => {
    peerStdout.write('this is not json\n');
    await flush();
    const p = bridge.call('ok');
    await flush();
    peerSend({ jsonrpc: '2.0', id: 1, result: 'still works' });
    expect(await p).toBe('still works');
  });

  it('ignores a stale reply for an unknown id', async () => {
    peerSend({ jsonrpc: '2.0', id: 999, result: 'nobody waiting' });
    await flush(); // no throw
    expect(true).toBe(true);
  });

  it('dispatches two messages delivered in one chunk', async () => {
    const fired: JsonRpcNotification[] = [];
    bridge.onNotification((n) => fired.push(n));
    peerStdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'e1' })}\n${JSON.stringify({ jsonrpc: '2.0', method: 'e2' })}\n`,
    );
    await flush();
    expect(fired.map((n) => n.method)).toEqual(['e1', 'e2']);
  });

  it('reassembles a reply split across two chunks', async () => {
    const p = bridge.call('x');
    await flush();
    peerStdout.write('{"jsonrpc":"2.0","id":1,"res');
    await flush();
    peerStdout.write('ult":"reassembled"}\n');
    expect(await p).toBe('reassembled');
  });
});

describe('notifications', () => {
  it('fires every registered handler for an id-less message', async () => {
    const got: unknown[] = [];
    bridge.onNotification((n) => got.push(n.params));
    bridge.onNotification((n) => got.push(`2:${n.method}`));
    peerSend({ jsonrpc: '2.0', method: 'hello', params: { a: 1 } });
    await flush();
    expect(got).toEqual([{ a: 1 }, '2:hello']);
  });
});

describe('onRequest (daemon→host requests, P-002)', () => {
  it('serves a registered method and replies with the handler result under the request id', async () => {
    const seen: unknown[] = [];
    bridge.onRequest('host.fetch', async (params) => {
      seen.push(params);
      return { status: 200 };
    });
    peerSend({ jsonrpc: '2.0', id: 'd-7', method: 'host.fetch', params: { url: 'https://x' } });
    await flush();
    await flush();
    expect(seen).toEqual([{ url: 'https://x' }]);
    expect(lastSent()).toEqual({ jsonrpc: '2.0', id: 'd-7', result: { status: 200 } });
  });

  it('replies result:null when the handler returns undefined', async () => {
    bridge.onRequest('host.log', () => undefined);
    peerSend({ jsonrpc: '2.0', id: 3, method: 'host.log' });
    await flush();
    await flush();
    expect(lastSent()).toEqual({ jsonrpc: '2.0', id: 3, result: null });
  });

  it('replies -32601 for a method the host did not expose, and never treats the request as a reply', async () => {
    // An in-flight host→daemon call with the SAME numeric id must not be
    // resolved by a daemon→host request carrying that id.
    let settled = false;
    const inflight = bridge.call('provider.describe').then(() => { settled = true; });
    await flush();
    peerSend({ jsonrpc: '2.0', id: 1, method: 'host.readFile', params: { path: '/etc/shadow' } });
    await flush();
    await flush();
    expect(lastSent()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'method not found: host.readFile' },
    });
    expect(settled).toBe(false);
    peerSend({ jsonrpc: '2.0', id: 1, result: 'described' });
    await inflight;
    expect(settled).toBe(true);
  });

  it('passes a JsonRpcHandlerError code, message and data through to the error reply', async () => {
    bridge.onRequest('host.fetch', () => {
      throw new JsonRpcHandlerError(-32003, 'egress-denied', { host: 'evil.example' });
    });
    peerSend({ jsonrpc: '2.0', id: 9, method: 'host.fetch', params: {} });
    await flush();
    await flush();
    expect(lastSent()).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32003, message: 'egress-denied', data: { host: 'evil.example' } },
    });
  });

  it('maps any other thrown value to -32000 with its message', async () => {
    bridge.onRequest('host.fetch', async () => {
      throw new Error('upstream exploded');
    });
    bridge.onRequest('host.other', () => {
      throw 'plain string';
    });
    peerSend({ jsonrpc: '2.0', id: 11, method: 'host.fetch' });
    await flush();
    await flush();
    expect(lastSent()).toEqual({ jsonrpc: '2.0', id: 11, error: { code: -32000, message: 'upstream exploded' } });
    peerSend({ jsonrpc: '2.0', id: 12, method: 'host.other' });
    await flush();
    await flush();
    expect(lastSent()).toEqual({ jsonrpc: '2.0', id: 12, error: { code: -32000, message: 'plain string' } });
  });

  it('does not write a reply after shutdown', async () => {
    let release!: () => void;
    bridge.onRequest('host.fetch', () => new Promise<string>((r) => { release = () => r('late'); }));
    peerSend({ jsonrpc: '2.0', id: 21, method: 'host.fetch' });
    await flush();
    bridge.shutdown();
    sent.length = 0;
    release();
    await flush();
    await flush();
    expect(sent.join('')).toBe('');
  });
});

describe('shutdown', () => {
  it('rejects in-flight calls and refuses new ones', async () => {
    const p = bridge.call('inflight').catch((e: Error) => e);
    bridge.shutdown(new Error('peer died'));
    expect(String(await p)).toContain('peer died');
    const after = await bridge.call('after').catch((e: Error) => e);
    expect(String(after)).toContain('bridge closed');
  });

  it('notify after shutdown is a silent no-op', async () => {
    bridge.shutdown();
    sent.length = 0;
    bridge.notify('event', { a: 1 });
    await flush();
    expect(sent.join('')).toBe('');
  });
});
