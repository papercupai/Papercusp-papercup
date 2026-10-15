/**
 * The decision deadline measures the PROVIDER, not the caller's event loop
 * (EI-24748208098755918, plan jev-memory-timeouts-to-zero-2026-10-01 P-007).
 *
 * These tests use a real local HTTP server and real `fetch`, because the defect is
 * an ordering property of Node's event loop — expired timers run before sockets are
 * read — which a scripted `fetch` cannot reproduce.
 *
 * The stall is produced inside the server's request handler: it writes the whole
 * response, then blocks the (shared) event loop past the client's deadline. When the
 * loop frees up, the client's deadline timer and the client's readable socket are
 * BOTH due; the timer runs first.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDecisionClient, createJevProvider, type DecisionRequest, type FetchLike } from './index.js';

const ANSWER = {
  model: 'jev-1.13.0',
  answers: {
    department: {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.88, technical: 0.12, sales: 0.0 },
      confidence: 0.81,
    },
  },
  usage: { input_tokens: 318, output_tokens: 34 },
};

const request = {
  state: 'Help! My payouts have been failing for 3 days.',
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      options: {
        billing: 'Payments, invoicing, refunds',
        technical: 'Bugs, outages, integrations',
        sales: 'Pricing, upgrades, new accounts',
      },
    },
  },
} as const satisfies DecisionRequest;

const DEADLINE_MS = 100;
/** How long the event loop is held, well past the deadline. */
const STALL_MS = 350;
/**
 * How long the 'slow' provider takes to answer. Deliberately FAR past the deadline:
 * when parallel test files starve this process of CPU, wall-clock time can run
 * hundreds of ms past the deadline even though the client never waited for the
 * provider (EI-24855002327339692 measured 354 ms against an old bound of 250 ms,
 * with the provider at only 350 ms). A client that waits for the provider takes
 * at least this long, so the two stay distinguishable under contention.
 */
const SLOW_PROVIDER_MS = 3_000;
/** Slack for a CPU-starved worker; still far below SLOW_PROVIDER_MS. */
const STARVATION_SLACK_MS = 1_000;

function blockEventLoop(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // Deliberately synchronous: this IS the stall under test.
  }
}

type Mode = 'answer-then-stall' | 'slow';
let mode: Mode = 'answer-then-stall';
/** Pending 'slow' replies, cleared on teardown so none outlives the suite. */
const pendingReplies = new Set<ReturnType<typeof setTimeout>>();
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const body = JSON.stringify(ANSWER);
      const send = () => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      };
      if (mode === 'slow') {
        // A provider that genuinely has not answered by the deadline; nothing blocks.
        const timer = setTimeout(() => {
          pendingReplies.delete(timer);
          send();
        }, SLOW_PROVIDER_MS);
        pendingReplies.add(timer);
        res.on('close', () => {
          clearTimeout(timer);
          pendingReplies.delete(timer);
        });
        return;
      }
      send();
      blockEventLoop(STALL_MS);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const timer of pendingReplies) clearTimeout(timer);
  pendingReplies.clear();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Real fetch, redirected from the provider's endpoint to the local server. */
const localFetch: FetchLike = (_url, init) => fetch(`${baseUrl}/v1/decide`, init);

function client() {
  return createDecisionClient({
    provider: createJevProvider(),
    resolveKey: () => 'ts-test-key',
    timeoutMs: DEADLINE_MS,
    fetch: localFetch,
    hostLoad: null,
  });
}

describe('decision deadline vs a blocked event loop', () => {
  it('positive control: a plain AbortSignal.timeout LOSES an answer that arrived during the stall', async () => {
    // If this ever passes, the scenario no longer reproduces the race, and the
    // next test would pass vacuously. Do not delete or loosen it.
    mode = 'answer-then-stall';
    const outcome = await fetch(`${baseUrl}/v1/decide`, {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.timeout(DEADLINE_MS),
    }).then(
      async (res) => ({ ok: true as const, text: await res.text() }),
      (err: unknown) => ({ ok: false as const, name: err instanceof Error ? err.name : String(err) }),
    );
    expect(outcome).toEqual({ ok: false, name: 'TimeoutError' });
  });

  it('answers when the response arrived while the loop was blocked past the deadline', async () => {
    mode = 'answer-then-stall';
    const out = await client().decide(request);
    expect(out).toMatchObject({ kind: 'answered', model: 'jev-1.13.0' });
    // The latency is real: the call spanned the stall.
    expect(out.latencyMs).toBeGreaterThanOrEqual(STALL_MS - 50);
  });

  it('still times out at the deadline when the provider genuinely has not answered', async () => {
    mode = 'slow';
    const t0 = performance.now();
    const out = await client().decide(request);
    const elapsed = performance.now() - t0;
    expect(out).toMatchObject({ kind: 'inconclusive', reason: 'timeout' });
    // Bounded by the deadline (plus slack for a CPU-starved worker), nowhere near the
    // provider's delay: a client that waited for the provider would take >= SLOW_PROVIDER_MS.
    expect(elapsed).toBeLessThan(DEADLINE_MS + STARVATION_SLACK_MS);
    expect(DEADLINE_MS + STARVATION_SLACK_MS).toBeLessThan(SLOW_PROVIDER_MS);
  });
});
