/**
 * Behavioral tests for the gateway's LOCAL backend proxy route
 * (local-concurrent-inference-2026-07-02 P-004, D-002): `/v1/chat/completions` routing to a
 * registered llama-server/vllm/ollama backend, least-loaded selection across siblings, in-request
 * failover on a dead backend, and the admin visibility/reload routes. Real HTTP servers stand in
 * for the local backends (no PG — the pool is fed directly via createLocalBackendPool/reload()).
 */
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readContent } from '../content-intake';
import { summarizeContent, runLocalSummary, type SummaryDeps } from '../content-summary';
import { createInferenceGateway, OWNER_HEADER, type GatewayDeps } from './gateway';
import {
  createLocalBackendPool,
  HEALTH_FAIL_THRESHOLD,
  type LocalBackend,
  type LocalBackendPool,
} from './local-backend-pool';

interface FakeBackend {
  id: string;
  server: http.Server;
  baseUrl: string;
  requests: { url?: string; body: string }[];
  close: () => Promise<void>;
}

async function startFakeBackend(
  id: string,
  reply: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<FakeBackend> {
  const requests: FakeBackend['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ url: req.url, body });
      reply(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  return { id, server, baseUrl: `http://127.0.0.1:${addr.port}`, requests, close: () => new Promise((r) => {
    server.close(() => r());
    // Failed cancellation assertions must preserve their evidence, not strand teardown.
    server.closeAllConnections();
  }) };
}

const okJsonReply = (payload: unknown) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

let backends: FakeBackend[] = [];
let pool: LocalBackendPool;
let gw: ReturnType<typeof createInferenceGateway>;
let port = 0;

afterEach(async () => {
  await gw?.close();
  await Promise.all(backends.map((b) => b.close()));
  backends = [];
});

/** The gateway requires SOME account routing config even when a test only exercises the
 *  local-backend path (it never reaches the account/token code for those routes). */
const stubAccount = { accountId: 'unused-stub', token: async () => 'unused' };

/**
 * `wrapPool` hands the GATEWAY a decorated pool while the test keeps the real one in `pool` (so
 * recordOutcome/recordStart still drive the genuine state). Used to observe the cold-start
 * pre-flight without a sleep.
 */
async function boot(
  entries: LocalBackend[],
  extraDeps: Partial<GatewayDeps> = {},
  wrapPool?: (p: LocalBackendPool) => LocalBackendPool,
) {
  pool = createLocalBackendPool(entries);
  gw = createInferenceGateway({ ...stubAccount, localBackends: wrapPool ? wrapPool(pool) : pool, ...extraDeps });
  port = await gw.listen(0);
}

/**
 * Demote a backend to unhealthy the way a stopped unit EVENTUALLY does in production: its
 * `/v1/models` probe fails, and HEALTH_FAIL_THRESHOLD consecutive failures flip `healthy` false.
 *
 * ⚠ "EVENTUALLY" is load-bearing, and every test below this line that calls `markStopped` is
 * therefore testing the STEADY STATE, not the moment of failure (D-014). Probes tick every 30s and
 * demotion needs 2 of them, so for up to ~60s after a real stop the pool still reports the backend
 * HEALTHY and selects it — and ornith's registered baseUrl is a sanitizing proxy that answers that
 * request with a 502 rather than refusing the connection. The FIRST caller after a stop hits that
 * window, never this one. D-013 mistook this helper's state for one production cannot reach; the
 * truth is narrower and worse — production reaches it only after two callers have eaten a 502.
 * The window itself is covered by the D-014 tests at the end of this file, which deliberately do
 * NOT call this helper.
 */
const markStopped = (id: string) => {
  for (let i = 0; i < HEALTH_FAIL_THRESHOLD; i++) pool.recordOutcome(id, false, 'probe failed: connection refused');
};

/** A registered on-demand backend — `lifecycle` + `unitName` are what make it STARTABLE. */
const onDemand = (id: string, baseUrl: string, models: string[], maxConcurrent = 4): LocalBackend => ({
  id,
  kind: 'llama-server',
  baseUrl,
  models,
  maxConcurrent,
  enabled: true,
  lifecycle: 'on-demand',
  unitName: `llama-${id}.service`,
});

const chatCompletions = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const chatCompletionsAs = (ownerId: string, body: unknown) => chatCompletions(body, { [OWNER_HEADER]: ownerId });

test('routes a matching model to the registered local backend', async () => {
  const b1 = await startFakeBackend('b1', okJsonReply({ id: 'chatcmpl-1', choices: [] }));
  backends = [b1];
  await boot([{ id: 'b1', kind: 'llama-server', baseUrl: b1.baseUrl, models: ['ornith-35b'], maxConcurrent: 4, enabled: true }]);

  const res = await chatCompletions({ model: 'ornith-35b', messages: [] });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { id: string };
  assert.equal(json.id, 'chatcmpl-1');
  assert.equal(b1.requests.length, 1);
  assert.equal(b1.requests[0].url, '/v1/chat/completions');
});

test('an unregistered model 502s with no reachable backend, not a hang or a crash', async () => {
  await boot([]);
  const res = await chatCompletions({ model: 'unknown-model', messages: [] });
  assert.equal(res.status, 502);
  const json = (await res.json()) as { error: { message: string } };
  assert.match(json.error.message, /no reachable local backend/);
});

test.each([false, true])('local chat namespace never reaches cloud when the pool is missing (missing=%s)', async (missing) => {
  const cloud = await startFakeBackend('cloud', okJsonReply({ id: 'should-never-be-used' }));
  backends = [cloud];
  await boot([], { upstreamBase: cloud.baseUrl, ...(missing ? { localBackends: undefined } : {}) });
  for (const path of ['/v1/chat/completions', '/v1/completions']) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'removed-local-model', messages: [{ role: 'user', content: 'PRIVATE FIXTURE' }] }) });
    assert.equal(res.status, missing ? 404 : 502);
  }
  assert.equal(cloud.requests.length, 0, 'pool absence never grants cloud forwarding');
});

