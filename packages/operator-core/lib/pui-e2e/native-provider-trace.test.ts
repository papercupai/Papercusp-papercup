import { describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import { nativeProviderRequestSignal, nativeProviderTraceOrigin, nativeRpcReceiptSummary } from './native-provider-trace';

describe('native provider trace resume', () => {
  const gateway = 'http://127.0.0.1:4321';
  const proxy = 'http://127.0.0.1:5432/api/pui-provider-debug';

  it('keeps the upstream when resume reads the rewritten registry', () => {
    const first = nativeProviderTraceOrigin(gateway, proxy);
    const resumed = nativeProviderTraceOrigin(`${proxy}/`, proxy, first);
    expect(`${resumed}/v1/messages`).toBe(`${gateway}/v1/messages`);
    expect(nativeProviderTraceOrigin(proxy, proxy, resumed)).toBe(gateway);
  });

  it('rejects a proxy target whose original upstream is unavailable or recursive', () => {
    expect(() => nativeProviderTraceOrigin(proxy, proxy)).toThrow('non-recursive upstream');
    expect(() => nativeProviderTraceOrigin(proxy, proxy, `${proxy}/v1`)).toThrow('non-recursive upstream');
  });

  it('honors a regenerated provider route, including a different route on the same host', () => {
    const newGateway = 'http://127.0.0.1:5432/api/provider';
    expect(nativeProviderTraceOrigin(newGateway, proxy, gateway)).toBe(newGateway);
  });

  it('recognizes an already-disconnected client and preserves unrelated abort causes', () => {
    const closed = new AbortController();
    closed.abort('Client connection prematurely closed.');
    expect(nativeProviderRequestSignal(closed.signal).reason).toMatchObject({ code: 'ERR_STREAM_PREMATURE_CLOSE' });
    const unrelated = new AbortController();
    const derived = nativeProviderRequestSignal(unrelated.signal);
    const failure = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    unrelated.abort(failure);
    expect(derived.reason).toBe(failure);
  });

  it('reports a real downstream abort as a cancelled stream instead of a server error', async () => {
    const listen = (server: Server) => new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
    const upstream = createServer((_req, response) => { response.writeHead(200); response.write('first chunk'); });
    const upstreamPort = await listen(upstream);
    const proxyServer = createAdaptorServer({ fetch: (request) => fetch(`http://127.0.0.1:${upstreamPort}`, {
      signal: nativeProviderRequestSignal(request.signal),
    }) }) as Server;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const proxyPort = await listen(proxyServer);
      const abort = new AbortController();
      const response = await fetch(`http://127.0.0.1:${proxyPort}`, { signal: abort.signal });
      await response.body!.getReader().read();
      abort.abort();
      await vi.waitFor(() => expect(errors.mock.calls.length + info.mock.calls.length).toBeGreaterThan(0));
      expect(errors).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith('The user aborted a request.');
    } finally {
      errors.mockRestore(); info.mockRestore();
      await Promise.all([upstream, proxyServer].map((server) => new Promise<void>((resolve) => {
        server.closeAllConnections(); server.close(() => resolve());
      })));
    }
  });

  it('summarizes bounded RPC receipt metadata without copying frame payloads', () => {
    const summary = nativeRpcReceiptSummary([
      { sequence: 1, phase: 'write-started', frame: { id: 'one', method: 'prompt', secret: 'redact-me' } },
      { sequence: 2, phase: 'write-completed', frame: { id: 'one', method: 'prompt' } },
      { sequence: 3, phase: 'received', frame: { id: 'one', type: 'response', result: 'private answer' } },
    ], { peerId: 'peer', emitted: 8, exited: true, pendingWrites: 0 }, { max: 2, totalObserved: 8 });
    expect(summary).toMatchObject({ total: 8, retained: 2, omitted: 6, receiptState: { peerId: 'peer', exited: true } });
    expect(summary).not.toHaveProperty('secret');
    expect(JSON.stringify(summary)).not.toContain('redact-me');
    expect(JSON.stringify(summary)).not.toContain('private answer');
    expect(summary).toHaveProperty('receipts.0.frame.keys');
  });
});
