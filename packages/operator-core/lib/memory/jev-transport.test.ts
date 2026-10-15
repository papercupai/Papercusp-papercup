/**
 * jev-transport — the Jev decision client must reuse one connection across the idle
 * gaps production actually has (EI-24748208098755918, plan
 * jev-memory-timeouts-to-zero-2026-10-01 P-006).
 *
 * The server below sends NO Keep-Alive hint and never closes an idle socket — the
 * shape api.typesafe.ai was measured to have — so the only thing that can close the
 * connection between two calls is the CLIENT's idle timeout. The control run proves
 * the defect is real on this Node (global fetch reconnects after 4 s idle); the
 * subject run proves the Jev transport does not.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkerTransport, type FetchLike } from '@papercusp/decision-model';
import {
  __resetJevTransportForTest,
  createJevDispatcher,
  fetchVia,
  JEV_KEEPALIVE_IDLE_MS,
  JEV_SERVER_IDLE_OBSERVED_MS,
  jevDispatcher,
  jevFetch,
  jevWorkerTransport,
} from './jev-transport';

/** Longer than undici's 4 s default idle timeout, far shorter than ours. */
const IDLE_GAP_MS = 4_300;
/**
 * The worker transport uses Node's http(s) Agent, whose default idle timeout is 5 s,
 * so its gap must exceed 5 s to prove the configured window is the one in force.
 */
const WORKER_IDLE_GAP_MS = 5_500;

interface CountingServer {
  readonly url: string;
  connections(): number;
  close(): Promise<void>;
}

async function startCountingServer(): Promise<CountingServer> {
  let connections = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  // 0 = no idle timeout AND no `Keep-Alive: timeout=` hint, like the Jev endpoint.
  server.keepAliveTimeout = 0;
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/systemone`,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function twoCallsWithIdleGap(fetchImpl: FetchLike, url: string, gapMs: number = IDLE_GAP_MS): Promise<void> {
  const call = async () => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.status).toBe(200);
    await res.text();
  };
  await call();
  await new Promise((r) => setTimeout(r, gapMs));
  await call();
}

const servers: CountingServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await __resetJevTransportForTest();
});

describe('jev-transport', () => {
  it(
    'reuses one connection across an idle gap where the default global fetch reconnects',
    async () => {
      const control = await startCountingServer();
      const subject = await startCountingServer();
      servers.push(control, subject);
      const dispatcher = createJevDispatcher();
      try {
        await Promise.all([
          // CONTROL: global fetch, default dispatcher (undici keepAliveTimeout 4 s).
          twoCallsWithIdleGap((url, init) => fetch(url, init), control.url),
          // SUBJECT: the Jev keep-alive dispatcher.
          twoCallsWithIdleGap(fetchVia(dispatcher), subject.url),
        ]);
      } finally {
        await dispatcher.close();
      }
      // If the control ever stops reconnecting, this test no longer proves anything
      // about the Jev transport: fail loudly rather than pass vacuously.
      expect(control.connections()).toBe(2);
      expect(subject.connections()).toBe(1);
    },
    15_000,
  );

  it('keeps the idle window inside the server-side idle limit measured for api.typesafe.ai', () => {
    // Holding a socket the server already closed turns the next POST into an error
    // (undici does not retry non-idempotent requests), so the margin must stay.
    expect(JEV_KEEPALIVE_IDLE_MS).toBeGreaterThan(IDLE_GAP_MS);
    expect(JEV_KEEPALIVE_IDLE_MS).toBeLessThan(JEV_SERVER_IDLE_OBSERVED_MS);
  });

  it(
    'the worker transport (P-008) keeps its socket across an idle gap longer than Node’s 5 s agent default',
    async () => {
      // CONTROL: the same transport with a 3 s idle window must reconnect, or the
      // subject's single connection would prove nothing about JEV_KEEPALIVE_IDLE_MS.
      const control = await startCountingServer();
      const subject = await startCountingServer();
      servers.push(control, subject);
      const shortWindow = createWorkerTransport({ keepAliveIdleMs: 3_000 });
      try {
        await Promise.all([
          twoCallsWithIdleGap(shortWindow.fetch, control.url, WORKER_IDLE_GAP_MS),
          twoCallsWithIdleGap(jevWorkerTransport().fetch, subject.url, WORKER_IDLE_GAP_MS),
        ]);
      } finally {
        await shortWindow.close();
      }
      expect(control.connections()).toBe(2);
      expect(subject.connections()).toBe(1);
    },
    20_000,
  );

  it('shares one process-wide worker transport and keeps one connection across jevFetch calls', async () => {
    const server = await startCountingServer();
    servers.push(server);
    expect(jevDispatcher()).toBe(jevDispatcher());
    expect(jevWorkerTransport()).toBe(jevWorkerTransport());
    expect(jevWorkerTransport().mode()).toBe('worker');
    for (let i = 0; i < 3; i++) {
      // Back-to-back dispatch can race the previous socket's release and open a
      // second one; production calls are seconds apart, so space them slightly.
      if (i > 0) await new Promise((r) => setTimeout(r, 100));
      const res = await jevFetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5_000),
      });
      await res.text();
    }
    expect(server.connections()).toBe(1);
  });
});