test('summary uses the real SDK and local gateway, then fails closed after a registry reload', async () => {
  const local = await startFakeBackend('local', (_req, res, body) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = { id: 'chatcmpl-local', object: 'chat.completion.chunk', created: 0, model: 'fixture-local' };
    // Reproduce the measured engine default: reasoning consumes the output
    // budget without a visible summary unless its chat template disables it.
    if (JSON.parse(body).chat_template_kwargs?.enable_thinking !== false) {
      res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { reasoning_content: 'Analyze the source.' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 18, completion_tokens: 128, total_tokens: 146 } })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'Alpha: 12. Final tail: 56.' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 18, completion_tokens: 8, total_tokens: 26 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const cloud = await startFakeBackend('cloud', okJsonReply({ id: 'should-never-be-used' }));
  backends = [local, cloud];
  await boot([{ id: 'local', kind: 'llama-server', baseUrl: local.baseUrl, models: ['fixture-local'], maxConcurrent: 4, enabled: true }], { upstreamBase: cloud.baseUrl });
  const previousPort = process.env.PAPERCUSP_GATEWAY_PORT;
  process.env.PAPERCUSP_GATEWAY_PORT = String(port);
  let cloudCalls = 0;
  const deps: SummaryDeps = {
    async *run() { cloudCalls++; throw new Error('cloud runner must never be called'); },
    runLocal: runLocalSummary,
    // Classification deliberately remains stale after reload; transport must still refuse.
    isLocalModel: async () => true, checkBudget: async () => ({ exceeded: false }), recordSpend: async () => {},
    reuse: async (_ws, _key, factory) => factory(),
  };
  try {
    const source = await readContent({ kind: 'text', text: 'Alpha 12. Final tail 56.', ref: 'private:fixture' },
      { workspaceId: 'ws-test', readerId: 'reader-test' }, { authorize: async () => true });
    const result = await summarizeContent(source, { model: 'fixture-local', cache: false, maxOutputTokens: 128 }, undefined, deps);
    assert.equal(result.summary, 'Alpha: 12. Final tail: 56.');
    assert.equal(result.usage.costUsd, 0);
    assert.equal(result.usage.tokensIn, 18); assert.equal(result.usage.tokensOut, 8);
    assert.equal(local.requests.length, 1); assert.equal(local.requests[0].url, '/v1/chat/completions');
    const body = JSON.parse(local.requests[0].body);
    assert.equal(body.model, 'fixture-local'); assert.equal(body.max_tokens, 128);
    assert.equal(JSON.parse(body.messages[1].content).quotedSource, source.text);
    assert.equal(body.tools, undefined);
    pool.reload([]);
    await assert.rejects(summarizeContent(source, { model: 'fixture-local', cache: false, allowCloud: true }, undefined, deps),
      (error: unknown) => (error as { code?: string }).code === 'model-failed');
    assert.equal(local.requests.length, 1); assert.equal(cloud.requests.length, 0); assert.equal(cloudCalls, 0);
  } finally {
    if (previousPort === undefined) delete process.env.PAPERCUSP_GATEWAY_PORT;
    else process.env.PAPERCUSP_GATEWAY_PORT = previousPort;
  }
});

test.each([false, true])('summary distinguishes withheld HTTP headers from a stalled response body (headers=%s)', async headers => {
  // Warm only fixture modules before the short transport deadline so this
  // comparison measures HTTP progress rather than cold module loading.
  await Promise.all([import('@ai-sdk/openai'), import('../agent-loop/ai-sdk-port'), import('../agent-chat-stream')]);
  const backend = await startFakeBackend('stalled-summary', (_req, res) => {
    if (headers) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
    }
  });
  backends = [backend];
  const previousPort = process.env.PAPERCUSP_GATEWAY_PORT;
  process.env.PAPERCUSP_GATEWAY_PORT = new URL(backend.baseUrl).port;
  const phases: string[] = [];
  const deps: SummaryDeps = {
    async *run() { throw new Error('cloud runner forbidden'); },
    async *runLocal(options) {
      yield* runLocalSummary({ ...options, onSummaryPhase: stage => {
        phases.push(stage);
        options.onSummaryPhase?.(stage);
      } });
    },
    isLocalModel: async () => true, checkBudget: async () => ({ exceeded: false }),
    recordSpend: async () => {}, reuse: async (_workspace, _key, factory) => factory(),
  };
  try {
    const source = await readContent({ kind: 'text', text: 'Public transport fixture.' },
      { workspaceId: 'ws-test', readerId: 'reader-test' }, { authorize: async () => true });
    await assert.rejects(summarizeContent(source, { model: 'fixture-local', cache: false, timeoutMs: 500 }, undefined, deps),
      (error: unknown) => {
        const failure = error as { code: string; diagnostics: { stage: string } };
        assert.equal(failure.code, 'budget-exceeded');
        assert.equal(failure.diagnostics.stage, headers ? 'http-body-wait' : 'http-wait');
        return true;
      });
    assert.equal(backend.requests.length, 1);
    assert.equal(phases.includes('http-body-wait'), headers);
  } finally {
    if (previousPort === undefined) delete process.env.PAPERCUSP_GATEWAY_PORT;
    else process.env.PAPERCUSP_GATEWAY_PORT = previousPort;
  }
});

test('a non-JSON / model-less body 400s', async () => {
  await boot([]);
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
  assert.equal(res.status, 400);
});

