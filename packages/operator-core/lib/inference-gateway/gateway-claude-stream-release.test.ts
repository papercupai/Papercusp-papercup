/**
 * gateway-admission-congestion-only-2026-10-13 R-3 / P-003 (D-004) — the CLAUDE lane half.
 *
 * R-3's bar covers both remote provider lanes: a claude- or codex-lane request whose response
 * is streaming must not hold its lane admission slot. The Codex half is pinned in
 * gateway-openai-proxy.test.ts; the request-kernel half (release at the commit point, and the
 * CONTROL that a lane without the hook keeps its slot) is pinned in request-kernel.test.ts.
 * This file pins the claude lane's GATEWAY wiring: `/v1/messages` enters through the remote
 * provider-lane controller, whose `releaseForStream` the handler forwards to the kernel
 * (gateway.ts, the `releaseForStream` spread in the anthropic-messages admission).
 *
 * The upstream answers with SSE headers and one event, then holds the response open. While it
 * is open the claude lane (`/stats.admission`) must report the slot free, and a second request
 * must be admitted and finish.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { createInferenceGateway } from './gateway';
import { RateLimitGovernor } from '@papercusp/papercusp-shared/agent';
import { _resetDbHealth } from './db-health';

type Reply = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

let upstream: http.Server | undefined;
let gw: ReturnType<typeof createInferenceGateway> | undefined;
let port = 0;

afterEach(async () => {
  await gw?.close();
  await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()));
  gw = undefined;
  upstream = undefined;
  _resetDbHealth();
});

async function boot(reply: Reply): Promise<void> {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => reply(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', () => resolve()));
  const { port: upstreamPort } = upstream.address() as { port: number };
  const governor = new RateLimitGovernor({ maxConcurrent: 20 });
  gw = createInferenceGateway({
    accountId: 'acct-A',
    upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    token: async () => 'tok-A',
    governorFor: () => governor,
    maxQueueWaitMs: 2_000,
    selfHeal: { enabled: false },
  });
  port = await gw.listen(0);
}

const ask = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
const postMessages = (body: unknown) =>
  ask('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const claudeAdmission = async () =>
  ((await (await ask('/stats')).json()) as { admission: { running: number; queued: number } }).admission;

describe('proxy (claude lane) — a streaming response does not hold the lane admission slot (R-3)', () => {
  it('holds the claude slot through the upload until the upstream sends its first response byte', async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    let bodyArrived!: (body: string) => void;
    const arrived = new Promise<string>((resolve) => { bodyArrived = resolve; });
    await boot((_req, res, body) => {
      bodyArrived(body);
      void answered.then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const payload = 'x'.repeat(256 * 1024);
    const pending = postMessages({ model: 'claude-opus-4', max_tokens: 4,
      messages: [{ role: 'user', content: payload }] });
    try {
      expect((await arrived).length).toBeGreaterThan(payload.length);
      expect(await claudeAdmission(), 'upload complete, no upstream response byte: slot still held')
        .toMatchObject({ running: 1, queued: 0 });
    } finally {
      answer();
    }
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(await claudeAdmission()).toMatchObject({ running: 0, queued: 0 });
  });

  it('frees the claude lane slot while the stream is open, admits a second request, then relays the rest', async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let upstreamCalls = 0;
    await boot((_req, res) => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sse('message_start', { type: 'message_start', message: { id: 'msg_open', usage: { input_tokens: 3 } } }));
        void firstHeld.then(() => {
          res.end(sse('message_stop', { type: 'message_stop' }));
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    const first = await postMessages({
      model: 'claude-opus-4',
      max_tokens: 4,
      stream: true,
      messages: [{ role: 'user', content: 'hold me open' }],
    });
    expect(first.status).toBe(200);
    const reader = first.body!.getReader();
    const decoder = new TextDecoder();
    let relayed = '';
    while (!relayed.includes('message_start')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      relayed += decoder.decode(chunk.value, { stream: true });
    }
    expect(relayed).toContain('message_start');
    expect(relayed, 'the first stream is still open').not.toContain('message_stop');

    // The stream is open and no longer holds a claude lane slot.
    expect(await claudeAdmission()).toMatchObject({ running: 0, queued: 0 });

    // A second request is admitted and finishes while the first stream is still open.
    const second = await postMessages({ model: 'claude-opus-4', max_tokens: 4, messages: [{ role: 'user', content: 'second' }] });
    expect(second.status).toBe(200);
    expect((await second.json()) as { ok?: boolean }).toMatchObject({ ok: true });

    releaseFirst();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      relayed += decoder.decode(chunk.value, { stream: true });
    }
    expect(relayed).toContain('message_stop');

    expect(await claudeAdmission()).toMatchObject({ running: 0, queued: 0 });
    expect(upstreamCalls).toBe(2);
  });
});