test('local summary rejects truncated/oversized output and aborts the backend on cancellation', async () => {
  let mode: 'truncated' | 'oversized' | 'stalled' = 'truncated';
  let started!: () => void; let closed!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const cancelled = new Promise<void>(resolve => { closed = resolve; });
  const local = await startFakeBackend('local', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = { id: 'chatcmpl-local', object: 'chat.completion.chunk', created: 0, model: 'fixture-local' };
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { content: mode === 'oversized' ? '😀'.repeat(1025) : 'Incomplete.' }, finish_reason: null }] })}\n\n`);
    if (mode === 'stalled') { res.once('close', closed); started(); return; }
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: mode === 'truncated' ? 'length' : 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  backends = [local];
  await boot([{ id: 'local', kind: 'llama-server', baseUrl: local.baseUrl, models: ['fixture-local'], maxConcurrent: 4, enabled: true }]);
  const previousPort = process.env.PAPERCUSP_GATEWAY_PORT; process.env.PAPERCUSP_GATEWAY_PORT = String(port);
  const deps: SummaryDeps = { async *run() { throw new Error('cloud forbidden'); }, runLocal: runLocalSummary,
    isLocalModel: async () => true, checkBudget: async () => ({ exceeded: false }), recordSpend: async () => {}, reuse: async (_w, _k, factory) => factory() };
  try {
    const source = await readContent({ kind: 'text', text: 'Public cancellation fixture.' },
      { workspaceId: 'ws-test', readerId: 'reader-test' }, { authorize: async () => true });
    for (const next of ['truncated', 'oversized'] as const) {
      mode = next;
      await assert.rejects(summarizeContent(source, { model: 'fixture-local', cache: false, maxOutputTokens: 64 }, undefined, deps),
        (error: unknown) => (error as { code?: string }).code === 'output-incomplete');
    }
    mode = 'stalled'; const ac = new AbortController();
    const pending = summarizeContent(source, { model: 'fixture-local', cache: false }, ac.signal, deps);
    await ready; ac.abort();
    await assert.rejects(pending, (error: unknown) => (error as { code?: string }).code === 'cancelled');
    await Promise.race([cancelled, new Promise<never>((_, reject) => {
      const timeout = setTimeout(() => reject(new Error('backend was not cancelled')), 2000);
      cancelled.then(() => clearTimeout(timeout));
    })]);
  } finally {
    if (previousPort === undefined) delete process.env.PAPERCUSP_GATEWAY_PORT; else process.env.PAPERCUSP_GATEWAY_PORT = previousPort;
  }
});

test('a local-backend body stream that ERRORS mid-pipe does NOT crash the gateway (W2.2 crash-proofing guard)', async () => {
  // backend-reliability-100pct-2026-07-03 W2.2: the upstream body is piped to the client via
  // Readable.fromWeb(...).pipe(res). If that stream errors mid-body with NO 'error' listener,
  // Node throws it as an uncaughtException → the WHOLE shared gateway process dies (observed
  // 2026-07-02). This "bad" backend sends a 200 + partial body then RSTs the socket, forcing the
  // piped stream to error mid-flight. GUARD: the gateway must survive and still serve a LATER
  // request (pre-fix, this test crashes the worker; post-fix it is green).
  const bad = await startFakeBackend('bad', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"partial":true,'); // partial body — never completes
    setTimeout(() => { try { res.socket?.destroy(); } catch { /* gone */ } }, 20); // RST mid-stream
  });
  const good = await startFakeBackend('good', okJsonReply({ id: 'from-good' }));
  backends = [bad, good];
  await boot([
    { id: 'bad', kind: 'llama-server', baseUrl: bad.baseUrl, models: ['m-bad'], maxConcurrent: 4, enabled: true },
    { id: 'good', kind: 'llama-server', baseUrl: good.baseUrl, models: ['m-good'], maxConcurrent: 4, enabled: true },
  ]);

  // Hit the bad backend — its body stream errors mid-pipe. The client may see a reset/partial
  // response; that is acceptable. What must NOT happen is a process crash.
  await chatCompletions({ model: 'm-bad', messages: [] }).catch(() => undefined);

  // The gateway is still up: a subsequent request to a healthy backend succeeds.
  const res2 = await chatCompletions({ model: 'm-good', messages: [] });
  assert.equal(res2.status, 200, 'gateway survived the mid-pipe stream error and served a later request');
  const json = (await res2.json()) as { id: string };
  assert.equal(json.id, 'from-good');
});

test('least-loaded routing: sends the next request to the LESS busy backend', async () => {
  // b1 never responds (simulates a busy/slow backend held mid-flight); b2 replies fast.
  const held: http.ServerResponse[] = [];
  const b1 = await startFakeBackend('b1', (req, res) => {
    held.push(res); // never end() — keeps the request "in flight" from the pool's perspective
  });
  const b2 = await startFakeBackend('b2', okJsonReply({ id: 'from-b2' }));
  backends = [b1, b2];
  await boot([
    { id: 'b1', kind: 'llama-server', baseUrl: b1.baseUrl, models: ['m'], maxConcurrent: 4, enabled: true },
    { id: 'b2', kind: 'llama-server', baseUrl: b2.baseUrl, models: ['m'], maxConcurrent: 4, enabled: true },
  ]);

  // Fire one request that will hang on b1 (don't await — it stays in-flight).
  const inflight = chatCompletions({ model: 'm' });
  await new Promise((r) => setTimeout(r, 50)); // let it land + recordStart tick
  assert.equal(pool.inFlight('b1'), 1);

  // The NEXT request should route to b2 (b1 is busier).
  const res2 = await chatCompletions({ model: 'm' });
  assert.equal(res2.status, 200);
  const json2 = (await res2.json()) as { id: string };
  assert.equal(json2.id, 'from-b2');

  // Clean up the held request so afterEach can close cleanly.
  held.forEach((res) => res.writeHead(200, { 'content-type': 'application/json' }));
  held.forEach((res) => res.end('{}'));
  await inflight;
});

test('in-request failover: a dead backend is skipped in favor of a healthy sibling on the SAME request', async () => {
  const b2 = await startFakeBackend('b2', okJsonReply({ id: 'from-healthy-sibling' }));
  backends = [b2];
  await boot([
    // b1 points at a closed port — connection refused.
    { id: 'b1', kind: 'llama-server', baseUrl: 'http://127.0.0.1:1', models: ['m'], maxConcurrent: 4, enabled: true },
    { id: 'b2', kind: 'llama-server', baseUrl: b2.baseUrl, models: ['m'], maxConcurrent: 4, enabled: true },
  ]);

  const res = await chatCompletions({ model: 'm' });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { id: string };
  assert.equal(json.id, 'from-healthy-sibling');
  // The dead backend's failed attempt was recorded (feeds health demotion for FUTURE requests).
  assert.ok((pool.health().get('b1')?.consecutiveFailures ?? 0) >= 1);
});

test('a disabled backend is never selected even though it is registered', async () => {
  const b1 = await startFakeBackend('b1', okJsonReply({ id: 'should-not-be-called' }));
  backends = [b1];
  await boot([{ id: 'b1', kind: 'llama-server', baseUrl: b1.baseUrl, models: ['m'], maxConcurrent: 4, enabled: false }]);
  const res = await chatCompletions({ model: 'm' });
  assert.equal(res.status, 502);
  assert.equal(b1.requests.length, 0);
});

test('GET /admin/local-backends reports the live registry + health + in-flight', async () => {
  const b1 = await startFakeBackend('b1', okJsonReply({}));
  backends = [b1];
  await boot([{ id: 'b1', kind: 'llama-server', baseUrl: b1.baseUrl, models: ['m'], maxConcurrent: 4, enabled: true }]);
  const engineCapacity = {
    freeSlots: 3,
    totalSlots: 4,
    contextTokens: 131_072,
    observedAtMs: Date.now(),
    source: '/props',
  };
  pool.updateEngineCapacity('b1', engineCapacity);
  const res = await fetch(`http://127.0.0.1:${port}/admin/local-backends`);
  assert.equal(res.status, 200);
  const json = (await res.json()) as {
    configured: boolean;
    backends: { id: string; inFlight: number; engineCapacity: typeof engineCapacity | null }[];
  };
  assert.equal(json.configured, true);
  assert.equal(json.backends.length, 1);
  assert.equal(json.backends[0].id, 'b1');
  assert.equal(json.backends[0].inFlight, 0);
  assert.deepEqual(json.backends[0].engineCapacity, engineCapacity);
});

test('GET /admin/local-backends without a configured pool reports configured:false, not a crash', async () => {
  gw = createInferenceGateway({ ...stubAccount });
  port = await gw.listen(0);
  const res = await fetch(`http://127.0.0.1:${port}/admin/local-backends`);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { configured: boolean };
  assert.equal(json.configured, false);
});

test('POST /admin/reload folds onAdminReloadLocalBackends into the response when wired', async () => {
  await boot([]);
  gw.close && (await gw.close());
  let reloadCalls = 0;
  pool = createLocalBackendPool([]);
  gw = createInferenceGateway({
    ...stubAccount,
    localBackends: pool,
    onAdminReload: async () => ({ changed: false, version: 1, accounts: [] }),
    onAdminReloadLocalBackends: async () => {
      reloadCalls++;
      return { changed: true, count: 2 };
    },
  });
  port = await gw.listen(0);
  const res = await fetch(`http://127.0.0.1:${port}/admin/reload`, { method: 'POST' });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { localBackends: { changed: boolean; count: number } };
  assert.equal(reloadCalls, 1);
  assert.deepEqual(json.localBackends, { changed: true, count: 2 });
});

test('/v1/messages (Anthropic path) is unaffected by an unmatched local-backend pool — falls through untouched', async () => {
  // Stand up a FAKE Anthropic upstream so this test is HERMETIC — it must not depend on live
  // api.anthropic.com. EI-7524: the original assertion was just `assert.notEqual(res.status, 502)`
  // with NO `upstreamBase` wired, so `/v1/messages` reached the REAL Anthropic API and its status was
  // network-dependent — 401 when the connection succeeded, but a 502 "inference-gateway upstream error"
  // when the connection failed (CI / firewall / a transient DNS-or-connect hiccup during a long
  // full-suite run). That upstream-error 502 collides with proxyLocal's OWN "no reachable local
  // backend" 502, so a bare status check could not tell "wrongly routed to local-backend" from
  // "correctly routed to Anthropic, Anthropic just unreachable" → intermittent false failures.
  const anthropic = await startFakeBackend('anthropic-upstream', okJsonReply({ id: 'msg-from-anthropic', type: 'message' }));
  backends = [anthropic];
  await boot(
    [{ id: 'b1', kind: 'llama-server', baseUrl: 'http://127.0.0.1:1', models: ['some-local-model'], maxConcurrent: 4, enabled: true }],
    { upstreamBase: anthropic.baseUrl },
  );
  // `some-local-model` matches the registered local-backend pool, yet a `/v1/messages` request must NOT
  // be intercepted by the local-backend branch (that branch only handles `/v1/chat/completions` +
  // `/v1/completions` — a DISTINCT route namespace). Proof: the request lands on the Anthropic upstream,
  // not on proxyLocal (which would 502 "no reachable local backend").
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'some-local-model', messages: [] }),
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { id: string };
  assert.equal(json.id, 'msg-from-anthropic'); // reached the Anthropic upstream, NOT proxyLocal
  assert.equal(anthropic.requests.length, 1); // the Anthropic proxy forwarded it upstream…
  assert.equal(anthropic.requests[0].url, '/v1/messages'); // …at the same route namespace, untouched
  assert.notEqual(res.status, 502); // and never through proxyLocal's "no reachable backend" path
});

test('a saturated pool (model served, every slot busy) 429s with retry-after — retryable backpressure, NOT a 502 dead end', async () => {
  const held: http.ServerResponse[] = [];
  const b1 = await startFakeBackend('b1', (_req, res) => {
    held.push(res); // never end() — occupies the backend's one slot
  });
  backends = [b1];
  // A single-slot backend: once one request is in flight, the pool is saturated for 'm'.
  await boot([{ id: 'b1', kind: 'llama-server', baseUrl: b1.baseUrl, models: ['m'], maxConcurrent: 1, enabled: true }]);
  pool.updateEngineCapacity('b1', { totalSlots: 1, freeSlots: 1, observedAtMs: Date.now(), source: '/props' });

  // Occupy the one slot with a hanging request (unidentified caller — isolates POOL saturation from
  // the per-client circuit entirely).
  const inflight = chatCompletions({ model: 'm' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pool.inFlight('b1'), 1);

  // A second request for the SAME (served, healthy) model finds every slot busy → 429 + Retry-After,
  // NOT a 502: the model is reachable, just at capacity, so the caller should back off and retry
  // rather than treat it as a hard server error (D-010/D-012 graceful load-shed).
  const busy = await chatCompletions({ model: 'm' });
  assert.equal(busy.status, 429);
  assert.ok(busy.headers.get('retry-after'));
  const busyJson = (await busy.json()) as { error: { message: string } };
  assert.match(busyJson.error.message, /at capacity/);
  assert.equal(pool.inFlight('b1'), 1); // the shed never touched the backend

  held.forEach((res) => res.writeHead(200, { 'content-type': 'application/json' }));
  held.forEach((res) => res.end('{}'));
  await inflight;
});

// ── MAINTENANCE backend-context probe (deterministic-context-carry P-005) ──────────────────────
// The live per-slot window read: GET /maintenance/backend-context?model=<id> → the serving
// backend's /props n_ctx. Session launchers clamp their per-session registry to
// min(configured, THIS) — the ground truth a hand-set contextWindow drifts away from.

test('GET /maintenance/backend-context — reads n_ctx + total_slots from the serving backend /props', async () => {
  const b1 = await startFakeBackend('ornith-be', (req, res) => {
    if (req.url === '/props') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ default_generation_settings: { n_ctx: 204800 }, total_slots: 3 }));
      return;
    }
    res.writeHead(404).end();
  });
  backends = [b1];
  await boot([{ id: 'ornith-be', kind: 'llama-server', baseUrl: b1.baseUrl, models: ['ornith-35b'], maxConcurrent: 4, enabled: true }]);

  const res = await fetch(`http://127.0.0.1:${port}/maintenance/backend-context?model=ornith-35b`);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ok: boolean; model: string; backendId: string; nCtx: number; totalSlots: number | null };
  assert.deepEqual(json, { ok: true, model: 'ornith-35b', backendId: 'ornith-be', nCtx: 204800, totalSlots: 3 });
  assert.equal(b1.requests.length, 1);
  assert.equal(b1.requests[0].url, '/props');
});

test('GET /maintenance/backend-context — missing model param → 400', async () => {
  await boot([]);
  const res = await fetch(`http://127.0.0.1:${port}/maintenance/backend-context`);
  assert.equal(res.status, 400);
  const json = (await res.json()) as { error: { message: string } };
  assert.match(json.error.message, /`model` query param required/);
});

test('GET /maintenance/backend-context — model served by NO local backend → 404 (hosted models have no live n_ctx)', async () => {
  const b1 = await startFakeBackend('b1', okJsonReply({}));
  backends = [b1];
  await boot([{ id: 'b1', kind: 'llama-server', baseUrl: b1.baseUrl, models: ['other-model'], maxConcurrent: 4, enabled: true }]);
  const res = await fetch(`http://127.0.0.1:${port}/maintenance/backend-context?model=claude-opus-4-8`);
  assert.equal(res.status, 404);
  const json = (await res.json()) as { error: { message: string } };
  assert.match(json.error.message, /no local backend serves model/);
});

test('GET /maintenance/backend-context — backend /props failure → 502, never a crash or a made-up number', async () => {
  const b1 = await startFakeBackend('flaky', (_req, res) => { res.writeHead(500).end(); });
  backends = [b1];
  await boot([{ id: 'flaky', kind: 'llama-server', baseUrl: b1.baseUrl, models: ['m'], maxConcurrent: 4, enabled: true }]);
  const res = await fetch(`http://127.0.0.1:${port}/maintenance/backend-context?model=m`);
  assert.equal(res.status, 502);
  const json = (await res.json()) as { error: { message: string } };
  assert.match(json.error.message, /props returned 500/);
});

test('GET /maintenance/backend-context — /props with no usable n_ctx → 502 (a missing field is not a window)', async () => {
  const b1 = await startFakeBackend('empty', okJsonReply({ default_generation_settings: {} }));
  backends = [b1];
  await boot([{ id: 'empty', kind: 'llama-server', baseUrl: b1.baseUrl, models: ['m'], maxConcurrent: 4, enabled: true }]);
  const res = await fetch(`http://127.0.0.1:${port}/maintenance/backend-context?model=m`);
  assert.equal(res.status, 502);
  const json = (await res.json()) as { error: { message: string } };
  assert.match(json.error.message, /no usable n_ctx/);
});

test('slot affinity (P-028): an identified owner sticks to its warm backend while a fresh owner load-balances; /admin exposes the counters', async () => {
  const b1 = await startFakeBackend('aff-a', okJsonReply({ id: 'from-a' }));
  const b2 = await startFakeBackend('aff-b', okJsonReply({ id: 'from-b' }));
  backends = [b1, b2];
  await boot([
    { id: 'aff-a', kind: 'llama-server', baseUrl: b1.baseUrl, models: ['ornith-35b'], maxConcurrent: 4, enabled: true },
    { id: 'aff-b', kind: 'llama-server', baseUrl: b2.baseUrl, models: ['ornith-35b'], maxConcurrent: 4, enabled: true },
  ]);

  // First hop: cold assignment lands on 'aff-a' (deterministic id tie-break).
  assert.equal(((await (await chatCompletionsAs('owner-aff', { model: 'ornith-35b', messages: [] })).json()) as { id: string }).id, 'from-a');
  // Make 'aff-a' the BUSIER backend — pure least-loaded would now route to 'aff-b'.
  pool.recordStart('aff-a');
  pool.recordStart('aff-a');
  // Sticky owner stays on its warm backend; a fresh owner gets the idle sibling.
  assert.equal(((await (await chatCompletionsAs('owner-aff', { model: 'ornith-35b', messages: [] })).json()) as { id: string }).id, 'from-a');
  assert.equal(((await (await chatCompletionsAs('owner-new', { model: 'ornith-35b', messages: [] })).json()) as { id: string }).id, 'from-b');

  const admin = (await (await fetch(`http://127.0.0.1:${port}/admin/local-backends`)).json()) as {
    affinity: { hits: number; switches: number; cold: number; trackedOwners: number };
  };
  assert.equal(admin.affinity.hits, 1);
  assert.equal(admin.affinity.cold, 2);
  assert.equal(admin.affinity.switches, 0);
  assert.equal(admin.affinity.trackedOwners, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// P-008 / D-009 — START-ON-DEMAND (on-demand-local-inference-lifecycle-2026-08-17)
//
// D-009 settled WHERE the seam attaches, and these tests pin that decision rather than the
// item's original (unreachable) framing. "On a request routed to a stopped backend, start it
// before forwarding" cannot happen: pickLeastLoaded filters on `healthy`, a stopped backend
// fails its probe, so select() returns null and proxyLocal 502s BEFORE any forward. Nothing is
// ever routed to a stopped backend. Ensure-running therefore attaches at the DEAD-END PRE-FLIGHT
//   if (!pool.select(model) && !pool.saturatedFor(model)) coldStartError = await ensure...
// and the tests below fix each half of that condition, plus the health feedback that makes the
// started backend selectable on the SAME request.
// ─────────────────────────────────────────────────────────────────────────────

test('P-008/D-009 cold start: a model served ONLY by a stopped on-demand backend starts it and routes on that SAME request', async () => {
  const b1 = await startFakeBackend('ornith', okJsonReply({ id: 'from-cold-started' }));
  backends = [b1];
  const ensured: string[] = [];
  await boot([onDemand('ornith', b1.baseUrl, ['ornith-35b'])], {
    ensureLocalBackendRunning: async (b) => {
      ensured.push(b.id);
      return { ok: true };
    },
  });
  markStopped('ornith');
  assert.equal(pool.select('ornith-35b'), null, 'precondition: a stopped backend is NOT selectable');

  const res = await chatCompletions({ model: 'ornith-35b', messages: [] });

  assert.equal(res.status, 200, 'the cold start rescued a request that would otherwise 502');
  assert.deepEqual(ensured, ['ornith'], 'the stopped on-demand backend serving this model was started');
  assert.equal(((await res.json()) as { id: string }).id, 'from-cold-started');
  assert.equal(b1.requests.length, 1, 'the request was FORWARDED after the start, not dropped');
  // recordOutcome(id, true) is REQUIRED, not decoration: health moves only on probes and live
  // outcomes, so without feeding the success back the pool still believes the backend unhealthy
  // and the request 502s despite a running backend. The 200 above is what actually proves it.
  assert.equal(pool.health().get('ornith')?.healthy, true, 'the successful start was fed back into health state');
});

test('P-008/D-009: the WARM path never calls ensure-running — a healthy on-demand backend routes with zero lifecycle I/O', async () => {
  const b1 = await startFakeBackend('ornith', okJsonReply({ id: 'from-warm' }));
  backends = [b1];
  const ensured: string[] = [];
  await boot([onDemand('ornith', b1.baseUrl, ['ornith-35b'])], {
    ensureLocalBackendRunning: async (b) => {
      ensured.push(b.id);
      return { ok: true };
    },
  });
  // No markStopped: the backend is healthy, so select() hits on the first read.

  const res = await chatCompletions({ model: 'ornith-35b', messages: [] });

  assert.equal(res.status, 200);
  assert.deepEqual(ensured, [], 'a selectable backend must never reach the lifecycle seam — the warm path is one in-memory scan');
  assert.equal(b1.requests.length, 1);
});

test('P-008/D-009: a SATURATED pool still 429s and does NOT start another backend — the !saturatedFor guard is load-bearing', async () => {
  const b1 = await startFakeBackend('ornith', okJsonReply({ id: 'never-reached' }));
  backends = [b1];
  const ensured: string[] = [];
  // maxConcurrent 1, and its one slot is occupied: the model IS served by a healthy backend,
  // there is simply no free slot. select() returns null for a reason that has NOTHING to do with
  // the unit being down — exactly the case a naive "select() was null → start one" would answer
  // by spawning more GPU processes.
  await boot([onDemand('ornith', b1.baseUrl, ['ornith-35b'], 1)], {
    ensureLocalBackendRunning: async (b) => {
      ensured.push(b.id);
      return { ok: true };
    },
  });
  pool.updateEngineCapacity('ornith', { totalSlots: 1, freeSlots: 1, observedAtMs: Date.now(), source: '/props' });
  pool.recordStart('ornith');
  assert.equal(pool.select('ornith-35b'), null, 'precondition: nothing selectable');
  assert.equal(pool.saturatedFor('ornith-35b'), true, 'precondition: null for SATURATION, not for a dead end');

  const res = await chatCompletions({ model: 'ornith-35b', messages: [] });

  assert.equal(res.status, 429, 'backpressure, not a cold start');
  assert.ok(res.headers.get('retry-after'));
  assert.deepEqual(ensured, [], 'starting more GPU processes is not an answer to backpressure');
  assert.equal(b1.requests.length, 0);
});

test('P-008/D-009 CONTROL: the saturation guard is CAUSAL — the SAME busy state reaches the cold-start seam once the pool reports "not saturated"', async () => {
  // FALSIFIABILITY CONTROL for the 429 test above, and the reason this pair proves anything.
  // Every other guard here is pinned by an exact differential pair (cold-start vs warm differ only
  // in health; cold-start vs always-on differ only in `lifecycle`), but the 429 test differs from
  // the cold-start test in BOTH health and saturation — so on its own, "ensure was not called"
  // could equally be explained by a guard that had been deleted. This runs the identical busy
  // state with ONE thing changed: the pool reports saturatedFor === false. ensure IS then called,
  // so the `!saturatedFor` conjunct is demonstrably what suppresses it, not luck.
  const b1 = await startFakeBackend('ornith', okJsonReply({ id: 'from-cold-started' }));
  backends = [b1];
  const ensured: string[] = [];
  await boot(
    [onDemand('ornith', b1.baseUrl, ['ornith-35b'], 1)],
    {
      ensureLocalBackendRunning: async (b) => {
        ensured.push(b.id);
        return { ok: true };
      },
    },
    (p) => ({ ...p, saturatedFor: () => false }),
  );
  pool.updateEngineCapacity('ornith', { totalSlots: 1, freeSlots: 1, observedAtMs: Date.now(), source: '/props' });
  pool.recordStart('ornith');
  assert.equal(pool.select('ornith-35b'), null, 'same dead-end select() as the 429 test');

  // The response status is incidental here (the one slot is still busy, so nothing forwards) —
  // the observation under test is purely whether the lifecycle seam was reached.
  await chatCompletions({ model: 'ornith-35b', messages: [] });

  assert.deepEqual(ensured, ['ornith'], 'with saturation reported false, the SAME state reaches the cold-start seam');
});

test('P-008/D-009: an ALWAYS-ON unhealthy backend is never started — the seam is scoped to on-demand units', async () => {
  const b1 = await startFakeBackend('always', okJsonReply({ id: 'never-reached' }));
  backends = [b1];
  const ensured: string[] = [];
  // lifecycle omitted == 'always-on': a unit someone else owns the lifecycle of. Its being
  // unhealthy is a FAULT to report, not a cold start to perform.
  await boot([{ id: 'always', kind: 'llama-server', baseUrl: b1.baseUrl, models: ['m'], maxConcurrent: 4, enabled: true }], {
    ensureLocalBackendRunning: async (b) => {
      ensured.push(b.id);
      return { ok: true };
    },
  });
  markStopped('always');

  const res = await chatCompletions({ model: 'm', messages: [] });

  assert.equal(res.status, 502);
  assert.deepEqual(ensured, [], 'an always-on backend must never be started by the request path');
  const json = (await res.json()) as { error: { message: string } };
  assert.match(json.error.message, /none registered \/ all unhealthy/);
  assert.doesNotMatch(json.error.message, /cold start/, 'no start was attempted, so none may be reported');
});

test('P-008/D-009: a FAILED cold start is NAMED in the 502 — never flattened into "none registered"', async () => {
  const b1 = await startFakeBackend('ornith', okJsonReply({ id: 'never-reached' }));
  backends = [b1];
  await boot([onDemand('ornith', b1.baseUrl, ['ornith-35b'])], {
    ensureLocalBackendRunning: async () => ({ ok: false, error: 'unit llama-ornith.service failed: status=203/EXEC' }),
  });
  markStopped('ornith');

  const res = await chatCompletions({ model: 'ornith-35b', messages: [] });

  assert.equal(res.status, 502);
  const json = (await res.json()) as { error: { message: string } };
  // "we tried to start the backend that serves this model and could not" is a DIFFERENT operator
  // problem from "nothing serves this model" — reporting it as the latter hides the real fault.
  assert.match(json.error.message, /cold start of 'ornith' failed: unit llama-ornith\.service failed: status=203\/EXEC/);
  assert.doesNotMatch(json.error.message, /none registered/);
  assert.equal(b1.requests.length, 0);
});

test('P-008/D-009: a cold start that THROWS is surfaced as a 502, not an unhandled crash', async () => {
  const b1 = await startFakeBackend('ornith', okJsonReply({ id: 'never-reached' }));
  backends = [b1];
  await boot([onDemand('ornith', b1.baseUrl, ['ornith-35b'])], {
    ensureLocalBackendRunning: async () => {
      throw new Error('systemctl not on PATH');
    },
  });
  markStopped('ornith');

  const res = await chatCompletions({ model: 'ornith-35b', messages: [] });

  assert.equal(res.status, 502, 'an upstream-shaped lifecycle failure must not take the request (or the gateway) down');
  const json = (await res.json()) as { error: { message: string } };
  assert.match(json.error.message, /cold start of 'ornith' threw: systemctl not on PATH/);

  // And the gateway is still serving afterwards.
  const after = await chatCompletions({ model: 'nothing-serves-this', messages: [] });
  assert.equal(after.status, 502);
});

test('P-008/D-009: N concurrent requests for a stopped backend share ONE cold start — the in-flight map de-duplicates the WAIT', async () => {
  const b1 = await startFakeBackend('ornith', okJsonReply({ id: 'from-cold-started' }));
  backends = [b1];
  const ensured: string[] = [];

  let releaseStart: () => void = () => {};
  const startGate = new Promise<void>((r) => {
    releaseStart = r;
  });

  // Open the gate only once ALL THREE requests are genuinely parked on the shared promise — no
  // sleep, so this cannot flake under load. The cold-start PRE-FLIGHT is the only select() call
  // made with no `exclude` set; the attempt loop always passes its `tried` set.
  const CONCURRENCY = 3;
  let preflights = 0;
  let markParked: () => void = () => {};
  const allParked = new Promise<void>((r) => {
    markParked = r;
  });

  await boot(
    [onDemand('ornith', b1.baseUrl, ['ornith-35b'], 8)],
    {
      ensureLocalBackendRunning: async (b) => {
        ensured.push(b.id);
        await startGate;
        return { ok: true };
      },
    },
    (p) => ({
      ...p,
      select: (model, exclude, ownerId) => {
        if (exclude === undefined) {
          preflights++;
          if (preflights === CONCURRENCY) markParked();
        }
        return p.select(model, exclude, ownerId);
      },
    }),
  );
  markStopped('ornith');

  const inflight = Array.from({ length: CONCURRENCY }, () => chatCompletions({ model: 'ornith-35b', messages: [] }));
  await allParked; // every request has reached the pre-flight and is waiting on the shared start
  releaseStart();
  const results = await Promise.all(inflight);

  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200, 200],
    'all three requests were served by the single started backend',
  );
  assert.deepEqual(ensured, ['ornith'], 'exactly ONE start for three concurrent requests — the wait is shared, not repeated');
  assert.equal(b1.requests.length, CONCURRENCY, 'and all three were forwarded once it was up');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// P-008 / D-014 — COLD START AT THE FORWARD (the FIRST-FAILURE window)
//
// Everything above reaches ensure-running through the DEAD-END pre-flight, which requires the pool
// to already know the backend is unhealthy. That is the steady state, and it is not the state a
// real caller meets: for up to ~60s after a stop (a 30s probe tick x HEALTH_FAIL_THRESHOLD=2) the
// pool still selects the backend, and ornith's registered baseUrl is a SANITIZING PROXY that stays
// up and answers 502 instead of refusing the connection — so no transport error is thrown either.
// The gateway used to relay that 502 to the caller. These tests pin the rescue, and none of them
// calls `markStopped`: the pool believes the backend healthy throughout, which is the point.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Plays the SANITIZING PROXY in front of a unit: 502 with the proxy's exact ECONNREFUSED body
 *  while `running` is false, a real completion once it flips. `flip` is what a start does. */
async function startProxiedBackend(id: string, opts: { staysDown?: boolean } = {}) {
  let running = false;
  const b = await startFakeBackend(id, (_req, res) => {
    if (!running) {
      // Byte-shape of ollama-schema-proxy.mjs's error path: `res.writeHead(502)` +
      // `{"error":"connect ECONNREFUSED 127.0.0.1:11436"}`.
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'connect ECONNREFUSED 127.0.0.1:11436' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `chatcmpl-${id}`, choices: [{ message: { content: 'ok' } }] }));
  });
  return { ...b, start: () => { if (!opts.staysDown) running = true; } };
}

test('P-008/D-014 FIRST FAILURE: a proxy 502 from a backend the pool still believes HEALTHY cold-starts the unit and retries — the caller gets a completion, not the 502', async () => {
  const proxy = await startProxiedBackend('ornith');
  backends = [proxy];
  const started: string[] = [];
  await boot([onDemand('ornith', proxy.baseUrl, ['ornith-35b'])], {
    ensureLocalBackendRunning: async (b) => {
      started.push(b.unitName ?? '(none)');
      proxy.start();
      return { ok: true };
    },
  });

  const r = await chatCompletions({ model: 'ornith-35b', messages: [] });

  assert.equal(r.status, 200, 'the 502 was rescued, not relayed');
  const body = (await r.json()) as { id?: string };
  assert.equal(body.id, 'chatcmpl-ornith', 'and the body is a real completion from the started backend');
  assert.deepEqual(started, ['llama-ornith.service'], 'the unit was started exactly once');
  assert.equal(proxy.requests.length, 2, 'the failed attempt plus the retry — the retry re-targets the SAME backend');
});

test('P-008/D-014: a CONNECT-TIME transport failure also cold-starts and retries — the branch for a backend with no proxy in front of it', async () => {
  // The twin of the 502 case. ornith cannot produce this shape (its proxy answers instead of
  // refusing), so it needs its own coverage: a backend registered WITHOUT a proxy refuses the
  // connection outright, the fetch REJECTS, and the rescue has to fire from `catch` rather than
  // from the status check. Destroying the socket before any headers are sent is what makes the
  // failure connect-time (`!settled`) rather than mid-body.
  let unitRunning = false;
  const b1 = await startFakeBackend('bare', (req, res) => {
    if (!unitRunning) {
      req.socket.destroy(); // no response at all — the client sees a transport error
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'chatcmpl-bare', choices: [] }));
  });
  backends = [b1];
  const started: string[] = [];
  await boot([onDemand('bare', b1.baseUrl, ['ornith-35b'])], {
    ensureLocalBackendRunning: async (b) => {
      started.push(b.unitName ?? '(none)');
      unitRunning = true;
      return { ok: true };
    },
  });

  const r = await chatCompletions({ model: 'ornith-35b', messages: [] });

  assert.equal(r.status, 200, 'the transport failure was rescued, not surfaced as a 502');
  assert.equal(((await r.json()) as { id?: string }).id, 'chatcmpl-bare');
  assert.deepEqual(started, ['llama-bare.service'], 'the unit was started exactly once');
});

test('P-008/D-014 CONTROL: the IDENTICAL proxy 502 from an ALWAYS-ON backend is relayed untouched and starts nothing — the rescue is scoped to on-demand units', async () => {
  const proxy = await startProxiedBackend('alwayson');
  backends = [proxy];
  const started: string[] = [];
  await boot(
    [{ id: 'alwayson', kind: 'llama-server', baseUrl: proxy.baseUrl, models: ['ornith-35b'], maxConcurrent: 4, enabled: true }],
    {
      ensureLocalBackendRunning: async (b) => {
        started.push(b.unitName ?? '(none)');
        proxy.start();
        return { ok: true };
      },
    },
  );

  const r = await chatCompletions({ model: 'ornith-35b', messages: [] });

  assert.equal(r.status, 502, 'an always-on backend has no unit to start, so its 502 is the answer');
  assert.deepEqual(started, [], 'nothing was started');
  assert.equal(proxy.requests.length, 1, 'and it was not retried');
});

test('P-008/D-014: a 500 is NOT unreachable-shaped — a genuine inference error is relayed, never answered by restarting the GPU process', async () => {
  const started: string[] = [];
  const b1 = await startFakeBackend('ornith', (_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'failed to decode: out of context' } }));
  });
  backends = [b1];
  await boot([onDemand('ornith', b1.baseUrl, ['ornith-35b'])], {
    ensureLocalBackendRunning: async (b) => {
      started.push(b.unitName ?? '(none)');
      return { ok: true };
    },
  });

  const r = await chatCompletions({ model: 'ornith-35b', messages: [] });

  assert.equal(r.status, 500, 'the upstream 500 reached the caller');
  assert.deepEqual(started, [], 'and no restart was attempted — 500 means the process is alive and refusing the work');
  assert.equal(b1.requests.length, 1, 'no duplicate request: retrying a 500 would re-burn real GPU work');
});

test('P-008/D-014: at most ONE cold start per request — a backend still 502ing after a successful start is reported, not restarted again', async () => {
  const proxy = await startProxiedBackend('ornith', { staysDown: true }); // start "succeeds" but it keeps 502ing
  backends = [proxy];
  const started: string[] = [];
  await boot([onDemand('ornith', proxy.baseUrl, ['ornith-35b'])], {
    ensureLocalBackendRunning: async (b) => {
      started.push(b.unitName ?? '(none)');
      proxy.start();
      return { ok: true };
    },
  });

  const r = await chatCompletions({ model: 'ornith-35b', messages: [] });

  assert.equal(r.status, 502, 'a backend that will not come up is a real fault to surface');
  assert.deepEqual(started, ['llama-ornith.service'], 'exactly one start — the rescue does not loop');
});

test('P-008/D-014: a FAILED cold start on the forward path is NAMED in the 502, not flattened into the relayed upstream body', async () => {
  const proxy = await startProxiedBackend('ornith', { staysDown: true });
  backends = [proxy];
  await boot([onDemand('ornith', proxy.baseUrl, ['ornith-35b'])], {
    ensureLocalBackendRunning: async () => ({ ok: false, error: 'unit llama-ornith.service failed: status=203/EXEC' }),
  });

  const r = await chatCompletions({ model: 'ornith-35b', messages: [] });
  const body = (await r.json()) as { error?: { message?: string } };

  assert.equal(r.status, 502);
  assert.match(
    body.error?.message ?? '',
    /cold start of 'ornith' failed: unit llama-ornith\.service failed: status=203\/EXEC/,
    'the operator is told the START failed, not just that the backend answered 502',
  );
});
