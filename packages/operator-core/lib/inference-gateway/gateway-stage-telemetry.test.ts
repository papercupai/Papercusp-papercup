import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from 'undici';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { getGovernor, resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';
import { createFailoverPool } from './account-failover';
import { createInferenceGateway, type GatewayStats, type GatewayCarryTrialAttempt, type GatewayCarryTrialAttemptResult,
  type GatewayCarryTrialBinding } from './gateway';
import { processMonotonicClock } from '../process-monotonic-clock';
import { MODEL_REQUEST_ID_HEADER, isModelRequestId } from '../observability/tracing';
import { readProcessIdentity } from '../process-identity';
import { CACHE_POLICY_VERSION } from './cache-policy';
import {
  configureGatewayRequestOutcomeStore,
  InMemoryGatewayRequestOutcomeStore,
  resetGatewayRequestOutcomeStore,
} from './gateway-request-outcome-store';

const NEVER_EMIT_MARKER = 'never-emit-me';

let gateway: ReturnType<typeof createInferenceGateway> | undefined;
let upstream: http.Server | undefined;

// Owner reports include durable outcomes; unit fixtures must not query PostgreSQL.
beforeEach(() => configureGatewayRequestOutcomeStore(new InMemoryGatewayRequestOutcomeStore()));

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
  upstream = undefined;
  resetGovernorRegistry();
  resetGatewayRequestOutcomeStore();
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

it.each((['bearer', 'oauth'] as const).flatMap(transport =>
  (['json', 'sse', 'sse-without-final-newline'] as const).map(framing => ({ transport, framing }))))(
  'finalizes Responses provider evidence before downstream completion ($transport/$framing)', async ({ transport, framing }) => {
    resetGovernorRegistry();
    const completed = { id: 'resp-tail-proof', model: 'gpt-6-sol', status: 'completed', output: [],
      usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } };
    upstream = http.createServer((req, res) => {
      req.resume(); req.once('end', () => {
        res.writeHead(200, { 'content-type': framing === 'json' ? 'application/json' : 'text/event-stream',
          [MODEL_REQUEST_ID_HEADER]: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:999' });
        res.end(framing === 'json' ? JSON.stringify(completed)
          : `data: ${JSON.stringify({ type: 'response.completed', response: completed })}${framing === 'sse' ? '\n\n' : ''}`);
      });
    });
    const upstreamPort = await listen(upstream);
    const home = transport === 'oauth' ? await mkdtemp(join(tmpdir(), 'gateway-tail-oauth-')) : undefined;
    const dispatcher = transport === 'oauth' ? new Agent({ connect: (_options, callback) => {
      const socket = net.connect(upstreamPort, '127.0.0.1');
      const failed = (error: Error) => callback(error, null);
      socket.once('error', failed);
      socket.once('connect', () => { socket.off('error', failed); callback(null, socket); });
    } }) : undefined;
    try {
    if (home) {
      const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const jwt = `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
      await writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
        access_token: jwt, refresh_token: 'PRIVATE_TAIL_REFRESH', account_id: 'tail-account',
      } }));
    }
    gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
      ...(home && dispatcher ? { codexCliAccounts: () => [{ accountId: 'tail-account', home }], codexOAuthProxy: true,
        fetchImpl: ((target, init) => fetch(target, { ...init, dispatcher } as RequestInit)) as typeof fetch }
        : { codexPool: createFailoverPool([{ accountId: 'tail-account', token: async () => 'PRIVATE_TAIL_TOKEN' }]) }),
      openaiUpstreamBase: `http://127.0.0.1:${upstreamPort}`, requestAbsorbMs: 0, selfHeal: { enabled: false } });
    const port = await gateway.listen(0);
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-papercusp-owner': 'su-tail-proof',
        [MODEL_REQUEST_ID_HEADER]: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:888' },
      body: JSON.stringify({ model: 'gpt-6-sol', input: 'PRIVATE_TAIL_PROMPT', stream: transport === 'oauth' || framing !== 'json',
        reasoning: { effort: 'high' } }) });
    await response.text();
    const { timeline } = await recentTimeline(port);
    const report = await (await fetch(`http://127.0.0.1:${port}/admin/owner-report?owner=su-tail-proof`)).json();
    const modelRequestId = response.headers.get(MODEL_REQUEST_ID_HEADER);
    expect(isModelRequestId(modelRequestId)).toBe(true);
    expect(modelRequestId).toBe(`${report.process.instanceId}:${timeline.requestId}`);
    expect(modelRequestId).not.toContain('aaaaaaaa');
    expect(modelRequestId).not.toContain('bbbbbbbb');
    if (transport === 'oauth' && framing === 'sse-without-final-newline') {
      // The maintained OAuth kernel requires a terminated terminal SSE frame.
      // Flushing observational bytes must not make this failed send successful.
      expect(response.status).toBe(502);
      expect(timeline).toMatchObject({ outcome: 'upstream-error', finalStatus: 502 });
      return;
    }
    expect(response.status).toBe(200);
    expect(timeline).toMatchObject({ outcome: 'ok', finalStatus: 200, attempts: 1,
      providerIdentity: { responseId: completed.id, model: completed.model, accountId: 'tail-account', effort: null },
      cache: { providerRequestId: completed.id, inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    expect(JSON.stringify(timeline)).not.toContain('PRIVATE_TAIL');
    } finally {
      await gateway?.close(); gateway = undefined;
      await dispatcher?.close();
      if (home) await rm(home, { recursive: true, force: true });
    }
  },
);

it('publishes one reconciled, privacy-safe stage timeline through /stats and the existing owner report', async () => {
  resetGovernorRegistry();
  upstream = http.createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"msg-stage","type":"message","role":"assistant","content":[]}');
    });
  });
  const upstreamPort = await listen(upstream);
  const pool = createFailoverPool([
    { accountId: 'stage-account', token: async () => 'BEARER_SECRET_MUST_NOT_SURFACE' },
  ]);
  gateway = createInferenceGateway({
    pool,
    upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    concurrency: 2,
    maxQueueWaitMs: 2_000,
    requestAbsorbMs: 0,
  });
  const port = await gateway.listen(0);
  const owner = 'su-stage-owner';
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-papercusp-owner': owner,
    },
    body: JSON.stringify({
      model: 'claude-opus-4',
      max_tokens: 8,
      stream: false,
      messages: [{ role: 'user', content: 'PROMPT_SECRET_MUST_NOT_SURFACE' }],
    }),
  });
  expect(response.status).toBe(200);
  await response.arrayBuffer();

  const statsResponse = await fetch(`http://127.0.0.1:${port}/stats`);
  const stats = (await statsResponse.json()) as GatewayStats;
  expect(stats.cachePolicy?.policyVersion).toBe(CACHE_POLICY_VERSION);
  const stages = stats.requestStages!;
  expect(stages.requests).toEqual({
    started: 1,
    finalized: 1,
    active: 0,
    sampled: 1,
    coverage: 1,
    reconciled: true,
    outcomeReconciled: true,
    missingStageTimelines: 0,
    cacheUsageObserved: 0,
    cacheWriteObserved: 0,
    cacheUsageCoverage: 0,
  });
  expect(stages.outcomes.ok).toBe(1);
  expect(stages.outcomes.unclassified).toBe(0);
  for (const stage of ['routeSelection', 'queueWait', 'bodyRead', 'auth', 'upstreamTtfb', 'total'] as const) {
    expect(stages.stages[stage].count, stage).toBe(1);
  }
  const timeline = stages.recent[0]!;
  expect(timeline).toMatchObject({
    ownerId: owner,
    provider: 'claude',
    protocol: 'anthropic-messages',
    transport: 'oauth-http',
    model: 'claude-opus-4',
    attempts: 1,
    failovers: 0,
    finalStatus: 200,
    outcome: 'ok',
    missingStages: [],
  });
  expect(['unchanged', 'rewritten']).toContain(timeline.cacheRouting);
  expect(timeline.admission.durable).toMatchObject({
    queued: expect.objectContaining({ priority: expect.any(Number) }),
    admitted: expect.objectContaining({ priority: expect.any(Number) }),
    waitMs: expect.any(Number),
  });
  expect(timeline.admission.provider).toMatchObject({
    queued: expect.objectContaining({
      priority: expect.any(Number),
      tier: null,
      running: expect.any(Number),
      queued: expect.any(Number),
      maxConcurrent: expect.any(Number),
      tier1Reserve: null,
      tierInFlight: null,
      tierQueued: null,
    }),
    admitted: expect.objectContaining({
      priority: expect.any(Number),
      tier: null,
      running: expect.any(Number),
      queued: expect.any(Number),
      maxConcurrent: expect.any(Number),
    }),
    waitMs: expect.any(Number),
  });

  const ownerResponse = await fetch(
    `http://127.0.0.1:${port}/admin/owner-report?owner=${encodeURIComponent(owner)}`,
  );
  const ownerReport = await ownerResponse.json() as {
    process: { pid: number; identity: string | null; startedAt: number };
    stageTelemetry: {
      ownerId: string;
      finalized: number;
      outcomes: { ok: number };
      recent: Array<{ admission: typeof timeline.admission }>;
    };
  };
  expect(ownerReport.stageTelemetry).toMatchObject({ ownerId: owner, finalized: 1, outcomes: { ok: 1 } });
  expect(ownerReport.process).toMatchObject({ pid: process.pid, identity: readProcessIdentity(process.pid) });
  expect(ownerReport.process.startedAt).toBeLessThanOrEqual(timeline.startedAt);
  expect(ownerReport.stageTelemetry.recent).toHaveLength(1);
  expect(ownerReport.stageTelemetry.recent[0]?.admission).toEqual(timeline.admission);

  const serialized = JSON.stringify({ stages, ownerReport });
  expect(serialized).not.toContain('PROMPT_SECRET_MUST_NOT_SURFACE');
  expect(serialized).not.toContain('BEARER_SECRET_MUST_NOT_SURFACE');
});

// ---------------------------------------------------------------------------
// codex cli-exec bridge — the span must describe the WIRE, not the transport's
// buffered implementation (WI-42457).
//
// The `cli-exec` transport descriptor declares `streaming: false` because it drives a nested
// `codex exec` to completion, but `serveCodexCliBridge` ADAPTS that completed run back onto
// Responses SSE whenever the client sent `stream:true` — which is how every gateway-routed
// Codex agent session is served. The handler used to stamp `setStreaming(false)` unconditionally,
// before the body was even parsed, which disarmed the ONE detector covering this path:
// `finish()` only requires the `stream` stage when the span says the request streamed. The
// result was that an SSE request which opened a stream and never terminated it was recorded
// identically to a non-streaming request that correctly had no stream — `ok`, no missing stage.
// ---------------------------------------------------------------------------

/** Boot a gateway with ONLY a codex-cli (ChatGPT-subscription) account, so `/v1/responses`
 *  routes to the cli-exec bridge. The upstream is inert — the bridge never forwards HTTP. */
async function bootCliBridge(run: () => Promise<{ text: string; inputTokens: number; outputTokens: number }>) {
  upstream = http.createServer((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  const upstreamPort = await listen(upstream);
  gateway = createInferenceGateway({
    // The Anthropic credential is only here because the constructor requires one; the codex
    // lane below has no bearer pool, which is what routes /v1/responses to the cli bridge.
    accountId: 'test-acct',
    token: async () => 'test-token',
    upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    concurrency: 2,
    maxQueueWaitMs: 2_000,
    requestAbsorbMs: 0,
    codexCliAccounts: () => [{ accountId: 'chatgpt-sub', home: '/tmp/sub-home' }],
    codexCliRun: run,
  });
  return gateway.listen(0);
}

async function recentTimeline(port: number) {
  const stats = (await (await fetch(`http://127.0.0.1:${port}/stats`)).json()) as GatewayStats;
  const stages = stats.requestStages!;
  return { stages, timeline: stages.recent[0]! };
}

it.each([false, true])('classifies a pre-upstream local 429 as shedding, not an upstream rejection (hard pin %s)', async hardPin => {
  let upstreamCalls = 0;
  upstream = http.createServer((_req, res) => {
    upstreamCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  gateway = createInferenceGateway({
    accountId: 'paced-telemetry',
    token: async () => 'test-token',
    upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    maxQueueWaitMs: 50,
    requestAbsorbMs: 0,
    selfHeal: { enabled: false },
  });
  const port = await gateway.listen(0);
  getGovernor('anthropic', 'opus', undefined, 'paced-telemetry').penalize({ retryAfterMs: 60_000 });
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-papercusp-owner': 'su-local-shed',
      ...(hardPin ? { 'x-papercusp-account': 'paced-telemetry', 'x-papercusp-account-pin': 'hard' } : {}),
    },
    body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'fixture' }] }),
  });
  expect(response.status).toBe(429);
  await response.text();
  const { stages, timeline } = await recentTimeline(port);
  expect(upstreamCalls).toBe(0);
  expect(timeline).toMatchObject({ ownerId: 'su-local-shed', attempts: 0, finalStatus: 429, outcome: 'shed' });
  expect(timeline.upstreamWrites.calls).toEqual([]);
  expect(stages.outcomes['upstream-429']).toBe(0);
  expect(stages.outcomes.shed).toBe(1);
  const report = await (await fetch(`http://127.0.0.1:${port}/admin/owner-report?owner=su-local-shed`)).json();
  expect(report.ledger.sheds).toBe(1);
  expect(report.ledger.upstream429).toBe(0);
  expect(report.stageTelemetry.recent[0].outcome).toBe('shed');
});

it.each(['downstream-cancel', 'upstream-timeout'] as const)(
  'distinguishes %s before attributing a failed attempt to its egress proxy',
  async (cause) => {
    const logs: { level: string; message: string }[] = [];
    let entered!: () => void;
    const attemptStarted = new Promise<void>(resolve => { entered = resolve; });
    let observed!: () => void;
    const attemptObserved = new Promise<void>(resolve => { observed = resolve; });
    let calls = 0;
    gateway = createInferenceGateway({
      pool: createFailoverPool([{
        accountId: 'abort-proxy', token: async () => 'fixture-token',
        egress: { proxyUrl: 'http://127.0.0.1:3128' },
      }]),
      upstreamBase: 'http://upstream.invalid',
      fetchImpl: async (_url, init) => {
        if (++calls > 1) return new Response('{}', { status: 200 });
        entered();
        return new Promise<Response>((_resolve, reject) => {
          const signal = init!.signal!;
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      upstreamHeadersTimeoutMs: cause === 'upstream-timeout' ? 80 : 5_000,
      requestAbsorbMs: 0,
      selfHeal: { enabled: false },
      log: (level, message) => {
        logs.push({ level, message });
        if (message.includes('upstream fetch') || message.includes('downstream cancelled')) observed();
      },
    });
    const port = await gateway.listen(0);
    const owner = `su-${cause}`;
    let controller = new AbortController();
    const request = () => fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-papercusp-owner': owner },
      body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'fixture' }] }),
    });
    const pending = request().catch(() => null);
    await attemptStarted;
    if (cause === 'downstream-cancel') controller.abort();
    const response = await pending;
    await response?.text();
    await attemptObserved;
    const stats = gateway.stats();
    const timeline = stats.requestStages!.recent.find(t => t.ownerId === owner)!;
    expect(timeline).toBeDefined();
    if (cause === 'downstream-cancel') {
      expect(stats.upstreamErrors).toBe(0);
      expect(stats.egressFailsByAccount['abort-proxy'] ?? 0).toBe(0);
      expect(stats.edgeThrottleByAccount?.['abort-proxy']?.cooldownUntil ?? 0).toBe(0);
      expect(timeline.outcome).toBe('cancelled');
      expect(logs.some(l => l.level === 'info' && l.message.includes('downstream cancelled')
        && l.message.includes('code=cancelled') && l.message.includes(`:${timeline.requestId} `))).toBe(true);
      expect(logs.some(l => l.message.includes('STALLED'))).toBe(false);
      controller = new AbortController();
      const recovered = await request();
      expect(recovered.status).toBe(200);
      await recovered.text();
      expect(calls).toBe(2);
    } else {
      expect(stats.upstreamErrors).toBeGreaterThan(0);
      expect(stats.egressFailsByAccount['abort-proxy']).toBeGreaterThan(0);
      expect(stats.edgeThrottleByAccount?.['abort-proxy']?.cooldownUntil ?? 0).toBeGreaterThan(Date.now());
      expect(timeline.outcome).toBe('upstream-error');
      expect(logs.some(l => l.level === 'error' && l.message.includes('STALLED')
        && l.message.includes('code=ttfb-timeout') && l.message.includes(`:${timeline.requestId} `))).toBe(true);
    }
  },
);

it.each(['cli', 'oauth', 'bearer'] as const)(
  'separates Codex %s cancellation from an upstream deadline in counters and owner reports',
  async transport => {
    const home = await mkdtemp(join(tmpdir(), 'gateway-codex-cancel-'));
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    await writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      access_token: `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`,
      refresh_token: 'fixture-refresh', account_id: 'abort-codex',
    } }));
    try {
      for (const cause of ['downstream-cancel', 'upstream-timeout'] as const) {
        const logs: { level: string; message: string }[] = [];
        let entered!: () => void;
        const attemptStarted = new Promise<void>(resolve => { entered = resolve; });
        let calls = 0;
        const blockedAttempt = (signal: AbortSignal) => {
          entered();
          return new Promise<never>((_resolve, reject) => {
            const abort = () => reject(new DOMException('fixture aborted', 'AbortError'));
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        };
        gateway = createInferenceGateway({
          accountId: 'unused-claude', token: async () => 'unused',
          upstreamBase: 'http://upstream.invalid', openaiUpstreamBase: 'http://upstream.invalid',
          ...(transport === 'bearer'
            ? { codexPool: createFailoverPool([{ accountId: 'abort-codex', token: async () => 'fixture-token' }]) }
            : { codexCliAccounts: () => [{ accountId: 'abort-codex', home }], codexOAuthProxy: transport === 'oauth' }),
          codexCliRun: async opts => {
            if (++calls === 1) await blockedAttempt(opts.signal!);
            return { text: 'recovered', inputTokens: 1, outputTokens: 1 };
          },
          fetchImpl: async (_url, init) => {
            if (++calls === 1) await blockedAttempt(init!.signal!);
            return transport === 'oauth'
              ? new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_recovered', output: [] } })}\n\ndata: [DONE]\n\n`,
                { headers: { 'content-type': 'text/event-stream' } })
              : new Response(JSON.stringify({ id: 'resp_recovered', output: [] }), { status: 200 });
          },
          requestCeilingMs: cause === 'upstream-timeout' && transport === 'cli' ? 2_000 : 5_000,
          upstreamHeadersTimeoutMs: cause === 'upstream-timeout' ? 80 : 5_000,
          upstreamStreamHeadersTimeoutMs: cause === 'upstream-timeout' ? 80 : 5_000,
          requestAbsorbMs: 0, selfHeal: { enabled: false },
          log: (level, message) => { logs.push({ level, message }); },
        });
        const port = await gateway.listen(0);
        const owner = `su-${transport}-${cause}`;
        let controller = new AbortController();
        const request = () => fetch(`http://127.0.0.1:${port}/v1/responses`, {
          method: 'POST', signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-papercusp-owner': owner },
          body: JSON.stringify({ model: 'gpt-6-sol', input: 'fixture', stream: transport === 'oauth' }),
        });
        const pending = request().catch(() => null);
        await attemptStarted;
        if (cause === 'downstream-cancel') controller.abort();
        const response = await pending;
        await response?.text();
        await vi.waitFor(() => {
          expect(gateway!.stats().requestStages!.recent.find(t => t.ownerId === owner)).toBeDefined();
        });
        const stats = gateway.stats();
        const timeline = stats.requestStages!.recent.find(t => t.ownerId === owner)!;
        const report = await (await fetch(`http://127.0.0.1:${port}/admin/owner-report?owner=${owner}`)).json();
        if (cause === 'downstream-cancel') {
          expect(stats.codex.errors).toBe(0);
          expect(report.ledger.upstreamErrors).toBe(0);
          expect(stats.egressFailsByAccount['abort-codex'] ?? 0).toBe(0);
          expect(stats.edgeThrottleByAccount?.['abort-codex']?.cooldownUntil ?? 0).toBe(0);
          expect(timeline.outcome).toBe('cancelled');
          expect(logs.some(l => l.level === 'info' && l.message.includes('code=cancelled')
            && l.message.includes(`:${timeline.requestId} `))).toBe(true);
          controller = new AbortController();
          const recovered = await request();
          expect(recovered.status).toBe(200); await recovered.text();
          expect(calls).toBe(2);
        } else {
          expect(stats.codex.errors).toBeGreaterThan(0);
          expect(report.ledger.upstreamErrors).toBeGreaterThan(0);
          // Buffered CLI execution is bounded by the request ceiling, which
          // retains its gateway-error contract rather than an HTTP TTFB error.
          expect(timeline.outcome).toBe(transport === 'cli' ? 'gateway-error' : 'upstream-error');
        }
        await gateway.close(); gateway = undefined;
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it('keeps an actual upstream HTTP 429 distinct from pre-upstream shedding', async () => {
  let upstreamCalls = 0;
  upstream = http.createServer((_req, res) => {
    upstreamCalls++;
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600' });
    res.end('{"type":"error","error":{"type":"rate_limit_error","message":"fixture rejected"}}');
  });
  const upstreamPort = await listen(upstream);
  gateway = createInferenceGateway({
    accountId: 'rejected-telemetry',
    token: async () => 'test-token',
    upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    maxQueueWaitMs: 50,
    requestAbsorbMs: 0,
    selfHeal: { enabled: false },
  });
  const port = await gateway.listen(0);
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-owner': 'su-upstream-rejected' },
    body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'fixture' }] }),
  });
  expect(response.status).toBe(429);
  await response.text();
  const { stages, timeline } = await recentTimeline(port);
  // The existing retry policy may make more than one real upstream attempt.
  // Join the timeline to the actual writes rather than assuming a single send.
  expect(upstreamCalls).toBeGreaterThan(0);
  expect(timeline).toMatchObject({ attempts: upstreamCalls, finalStatus: 429, outcome: 'upstream-429' });
  expect(stages.outcomes['upstream-429']).toBe(1);
  expect(stages.outcomes.shed).toBe(0);
});

it.each([false, true])('retains native request correlation and the served CLI account (oversized fingerprint body %s)', async large => {
  const port = await bootCliBridge(async () => ({ text: 'BRIDGED', inputTokens: 7, outputTokens: 3 }));
  const native = { thread_id: '01a0cf6d-3062-7782-b6c3-c9c43179b7cc', turn_id: '01a0cf6d-a2ba-7b43-b095-f73f45732d30' };
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-papercusp-owner': 'su-native-correlation' },
    body: JSON.stringify({ model: 'gpt-6-sol', input: large ? 'private-input'.repeat(200_000) : 'private-input', stream: true,
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ ...native, secret: NEVER_EMIT_MARKER }) } }),
  });
  expect(response.status).toBe(200); await response.text();
  const { timeline } = await recentTimeline(port);
  expect(timeline).toMatchObject({ ownerId: 'su-native-correlation', nativeCorrelation: {
    status: 'observed', threadId: native.thread_id, turnId: native.turn_id, sessionId: null, windowId: null,
  }, cache: { servingAccountId: 'chatgpt-sub' } });
  const report = await (await fetch(`http://127.0.0.1:${port}/admin/owner-report?owner=su-native-correlation`)).json();
  expect(report.stageTelemetry.recent[0].nativeCorrelation).toEqual(timeline.nativeCorrelation);
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE_METADATA|private-input/);
  expect(JSON.stringify(report)).not.toContain(NEVER_EMIT_MARKER);
});

it('keeps native correlation separate from bearer routing and from each HTTP request identity', async () => {
  const seen: Record<string, unknown>[] = [];
  upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seen.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `resp_fixture_${seen.length}`, output: [],
      usage: { input_tokens: 12, output_tokens: 2, input_tokens_details: { cached_tokens: 2 } } }));
  });
  const upstreamPort = await listen(upstream);
  gateway = createInferenceGateway({ accountId: 'unused-claude', token: async () => 'unused-token',
    upstreamBase: `http://127.0.0.1:${upstreamPort}`, openaiUpstreamBase: `http://127.0.0.1:${upstreamPort}`,
    codexPool: createFailoverPool([{ accountId: 'observed-bearer', token: async () => 'PRIVATE_BEARER' }]),
    concurrency: 2, maxQueueWaitMs: 2_000, requestAbsorbMs: 0 });
  const port = await gateway.listen(0);
  const metadata = { 'x-codex-turn-metadata': JSON.stringify({
    thread_id: '01a0cf6d-3062-7782-b6c3-c9c43179b7cc', turn_id: '01a0cf6d-a2ba-7b43-b095-f73f45732d30',
    servingAccountId: 'forged-account', ownerId: 'forged-owner',
  }) };
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-papercusp-owner': 'su-native-bearer' },
      body: JSON.stringify({ model: 'gpt-6-sol', input: 'private-prompt', client_metadata: metadata }) });
    expect(response.status).toBe(200); await response.text();
  }
  const { stages } = await recentTimeline(port);
  expect(stages.recent).toHaveLength(2);
  expect(stages.recent[0].requestId).not.toBe(stages.recent[1].requestId);
  expect(stages.recent[0].nativeCorrelation).toEqual(stages.recent[1].nativeCorrelation);
  for (const row of stages.recent) {
    expect(row).toMatchObject({ ownerId: 'su-native-bearer',
      nativeCorrelation: { status: 'observed' }, cache: { servingAccountId: 'observed-bearer' } });
    expect(row.upstreamWrites.droppedCalls).toBe(0);
    expect(row.upstreamWrites.calls).toHaveLength(1);
    expect(row.upstreamWrites.calls[0]).toMatchObject({ accountId: 'observed-bearer', outcome: 'returned',
      matchedRequests: 1, unexpectedRequests: 0, droppedRequests: 0, droppedEvents: 0 });
    expect(row.upstreamWrites.calls[0].events.map(event => event.phase))
      .toEqual(['created', 'headers-write-start', 'body-write-complete']);
    const report = await (await fetch(`http://127.0.0.1:${port}/admin/owner-report?owner=su-native-bearer`)).json();
    const reported = report.stageTelemetry.recent.find((entry: { requestId: number }) => entry.requestId === row.requestId);
    expect(reported.upstreamWrites).toEqual(row.upstreamWrites);
  }
  expect(seen.map(body => body.client_metadata)).toEqual([metadata, metadata]);
  expect(JSON.stringify(stages)).not.toMatch(/forged-|PRIVATE_BEARER|private-prompt/);
});

it.each([429, 503])('retains the rejected bearer write and existing failover policy for HTTP %s', async rejectedStatus => {
  const received: string[] = [];
  upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the buffered request */ }
    const auth = String(req.headers.authorization); received.push(auth);
    const failed = auth.includes('token-a');
    res.writeHead(failed ? rejectedStatus : 200, { 'content-type': 'application/json', ...(failed ? { 'retry-after': '3600' } : {}) });
    res.end(JSON.stringify(failed ? { error: { message: 'fixture unavailable' } }
      : { id: 'resp_retry', output: [], usage: { input_tokens: 5, output_tokens: 1 } }));
  });
  const upstreamPort = await listen(upstream);
  gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
    upstreamBase: `http://127.0.0.1:${upstreamPort}`, openaiUpstreamBase: `http://127.0.0.1:${upstreamPort}`,
    codexPool: createFailoverPool([{ accountId: 'account-a', token: async () => 'token-a' },
      { accountId: 'account-b', token: async () => 'token-b' }]),
    concurrency: 2, maxQueueWaitMs: 2_000, requestAbsorbMs: 0, selfHeal: { enabled: false } });
  const port = await gateway.listen(0);
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-owner': 'su-write-retry' },
    body: JSON.stringify({ model: 'gpt-6-sol', input: 'fixture' }) });
  expect(response.status).toBe(rejectedStatus === 429 ? 200 : 503); await response.text();
  const accounts = rejectedStatus === 429 ? ['account-a', 'account-b'] : ['account-a'];
  expect(received).toEqual(accounts.map(account => `Bearer token-${account.at(-1)}`));
  const { timeline } = await recentTimeline(port);
  expect(timeline.cache.servingAccountId).toBe(accounts.at(-1));
  expect(timeline.upstreamWrites.calls.map(call => call.accountId)).toEqual(accounts);
  expect(timeline.upstreamWrites.calls.map(call => call.responseStatus)).toEqual(rejectedStatus === 429 ? [429, 200] : [503]);
  for (const call of timeline.upstreamWrites.calls) {
    expect(call.events.map(event => event.phase)).toEqual(['created', 'headers-write-start', 'body-write-complete']);
    expect(call.matchedRequests).toBe(1);
  }
});

it('observes actual OAuth transport writes through a loopback-only test dispatcher', async () => {
  const logs: string[] = [];
  const home = await mkdtemp(join(tmpdir(), 'gateway-write-oauth-'));
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwt = `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  await writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    access_token: jwt, refresh_token: 'PRIVATE_REFRESH', account_id: 'oauth-account',
  } }));
  let received = 0;
  upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* no provider connection; local fixture only */ }
    received++;
    expect(req.headers['chatgpt-account-id']).toBe('oauth-account');
    expect(req.headers.diagnosticaccountid).toBeUndefined();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_oauth_writes', output: [] } })}\n\ndata: [DONE]\n\n`);
  });
  const upstreamPort = await listen(upstream);
  // Preserve Undici's real target identity and lifecycle while directing its
  // socket strictly to our local HTTP fixture, never the provider host.
  const dispatcher = new Agent({ connect: (_options, callback) => {
    const socket = net.connect(upstreamPort, '127.0.0.1');
    const failed = (error: Error) => callback(error, null);
    socket.once('error', failed);
    socket.once('connect', () => { socket.off('error', failed); callback(null, socket); });
  } });
  try {
    gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
      codexCliAccounts: () => [{ accountId: 'oauth-account', home }], codexOAuthProxy: true,
      log: (_level, message) => { logs.push(message); },
      fetchImpl: ((target, init) => fetch(target, { ...init, dispatcher } as RequestInit)) as typeof fetch,
      concurrency: 2, maxQueueWaitMs: 2_000, requestAbsorbMs: 0, selfHeal: { enabled: false } });
    const port = await gateway.listen(0);
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-papercusp-owner': 'su-write-oauth' },
      body: JSON.stringify({ model: 'gpt-6-sol', input: 'private-prompt', stream: true }) });
    expect(response.status).toBe(200); expect(await response.text()).toContain('resp_oauth_writes');
    expect(received).toBe(1);
    const evidence = logs.filter(message => message.includes('codex OAuth stream-evidence/v1 '))
      .map(message => JSON.parse(message.split('stream-evidence/v1 ')[1]!));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ ownerId: 'su-write-oauth', model: 'gpt-6-sol',
      accountId: 'oauth-account', requestedStream: true, upstreamStatus: 200,
      contentType: 'event-stream', inspected: true, termination: 'done',
      sawResponseEvent: true, sawTerminal: true, terminalType: 'response.completed', pendingFrame: false });
    expect(evidence[0].requestId).toEqual(expect.any(Number));
    expect(evidence[0].bytesRead).toBeGreaterThan(0);
    expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE_|private-prompt|resp_oauth_writes|chatgpt\.com/);
    const { timeline } = await recentTimeline(port);
    expect(timeline.transport).toBe('oauth-http');
    expect(timeline.upstreamWrites.calls).toHaveLength(1);
    expect(timeline.upstreamWrites.calls[0]).toMatchObject({ accountId: 'oauth-account', matchedRequests: 1,
      unexpectedRequests: 0, droppedRequests: 0, droppedEvents: 0, outcome: 'returned' });
    expect(timeline.upstreamWrites.calls[0].events.map(event => event.phase))
      .toEqual(['created', 'headers-write-start', 'body-write-complete']);
    expect(JSON.stringify(timeline)).not.toMatch(/PRIVATE_|private-prompt|chatgpt\.com/);
  } finally {
    await gateway?.close(); gateway = undefined;
    await dispatcher.close();
    await rm(home, { recursive: true, force: true });
  }
});

const trialToken = 'PRIVATE_CONTROLLER_ISSUED_TRIAL_TOKEN';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const trialBinding = (authorizeAttempt: GatewayCarryTrialBinding['authorizeAttempt']): GatewayCarryTrialBinding => ({
  manifestSha256: sha256('frozen unpaid fixture manifest'), armId: 'fixture-control',
  requestTokenSha256: sha256(trialToken), authorizeAttempt,
});
const fixtureReservation = (attempt: GatewayCarryTrialAttempt) => ({
  attemptId: attempt.attemptId, reservationRef: `fixture:${attempt.attemptId}`,
  clockId: attempt.clockId, validUntilMonotonicMs: processMonotonicClock.now() + 5_000,
});

it.each(['bearer', 'anthropic', 'oauth'] as const)(
  'accepted support budget observes the final %s body and refuses an unreserved retry', async protocol => {
    const attempts: GatewayCarryTrialAttempt[] = [], wire: string[] = [];
    upstream = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      wire.push(Buffer.concat(chunks).toString());
      res.writeHead(protocol === 'oauth' ? 200 : 429, { 'content-type': 'application/json', 'retry-after': '3600' });
      res.end(JSON.stringify(protocol === 'oauth'
        ? { id: 'resp_support', model: 'gpt-6-sol', status: 'completed', output: [],
          usage: { input_tokens: 1, output_tokens: 1 } }
        : { error: { message: 'synthetic throttle' } }));
    });
    const up = await listen(upstream);
    const home = protocol === 'oauth' ? await mkdtemp(join(tmpdir(), 'support-budget-oauth-')) : undefined;
    const dispatcher = home ? new Agent({ connect: (_options, callback) => {
      const socket = net.connect(up, '127.0.0.1');
      const failed = (error: Error) => callback(error, null);
      socket.once('error', failed);
      socket.once('connect', () => { socket.off('error', failed); callback(null, socket); });
    } }) : undefined;
    try {
      if (home) {
        const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const token = `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
        await writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
          access_token: token, refresh_token: 'SYNTHETIC_SUPPORT_REFRESH', account_id: 'support-a',
        } }));
      }
      const binding = { ...trialBinding(async attempt => {
        attempts.push(attempt);
        return attempts.length > 1 ? null : fixtureReservation(attempt);
      }), outputTokenLimit: 17 };
      gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
        pool: createFailoverPool([{ accountId: 'support-a', token: async () => 'token-a' },
          { accountId: 'support-b', token: async () => 'token-b' }]),
        ...(protocol === 'oauth' ? {} : { codexPool: createFailoverPool([
          { accountId: 'support-a', token: async () => 'token-a' },
          { accountId: 'support-b', token: async () => 'token-b' }]) }),
        ...(home && dispatcher ? { codexCliAccounts: () => [{ accountId: 'support-a', home }], codexOAuthProxy: true,
          fetchImpl: ((target, init) => fetch(target, { ...init, dispatcher } as RequestInit)) as typeof fetch } : {}),
        upstreamBase: `http://127.0.0.1:${up}`, openaiUpstreamBase: `http://127.0.0.1:${up}`,
        readAcceptedOperationBudgetBinding: async owner => {
          expect(owner).toBe('support-worker'); return binding;
        }, requestAbsorbMs: 0, selfHeal: { enabled: false },
      });
      const port = await gateway.listen(0);
      const send = () => fetch(`http://127.0.0.1:${port}/v1/${protocol === 'anthropic' ? 'messages' : 'responses'}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-papercusp-owner': 'support-worker' },
        body: JSON.stringify(protocol === 'anthropic'
          ? { model: 'claude-opus-4', max_tokens: 900, messages: [{ role: 'user', content: 'synthetic' }] }
          : { model: 'gpt-6-sol', input: 'synthetic', stream: protocol === 'oauth' }),
      });
      const response = await send(); await response.text();
      // OAuth has one selected account; a second request is still a new send
      // and must obtain its own reservation. API-key lanes fail over in-request.
      if (protocol === 'oauth') {
        expect(response.status).toBe(200);
        const retry = await send(); await retry.text(); expect(retry.status).toBe(403);
      } else expect(response.status).toBe(403);
      expect(attempts.length).toBeGreaterThanOrEqual(2);
      expect(wire).toHaveLength(1);
      expect(attempts[0]!.body).toBe(wire[0]);
      expect(attempts[0]!.transport).toBe(protocol === 'oauth' ? 'oauth-http'
        : protocol === 'anthropic' ? 'anthropic-http' : 'bearer-http');
      expect(attempts[0]!.bodySha256).toBe(sha256(wire[0]!));
      const body = JSON.parse(wire[0]!);
      if (protocol === 'oauth') expect(body.max_output_tokens).toBeUndefined();
      else expect(body[protocol === 'anthropic' ? 'max_tokens' : 'max_output_tokens']).toBe(17);
      expect(new Set(attempts.map(a => a.attemptId)).size).toBe(attempts.length);
    } finally {
      await gateway?.close(); gateway = undefined;
      await dispatcher?.close();
      if (home) await rm(home, { recursive: true, force: true });
    }
  });

it.each(['codex', 'anthropic'].flatMap(protocol => ['complete', 'malformed-tail', 'missing-completion'].map(mode => ({ protocol, mode }))))(
  'carry trial observes source-bound provider body closure ($protocol/$mode)', async ({ protocol, mode }) => {
    const headers: GatewayCarryTrialAttemptResult[] = [];
    const closed = vi.fn(async (_result: unknown) => {});
    const provider = { id: 'response-ledger-fixture', model: protocol === 'codex' ? 'gpt-6-sol' : 'claude-opus-4', status: 'completed',
      usage: { input_tokens: 100, output_tokens: 9, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 } } };
    const frames = protocol === 'codex' ? [{ type: 'response.completed', response: provider }] : [
      { type: 'message_start', message: { id: provider.id, type: 'message', model: provider.model, stop_reason: null,
        usage: { input_tokens: 80, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }, { type: 'message_stop' } ];
    const body = mode === 'missing-completion' ? 'data: [DONE]\n\n' :
      frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') +
      (mode === 'malformed-tail' ? 'data: {broken}\n\n' : '');
    gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
      ...(protocol === 'codex' ? { codexPool: createFailoverPool([{ accountId: 'ledger-account', token: async () => 'PRIVATE_PROVIDER_TOKEN' }]) }
        : { pool: createFailoverPool([{ accountId: 'ledger-account', token: async () => 'PRIVATE_PROVIDER_TOKEN' }]) }),
      carryTrial: (protocol === 'codex' ? trialBinding : anthropicTrialBinding)(async attempt => ({ ...fixtureReservation(attempt),
        observeAttemptResult: async result => { headers.push(result); }, observeAttemptCompletion: closed })),
      fetchImpl: (async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch,
      requestAbsorbMs: 0, selfHeal: { enabled: false } });
    const port = await gateway.listen(0);
    const response = protocol === 'anthropic' ? await sendAnthropicTrial(port) : await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${trialToken}` },
      body: JSON.stringify({ model: 'gpt-6-sol', input: 'PRIVATE_TASK', stream: true, client_metadata: {
        'x-codex-turn-metadata': JSON.stringify({ thread_id: '11111111-1111-1111-1111-111111111111',
          turn_id: '22222222-2222-2222-2222-222222222222', private_extra: 'PRIVATE_NOT_RETAINED' }) } }) });
    await response.text().catch(() => '');
    expect(closed).toHaveBeenCalledTimes(1);
    expect(closed.mock.calls[0]![0]).toMatchObject({ ...headers[0],
      outcome: mode === 'complete' ? 'response-completed' : 'response-incomplete',
      responseSha256: createHash('sha256').update(body).digest('hex'), responseBytes: Buffer.byteLength(body),
      costUsdMeasurementMissing: true });
    if (mode === 'complete') expect(closed.mock.calls[0]![0]).toMatchObject({ providerCompletion: {
      responseId: provider.id, model: provider.model, usage: { inputTokens: 100, inputTokenBasis: 'inclusive',
        outputTokens: 9, cacheReadTokens: 20, cacheCreationTokens: 0 } } });
    if (protocol === 'codex') expect(closed.mock.calls[0]![0]).toMatchObject({
      nativeSessionId: '11111111-1111-1111-1111-111111111111', nativeTurnId: '22222222-2222-2222-2222-222222222222' });
    expect(JSON.stringify(closed.mock.calls)).not.toMatch(/PRIVATE_|costUsd"/);
  });

it('host-frozen native output ceiling reaches the selected bearer provider and cannot be widened', async () => {
  const observed: GatewayCarryTrialAttempt[] = [], sent: Record<string, unknown>[] = [];
  const binding = { ...trialBinding(async attempt => {
    observed.push(attempt); return fixtureReservation(attempt);
  }), outputTokenLimit: 40 };
  gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
    codexPool: createFailoverPool([{ accountId: 'final-account', token: async () => 'PRIVATE_PROVIDER_TOKEN' }]),
    carryTrial: binding, requestAbsorbMs: 0, selfHeal: { enabled: false },
    fetchImpl: (async (_url, init) => {
      sent.push(JSON.parse(Buffer.from(init!.body as Uint8Array).toString('utf8')));
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
  });
  binding.outputTokenLimit = 999; // Live mutation cannot widen the captured host policy.
  const port = await gateway.listen(0);
  const send = (limit?: unknown, token = trialToken) => fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, originator: 'codex_cli_rs' },
    body: JSON.stringify({ model: 'gpt-6-sol', input: 'PRIVATE_NATIVE_TASK', ...(limit === undefined ? {} : { max_output_tokens: limit }) }),
  });
  for (const [limit, status] of [[undefined, 200], [11, 200], [41, 400], [0, 400], ['40', 400]] as const) {
    const response = await send(limit); expect(response.status).toBe(status); await response.text();
  }
  const unauthorized = await send(undefined, 'OTHER_CALLER_TOKEN');
  expect(unauthorized.status).toBe(403); await unauthorized.text();
  expect(observed).toHaveLength(2); expect(sent).toHaveLength(2);
  expect(sent.map(body => body.max_output_tokens)).toEqual([40, 11]);
  expect(observed.map(attempt => JSON.parse(attempt.body).max_output_tokens)).toEqual([40, 11]);
  expect(observed.map(attempt => attempt.bodySha256)).toEqual(sent.map(body => sha256(JSON.stringify(body))));
});

it.each([0, -1, 1.5, NaN, Infinity])('refuses invalid host native output ceiling before startup: %s', outputTokenLimit => {
  expect(() => createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
    carryTrial: { ...trialBinding(async attempt => fixtureReservation(attempt)), outputTokenLimit },
  })).toThrow(/carry trial binding/);
});

const anthropicTrialBinding = (authorizeAttempt: GatewayCarryTrialBinding['authorizeAttempt']): GatewayCarryTrialBinding => ({
  ...trialBinding(authorizeAttempt), protocols: ['anthropic-messages'],
});
const anthropicTrialBody = () => JSON.stringify({ model: 'claude-opus-4', max_tokens: 17,
  stream: false, messages: [{ role: 'user', content: 'PRIVATE_NATIVE_TASK' }] });
const sendAnthropicTrial = (port: number, token: string = trialToken, signal?: AbortSignal) =>
  fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: anthropicTrialBody() });

it.each(['anthropic', 'codex'] as const)(
  'carry trial reports exact %s attempt response identity without claiming usage', async protocol => {
    const attempts: GatewayCarryTrialAttempt[] = [], results: GatewayCarryTrialAttemptResult[] = [];
    const changedObserver = vi.fn();
    let issued: { observeAttemptResult: (result: GatewayCarryTrialAttemptResult) => Promise<void> } | undefined;
    let writes = 0;
    const authorize: GatewayCarryTrialBinding['authorizeAttempt'] = async attempt => {
      attempts.push(attempt);
      const receipt = { ...fixtureReservation(attempt), observeAttemptResult: async (result: GatewayCarryTrialAttemptResult) => {
        expect(Object.isFrozen(result)).toBe(true); results.push(result);
      } };
      issued = receipt;
      return receipt;
    };
    gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
      ...(protocol === 'anthropic'
        ? { pool: createFailoverPool([{ accountId: 'final-account', token: async () => 'PRIVATE_PROVIDER_TOKEN' }]) }
        : { codexPool: createFailoverPool([{ accountId: 'final-account', token: async () => 'PRIVATE_PROVIDER_TOKEN' }]) }),
      carryTrial: protocol === 'anthropic' ? anthropicTrialBinding(authorize) : trialBinding(authorize),
      fetchImpl: (async () => { writes++; issued!.observeAttemptResult = changedObserver;
        return new Response('{}', { status: 200 }); }) as typeof fetch,
      requestAbsorbMs: 0, selfHeal: { enabled: false },
    });
    const port = await gateway.listen(0);
    const send = () => fetch(`http://127.0.0.1:${port}/v1/${protocol === 'anthropic' ? 'messages' : 'responses'}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${trialToken}`,
        [MODEL_REQUEST_ID_HEADER]: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:999' },
      body: protocol === 'anthropic' ? anthropicTrialBody() : JSON.stringify({ model: 'gpt-6-sol', input: 'PRIVATE_TASK' }),
    });
    const response = await send();
    expect(response.status).toBe(200); await response.text();
    expect(writes).toBe(1); expect(results).toHaveLength(1); expect(changedObserver).not.toHaveBeenCalled();
    const { body: _privateBody, signal: _signal, ...identity } = attempts[0]!;
    expect(results[0]).toEqual({ ...identity, reservationRef: `fixture:${identity.attemptId}`,
      outcome: 'response-headers', responseStatus: 200, costUsdMeasurementMissing: true });
    expect(isModelRequestId(attempts[0]!.gatewayRequestId)).toBe(true);
    expect(attempts[0]!.gatewayRequestId).toBe(response.headers.get(MODEL_REQUEST_ID_HEADER));
    expect(attempts[0]!.gatewayRequestId).not.toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:999');
    const next = await send(); await next.text();
    expect(next.status).toBe(200);
    expect(attempts[1]!.gatewayRequestId).toBe(next.headers.get(MODEL_REQUEST_ID_HEADER));
    expect(attempts[1]!.gatewayRequestId).not.toBe(attempts[0]!.gatewayRequestId);
    expect(JSON.stringify(results)).not.toMatch(/PRIVATE_|costUsd"/);
  });

it.each(['refused', 'fetch-failed', 'observer-failed'] as const)(
  'carry trial retains the per-attempt disposition for %s', async mode => {
    const results: GatewayCarryTrialAttemptResult[] = [];
    let writes = 0;
    gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
      codexPool: createFailoverPool([{ accountId: 'final-account', token: async () => 'PRIVATE_PROVIDER_TOKEN' }]),
      carryTrial: trialBinding(async attempt => ({ ...fixtureReservation(attempt),
        validateAuthorization: () => { if (mode === 'refused') throw new Error('PRIVATE_REVOCATION'); },
        observeAttemptResult: async result => { results.push(result);
          if (mode === 'observer-failed') throw new Error('PRIVATE_OBSERVER_FAILURE'); },
      })),
      fetchImpl: (async () => { writes++; if (mode === 'fetch-failed') throw new Error('PRIVATE_FETCH_FAILURE');
        return new Response('{}', { status: 200 }); }) as typeof fetch,
      requestAbsorbMs: 0, selfHeal: { enabled: false },
    });
    const port = await gateway.listen(0);
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${trialToken}` },
      body: JSON.stringify({ model: 'gpt-6-sol', input: 'PRIVATE_TASK' }) });
    expect(response.status).not.toBe(200); expect(await response.text()).not.toMatch(/PRIVATE_/);
    expect(writes).toBe(mode === 'refused' ? 0 : 1); expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject(mode === 'refused'
      ? { outcome: 'send-refused', responseStatus: null, costUsd: 0, costUsdMeasurementMissing: false }
      : { outcome: mode === 'fetch-failed' ? 'fetch-failed' : 'response-headers',
        responseStatus: mode === 'fetch-failed' ? null : 200, costUsdMeasurementMissing: true });
    if (mode !== 'refused') expect(results[0]).not.toHaveProperty('costUsd');
  });

it('carry trial reports separate results for each selected-provider failover attempt', async () => {
  const attempts: GatewayCarryTrialAttempt[] = [], results: GatewayCarryTrialAttemptResult[] = [];
  gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
    codexPool: createFailoverPool([{ accountId: 'account-a', token: async () => 'token-a' },
      { accountId: 'account-b', token: async () => 'token-b' }]),
    carryTrial: trialBinding(async attempt => { attempts.push(attempt); return { ...fixtureReservation(attempt),
      observeAttemptResult: async result => { results.push(result); } }; }),
    fetchImpl: (async (_target, init) => new Response('{}', {
      status: new Headers(init?.headers).get('authorization') === 'Bearer token-a' ? 429 : 200,
      headers: { 'content-type': 'application/json', 'retry-after': '3600' },
    })) as typeof fetch,
    requestAbsorbMs: 0, selfHeal: { enabled: false },
  });
  const port = await gateway.listen(0);
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${trialToken}` },
    body: JSON.stringify({ model: 'gpt-6-sol', input: 'PRIVATE_TASK' }) });
  expect(response.status).toBe(200); await response.text();
  expect(attempts.map(a => a.accountId)).toEqual(['account-a', 'account-b']);
  expect(results.map(r => r.attemptId)).toEqual(attempts.map(a => a.attemptId));
  expect(new Set(results.map(r => r.attemptId)).size).toBe(2);
  expect(isModelRequestId(attempts[0]!.gatewayRequestId)).toBe(true);
  expect(attempts.map(a => a.gatewayRequestId)).toEqual([
    response.headers.get(MODEL_REQUEST_ID_HEADER), response.headers.get(MODEL_REQUEST_ID_HEADER),
  ]);
  expect(results.map(r => r.responseStatus)).toEqual([429, 200]);
  for (let i = 0; i < results.length; i++) {
    expect(results[i]).toMatchObject({ credentialSha256: attempts[i]!.credentialSha256,
      bodySha256: attempts[i]!.bodySha256, gatewayRequestId: attempts[i]!.gatewayRequestId,
      reservationRef: `fixture:${attempts[i]!.attemptId}`,
      costUsdMeasurementMissing: true });
    expect(results[i]).not.toHaveProperty('costUsd');
  }
});

it.each(['anthropic', 'codex'] as const)(
  'carry trial validates controller authority at the final %s send', async protocol => {
    let writes = 0, checks = 0;
    upstream = http.createServer((req, res) => { req.resume(); writes++; res.end('{}'); });
    const upstreamPort = await listen(upstream);
    const authorize: GatewayCarryTrialBinding['authorizeAttempt'] = async attempt => ({
      ...fixtureReservation(attempt),
      validateAuthorization: () => {
        checks++;
        expect(attempt.credentialSha256).toBe(sha256('Bearer PRIVATE_PROVIDER_TOKEN'));
        expect(attempt.bodySha256).toBe(sha256(attempt.body));
        expect(writes).toBe(0);
      },
    });
    gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
      ...(protocol === 'anthropic'
        ? { upstreamBase: `http://127.0.0.1:${upstreamPort}`,
          pool: createFailoverPool([{ accountId: 'final-account', token: async () => 'PRIVATE_PROVIDER_TOKEN' }]) }
        : { openaiUpstreamBase: `http://127.0.0.1:${upstreamPort}`,
          codexPool: createFailoverPool([{ accountId: 'final-account', token: async () => 'PRIVATE_PROVIDER_TOKEN' }]) }),
      carryTrial: protocol === 'anthropic' ? anthropicTrialBinding(authorize) : trialBinding(authorize),
      requestAbsorbMs: 0, selfHeal: { enabled: false },
    });
    const port = await gateway.listen(0);
    const response = protocol === 'anthropic' ? await sendAnthropicTrial(port) :
      await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${trialToken}` },
        body: JSON.stringify({ model: 'gpt-6-sol', input: 'PRIVATE_TASK' }) });
    expect(response.status).toBe(200); await response.text();
    expect(checks).toBe(1); expect(writes).toBe(1);
  });

it.each(['anthropic', 'codex'].flatMap(protocol =>
  ['revoked', 'throws', 'async', 'async-reject', 'nonfunction'].map(mode => ({ protocol, mode }))))(
  'carry trial refuses final controller authority for $protocol/$mode', async ({ protocol, mode }) => {
    let writes = 0, checks = 0, revoked = false;
    upstream = http.createServer((req, res) => { req.resume(); writes++; res.end('{}'); });
    const upstreamPort = await listen(upstream);
    const authorize: GatewayCarryTrialBinding['authorizeAttempt'] = async attempt => {
      // Revocation occurs after the issuer returned, before the actual send.
      // A valid receipt alone cannot authorize this later write.
      if (mode === 'revoked') queueMicrotask(() => { revoked = true; });
      return { ...fixtureReservation(attempt), validateAuthorization: (mode === 'nonfunction' ? true : () => {
        checks++;
        if (mode === 'async') return Promise.resolve();
        if (mode === 'async-reject') return Promise.reject(new Error('PRIVATE_ASYNC_AUTHORITY_ERROR'));
        if (mode === 'throws' || revoked) throw new Error('PRIVATE_REVOKED_AUTHORITY');
      }) as never };
    };
    gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
      ...(protocol === 'anthropic'
        ? { upstreamBase: `http://127.0.0.1:${upstreamPort}`,
          pool: createFailoverPool([{ accountId: 'final-account', token: async () => 'PRIVATE_PROVIDER_TOKEN' }]) }
        : { openaiUpstreamBase: `http://127.0.0.1:${upstreamPort}`,
          codexPool: createFailoverPool([{ accountId: 'final-account', token: async () => 'PRIVATE_PROVIDER_TOKEN' }]) }),
      carryTrial: protocol === 'anthropic' ? anthropicTrialBinding(authorize) : trialBinding(authorize),
      requestAbsorbMs: 0, selfHeal: { enabled: false },
    });
    const port = await gateway.listen(0);
    const response = protocol === 'anthropic' ? await sendAnthropicTrial(port) :
      await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${trialToken}` },
        body: JSON.stringify({ model: 'gpt-6-sol', input: 'PRIVATE_TASK' }) });
    expect(response.status).toBe(403);
    expect(response.headers.get('x-should-retry')).toBe('false');
    expect(await response.text()).not.toMatch(/PRIVATE_/);
    expect(writes).toBe(0); expect(checks).toBe(mode === 'nonfunction' ? 0 : 1);
    expect(gateway.stats().upstreamErrors).toBe(0);
  });

it.each([null, [], ['anthropic-messages', 'anthropic-messages'], ['unobserved-protocol'], 'anthropic-messages'])(
  'rejects malformed protocol allowance %j before serving requests', protocols => {
    expect(() => createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
      carryTrial: { ...trialBinding(async attempt => fixtureReservation(attempt)), protocols: protocols as never },
    })).toThrow('invalid carry trial protocols');
  });

it('Anthropic binding authenticates the final API-key account without retaining the binding token', async () => {
  const attempts: GatewayCarryTrialAttempt[] = [];
  let wire: { body: string; authorization: string | undefined; apiKey: string | undefined } | undefined;
  upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    wire = { body: Buffer.concat(chunks).toString(), authorization: req.headers.authorization,
      apiKey: req.headers['x-api-key'] as string | undefined };
    res.setHeader('content-type', 'application/json'); res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  gateway = createInferenceGateway({ upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    pool: createFailoverPool([{ accountId: 'native-api', authMode: 'api-key', token: async () => 'PRIVATE_API_KEY' }]),
    requestAbsorbMs: 0, selfHeal: { enabled: false },
    carryTrial: anthropicTrialBinding(async attempt => { attempts.push(attempt); return fixtureReservation(attempt); }),
  });
  const response = await sendAnthropicTrial(await gateway.listen(0));
  expect(response.status).toBe(200); await response.text();
  expect(wire).toMatchObject({ authorization: undefined, apiKey: 'PRIVATE_API_KEY' });
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({ transport: 'anthropic-http', accountId: 'native-api',
    credentialHeader: 'x-api-key', credentialSha256: sha256('PRIVATE_API_KEY'),
    body: wire!.body, bodySha256: sha256(wire!.body) });
});

it.each((['api-key', 'oauth'] as const).flatMap(authMode => [true, false].map(withBeta => ({ authMode, withBeta }))))(
  'Anthropic binding snapshots final provider headers for $authMode/$withBeta admission', async ({ authMode, withBeta }) => {
  const attempts: GatewayCarryTrialAttempt[] = [];
  const results: GatewayCarryTrialAttemptResult[] = [];
  let wire: { version: string | null; beta: string | null } | undefined;
  upstream = http.createServer((req, res) => {
    req.resume();
    wire = { version: req.headers['anthropic-version'] as string ?? null,
      beta: req.headers['anthropic-beta'] as string ?? null };
    res.setHeader('content-type', 'application/json'); res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  gateway = createInferenceGateway({ upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    pool: createFailoverPool([{ accountId: 'native-account', authMode, token: async () => 'PRIVATE_PROVIDER_TOKEN' }]),
    requestAbsorbMs: 0, selfHeal: { enabled: false },
    carryTrial: anthropicTrialBinding(async attempt => {
      attempts.push(attempt);
      return { ...fixtureReservation(attempt), observeAttemptResult: async result => { results.push(result); } };
    }),
  });
  const port = await gateway.listen(0);
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${trialToken}`,
      ...(withBeta ? { 'anthropic-version': '2023-06-01',
        'anthropic-beta': 'context-1m-2025-08-07,interleaved-thinking-2025-05-14' } : {}) },
    body: anthropicTrialBody() });
  expect(response.status).toBe(200); await response.text();
  expect(attempts).toHaveLength(1);
  const headers = { version: attempts[0].anthropicVersion, beta: attempts[0].anthropicBeta };
  expect(headers).toEqual(wire);
  expect(headers.version).toBe('2023-06-01');
  expect(headers.beta?.includes('context-1m-2025-08-07') ?? false).toBe(withBeta);
  expect(headers.beta?.includes('oauth-2025-04-20') ?? false).toBe(authMode === 'oauth');
  expect(Object.isFrozen(attempts[0])).toBe(true);
  expect(Reflect.set(attempts[0], 'anthropicBeta', 'changed-after-admission')).toBe(false);
  expect(attempts[0].anthropicBeta).toBe(wire!.beta);
  expect(results.length).toBeGreaterThan(0);
  for (const result of results) expect(result).toMatchObject({ anthropicVersion: wire!.version, anthropicBeta: wire!.beta });
  expect(JSON.stringify(headers)).not.toContain('PRIVATE_');
});

it.each(['missing-token', 'wrong-token', 'refused', 'threw', 'expired', 'wrong-clock', 'replayed-receipt', 'empty-ref'] as const)(
  'Anthropic binding prevents the actual pooled HTTP write for %s', async mode => {
    let writes = 0, authorizations = 0;
    upstream = http.createServer((req, res) => { req.resume(); writes++; res.end('{}'); });
    const upstreamPort = await listen(upstream);
    gateway = createInferenceGateway({ upstreamBase: `http://127.0.0.1:${upstreamPort}`,
      pool: createFailoverPool([{ accountId: 'native-account', token: async () => 'PRIVATE_PROVIDER_TOKEN' }]),
      requestAbsorbMs: 0, selfHeal: { enabled: false },
      carryTrial: anthropicTrialBinding(async attempt => {
        authorizations++;
        if (mode === 'threw') throw new Error('PRIVATE_CONTROLLER_ERROR');
        if (mode === 'refused') return null;
        return { ...fixtureReservation(attempt),
          ...(mode === 'expired' ? { validUntilMonotonicMs: 0 } : {}),
          ...(mode === 'wrong-clock' ? { clockId: 'another-process' } : {}),
          ...(mode === 'replayed-receipt' ? { attemptId: 'previous-attempt' } : {}),
          ...(mode === 'empty-ref' ? { reservationRef: ' ' } : {}),
        };
      }),
    });
    const response = await sendAnthropicTrial(await gateway.listen(0),
      mode === 'missing-token' ? '' : mode === 'wrong-token' ? 'wrong' : trialToken);
    expect(response.status).toBe(403);
    expect(response.headers.get('x-should-retry')).toBe('false');
    expect(await response.text()).not.toMatch(/PRIVATE_/);
    expect(writes).toBe(0);
    expect(authorizations).toBe(mode === 'missing-token' || mode === 'wrong-token' ? 0 : 1);
    expect(gateway.stats().upstreamErrors).toBe(0);
  });

it.each([true, false])('Anthropic binding reauthorizes each actual failover send (allow=%s)', async allow => {
  const attempts: GatewayCarryTrialAttempt[] = [], wire: Array<{ body: string; auth: string }> = [];
  upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    wire.push({ body: Buffer.concat(chunks).toString(), auth: String(req.headers.authorization) });
    const failed = wire.length === 1;
    res.writeHead(failed ? 429 : 200, { 'content-type': 'application/json', ...(failed ? { 'retry-after': '3600' } : {}) });
    res.end(JSON.stringify(failed ? { error: { message: 'fixture throttle' } } :
      { id: 'msg_native', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 0 } }));
  });
  const upstreamPort = await listen(upstream);
  gateway = createInferenceGateway({ upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    pool: createFailoverPool([{ accountId: 'native-a', token: async () => 'token-a' },
      { accountId: 'native-b', token: async () => 'token-b' }]),
    requestAbsorbMs: 0, selfHeal: { enabled: false },
    carryTrial: anthropicTrialBinding(async attempt => {
      attempts.push(attempt); return attempts.length === 2 && !allow ? null : fixtureReservation(attempt);
    }),
  });
  const response = await sendAnthropicTrial(await gateway.listen(0));
  expect(response.status).toBe(allow ? 200 : 403); await response.text();
  expect(attempts.map(a => a.accountId)).toEqual(['native-a', 'native-b']);
  expect(new Set(attempts.map(a => a.attemptId)).size).toBe(2);
  expect(wire).toHaveLength(allow ? 2 : 1);
  wire.forEach((request, i) => {
    expect(attempts[i]).toMatchObject({ transport: 'anthropic-http', body: request.body,
      bodySha256: sha256(request.body), credentialSha256: sha256(request.auth) });
    expect(Object.isFrozen(attempts[i])).toBe(true);
    expect(request.auth).not.toContain(trialToken);
  });
  expect(attempts[1]!.credentialSha256).toBe(sha256('Bearer token-b'));
});

it('Anthropic protocol allowance is copied at gateway creation and rejects alternate inference routes', async () => {
  let writes = 0, authorizations = 0;
  const protocols: Array<'anthropic-messages' | 'openai-responses'> = ['anthropic-messages'];
  upstream = http.createServer((req, res) => { req.resume(); writes++; res.end('{}'); });
  const upstreamPort = await listen(upstream);
  const binding = { ...trialBinding(async attempt => { authorizations++; return fixtureReservation(attempt); }), protocols };
  gateway = createInferenceGateway({ upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    pool: createFailoverPool([{ accountId: 'native', token: async () => 'token' }]),
    carryTrial: binding, requestAbsorbMs: 0, selfHeal: { enabled: false } });
  protocols.splice(0, 1, 'openai-responses');
  const port = await gateway.listen(0);
  const response = await sendAnthropicTrial(port);
  expect(response.status).toBe(200); await response.text();
  for (const route of ['/v1/responses', '/v1/chat/completions', '/v1/messages/count_tokens', '/maintenance/summarize']) {
    const denied = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${trialToken}` },
      body: anthropicTrialBody() });
    expect(denied.status).toBe(403); await denied.text();
  }
  expect(writes).toBe(1); expect(authorizations).toBe(1);
});

it('Anthropic binding refuses redirects before an unreserved destination receives data', async () => {
  const paths: string[] = [];
  let authorizations = 0;
  upstream = http.createServer((req, res) => {
    req.resume(); paths.push(req.url!);
    res.writeHead(307, { location: '/unreserved-target' }); res.end();
  });
  const upstreamPort = await listen(upstream);
  gateway = createInferenceGateway({ upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    pool: createFailoverPool([{ accountId: 'native', token: async () => 'token' }]),
    carryTrial: anthropicTrialBinding(async attempt => { authorizations++; return fixtureReservation(attempt); }),
    requestAbsorbMs: 0, selfHeal: { enabled: false } });
  const response = await sendAnthropicTrial(await gateway.listen(0));
  expect(response.status).toBe(502); await response.text();
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.every(path => path === '/v1/messages')).toBe(true);
  expect(authorizations).toBe(paths.length);
});

it('Anthropic binding cannot send after downstream cancellation while admission is pending', async () => {
  let writes = 0;
  let enter!: () => void, release!: () => void, aborted!: () => void, returned!: () => void;
  const entered = new Promise<void>(r => { enter = r; });
  const pendingReservation = new Promise<void>(r => { release = r; });
  const cancelled = new Promise<void>(r => { aborted = r; });
  const completed = new Promise<void>(r => { returned = r; });
  upstream = http.createServer((req, res) => { req.resume(); writes++; res.end('{}'); });
  const upstreamPort = await listen(upstream);
  gateway = createInferenceGateway({ upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    pool: createFailoverPool([{ accountId: 'native', token: async () => 'token' }]),
    carryTrial: anthropicTrialBinding(async attempt => {
      attempt.signal.addEventListener('abort', aborted, { once: true });
      enter(); await pendingReservation; returned(); return fixtureReservation(attempt);
    }), requestAbsorbMs: 0, selfHeal: { enabled: false } });
  const controller = new AbortController();
  const pending = sendAnthropicTrial(await gateway.listen(0), trialToken, controller.signal).catch(() => null);
  try { await entered; controller.abort(); await pending; await cancelled; }
  finally { release(); }
  await completed; await new Promise(resolve => setImmediate(resolve));
  expect(writes).toBe(0);
});

it.each(['missing-token', 'wrong-token', 'refused', 'threw', 'expired', 'wrong-clock', 'replayed-receipt'] as const)(
  'carry trial prevents the first actual HTTP write for %s', async mode => {
    let writes = 0, authorizations = 0;
    upstream = http.createServer((req, res) => { req.resume(); writes++; res.end('{}'); });
    const upstreamPort = await listen(upstream);
    gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
      openaiUpstreamBase: `http://127.0.0.1:${upstreamPort}`,
      codexPool: createFailoverPool([{ accountId: 'actual-account', token: async () => 'PRIVATE_UPSTREAM_TOKEN' },
        { accountId: 'must-not-rotate', token: async () => 'PRIVATE_OTHER_TOKEN' }]),
      requestAbsorbMs: 0, selfHeal: { enabled: false },
      carryTrial: trialBinding(async attempt => {
        authorizations++;
        if (mode === 'threw') throw new Error('PRIVATE_CONTROLLER_ERROR');
        if (mode === 'refused') return null;
        return { ...fixtureReservation(attempt),
          ...(mode === 'expired' ? { validUntilMonotonicMs: 0 } : {}),
          ...(mode === 'wrong-clock' ? { clockId: 'another-process' } : {}),
          ...(mode === 'replayed-receipt' ? { attemptId: 'previous-attempt' } : {}),
        };
      }),
    });
    const port = await gateway.listen(0);
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-papercusp-owner': 'forged-owner',
        ...(mode === 'missing-token' ? {} : { authorization: `Bearer ${mode === 'wrong-token' ? 'wrong' : trialToken}` }) },
      body: JSON.stringify({ model: 'gpt-6-sol', input: 'PRIVATE_TASK',
        client_metadata: { armId: 'fixture-control', dispatchAuthorized: true } }) });
    expect(response.status).toBe(403);
    expect(response.headers.get('x-should-retry')).toBe('false');
    expect(await response.text()).not.toMatch(/PRIVATE_|forged-owner/);
    expect(writes).toBe(0);
    expect(authorizations).toBe(mode === 'missing-token' || mode === 'wrong-token' ? 0 : 1);
  });

it.each([true, false])('carry trial reauthorizes the final shaped bearer request on failover (allow=%s)', async allow => {
  const attempts: GatewayCarryTrialAttempt[] = [], wire: Array<{ body: string; auth: string }> = [];
  upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    wire.push({ body: Buffer.concat(chunks).toString(), auth: String(req.headers.authorization) });
    const failed = wire.length === 1;
    res.writeHead(failed ? 429 : 200, { 'content-type': 'application/json', ...(failed ? { 'retry-after': '3600' } : {}) });
    res.end(JSON.stringify(failed ? { error: { message: 'fixture throttle' } } : { id: 'resp_trial', output: [] }));
  });
  const upstreamPort = await listen(upstream);
  gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
    openaiUpstreamBase: `http://127.0.0.1:${upstreamPort}`,
    codexPool: createFailoverPool([{ accountId: 'account-a', token: async () => 'token-a' },
      { accountId: 'account-b', token: async () => 'token-b' }]),
    requestAbsorbMs: 0, selfHeal: { enabled: false },
    carryTrial: trialBinding(async attempt => {
      attempts.push(attempt);
      return attempts.length === 2 && !allow ? null : fixtureReservation(attempt);
    }),
  });
  const port = await gateway.listen(0);
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${trialToken}` },
    body: JSON.stringify({ model: 'gpt-6-sol', input: 'fixture', max_output_tokens: 17 }) });
  expect(response.status).toBe(allow ? 200 : 403); await response.text();
  expect(attempts.map(a => a.accountId)).toEqual(['account-a', 'account-b']);
  expect(new Set(attempts.map(a => a.attemptId)).size).toBe(2);
  expect(wire).toHaveLength(allow ? 2 : 1);
  wire.forEach((request, i) => {
    expect(attempts[i]).toMatchObject({ transport: 'bearer-http', body: request.body,
      bodySha256: sha256(request.body), credentialSha256: sha256(request.auth) });
    expect(request.auth).not.toContain(trialToken);
  });
  expect(attempts[1]!.credentialSha256).toBe(sha256('Bearer token-b'));
});

it('carry trial refuses alternate inference routes and unobserved cli-exec', async () => {
  let executed = false, authorized = false;
  gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
    codexCliAccounts: () => [{ accountId: 'fixture-cli', home: '/tmp/unused-trial-home' }],
    codexOAuthProxy: false,
    codexCliRun: async () => { executed = true; return { text: 'unexpected', inputTokens: 1, outputTokens: 1 }; },
    carryTrial: trialBinding(async attempt => { authorized = true; return fixtureReservation(attempt); }),
    requestAbsorbMs: 0, selfHeal: { enabled: false },
  });
  const port = await gateway.listen(0);
  for (const route of ['/v1/responses', '/v1/messages', '/v1/chat/completions', '/maintenance/summarize']) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${trialToken}` },
      body: JSON.stringify({ model: 'gpt-6-sol', input: 'fixture' }) });
    expect(response.status).toBe(403); await response.text();
  }
  expect(executed).toBe(false); expect(authorized).toBe(false);
});

it('carry trial cannot send after cancellation while reservation is pending', async () => {
  let writes = 0;
  let finishReservation!: () => void;
  let entered!: () => void;
  const authorized = new Promise<void>(resolve => { entered = resolve; });
  const reservationWait = new Promise<void>(resolve => { finishReservation = resolve; });
  let reservationReturned!: () => void;
  const completed = new Promise<void>(resolve => { reservationReturned = resolve; });
  let aborted!: () => void;
  const signalAborted = new Promise<void>(resolve => { aborted = resolve; });
  let observedAbort = false;
  upstream = http.createServer((req, res) => { req.resume(); writes++; res.end('{}'); });
  const upstreamPort = await listen(upstream);
  gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
    openaiUpstreamBase: `http://127.0.0.1:${upstreamPort}`,
    codexPool: createFailoverPool([{ accountId: 'account', token: async () => 'token' }]),
    requestAbsorbMs: 0, selfHeal: { enabled: false },
    carryTrial: trialBinding(async attempt => {
      attempt.signal.addEventListener('abort', aborted, { once: true });
      entered(); await reservationWait;
      observedAbort = attempt.signal.aborted;
      reservationReturned(); return fixtureReservation(attempt);
    }),
  });
  const port = await gateway.listen(0);
  const controller = new AbortController();
  const pending = fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', signal: controller.signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${trialToken}` },
    body: JSON.stringify({ model: 'gpt-6-sol', input: 'fixture' }) }).catch(() => null);
  await authorized; controller.abort(); await pending;
  await signalAborted;
  finishReservation(); await completed;
  // Drain the authorization continuation, including its final synchronous send check.
  await new Promise(resolve => setImmediate(resolve));
  expect(observedAbort).toBe(true); expect(writes).toBe(0);
});

it('carry trial refuses an HTTP redirect before it can create an unreserved send', async () => {
  const paths: string[] = [];
  let authorizations = 0;
  upstream = http.createServer((req, res) => {
    req.resume(); paths.push(req.url!);
    if (req.url === '/v1/responses') {
      res.writeHead(307, { location: '/unreserved-target' }); res.end();
    } else res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
    openaiUpstreamBase: `http://127.0.0.1:${upstreamPort}`,
    codexPool: createFailoverPool([{ accountId: 'account', token: async () => 'token' }]),
    carryTrial: trialBinding(async attempt => { authorizations++; return fixtureReservation(attempt); }),
    requestAbsorbMs: 0, selfHeal: { enabled: false },
  });
  const port = await gateway.listen(0);
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${trialToken}` },
    body: JSON.stringify({ model: 'gpt-6-sol', input: 'fixture' }) });
  expect(response.status).toBe(502); await response.text();
  expect(paths).toEqual(['/v1/responses']); expect(authorizations).toBe(1);
});

it('carry trial reauthorizes an OAuth token-refresh retry before a second inference send', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gateway-trial-oauth-'));
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwt = `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  const refreshed = jwt.replace('.sig', '.refreshed');
  await writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    access_token: jwt, refresh_token: 'PRIVATE_REFRESH', account_id: 'trial-oauth',
  } }));
  const attempts: GatewayCarryTrialAttempt[] = [];
  const results: GatewayCarryTrialAttemptResult[] = [];
  let inferenceWrites = 0, refreshWrites = 0;
  upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* exclusively local fixture */ }
    if (req.url === '/oauth/token') {
      refreshWrites++; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access_token: refreshed, refresh_token: 'PRIVATE_REFRESH' }));
    } else {
      inferenceWrites++; res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture token expired' } }));
    }
  });
  const upstreamPort = await listen(upstream);
  const dispatcher = new Agent({ connect: (_options, callback) => {
    const socket = net.connect(upstreamPort, '127.0.0.1');
    const failed = (error: Error) => callback(error, null);
    socket.once('error', failed);
    socket.once('connect', () => { socket.off('error', failed); callback(null, socket); });
  } });
  try {
    gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
      codexCliAccounts: () => [{ accountId: 'trial-oauth', home }], codexOAuthProxy: true,
      fetchImpl: ((target, init) => fetch(target, { ...init, dispatcher } as RequestInit)) as typeof fetch,
      carryTrial: trialBinding(async attempt => {
        attempts.push(attempt); return attempts.length === 1 ? { ...fixtureReservation(attempt),
          observeAttemptResult: async result => { results.push(result); } } : null;
      }),
      requestAbsorbMs: 0, selfHeal: { enabled: false },
    });
    const port = await gateway.listen(0);
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${trialToken}` },
      body: JSON.stringify({ model: 'gpt-6-sol', input: 'fixture', stream: true }) });
    expect(response.status).toBe(403); await response.text();
    expect(inferenceWrites).toBe(1); expect(refreshWrites).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ attemptId: attempts[0]!.attemptId, transport: 'oauth-http',
      credentialSha256: sha256(`Bearer ${jwt}`), bodySha256: attempts[0]!.bodySha256,
      responseStatus: 401, outcome: 'response-headers', costUsdMeasurementMissing: true });
    expect(results[0]).not.toHaveProperty('costUsd');
    expect(attempts.map(a => a.accountId)).toEqual(['trial-oauth', 'trial-oauth']);
    expect(attempts.map(a => a.transport)).toEqual(['oauth-http', 'oauth-http']);
    expect(attempts.map(a => a.credentialSha256)).toEqual([sha256(`Bearer ${jwt}`), sha256(`Bearer ${refreshed}`)]);
    expect(attempts[0]!.attemptId).not.toBe(attempts[1]!.attemptId);
  } finally {
    await gateway?.close(); gateway = undefined;
    await dispatcher.close(); await rm(home, { recursive: true, force: true });
  }
});

it('records a stream:true cli-exec request as STREAMING, with a real stream stage', async () => {
  resetGovernorRegistry();
  const port = await bootCliBridge(async () => ({ text: 'BRIDGED', inputTokens: 7, outputTokens: 3 }));
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.4', input: 'hello', stream: true }),
  });
  expect(response.status).toBe(200);
  const wire = await response.text();
  // Precondition: this really was served as SSE. Without it the assertions below could pass
  // for a request that never streamed at all, which is the opposite bug.
  expect(wire).toMatch(/event: response\.completed\n/);

  const { stages, timeline } = await recentTimeline(port);
  expect(timeline).toMatchObject({ transport: 'cli-exec', outcome: 'ok', streaming: true });
  // The stage the `streaming` flag arms. Before the fix this was 0 on every gateway-routed
  // Codex agent request, and `missingStages` stayed empty because nothing required it.
  expect(stages.stages.stream.count).toBe(1);
  expect(timeline.missingStages).toEqual([]);
});

it('leaves a NON-streaming cli-exec request non-streaming (the flag tracks the body, not the handler)', async () => {
  resetGovernorRegistry();
  const port = await bootCliBridge(async () => ({ text: 'BUFFERED', inputTokens: 1, outputTokens: 1 }));
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.4', input: 'hello' }),
  });
  expect(response.status).toBe(200);
  await response.arrayBuffer();

  const { stages, timeline } = await recentTimeline(port);
  expect(timeline).toMatchObject({ transport: 'cli-exec', outcome: 'ok', streaming: false });
  expect(stages.stages.stream.count).toBe(0);
  // A non-streaming request has no stream stage BY CONSTRUCTION, so requiring one would make
  // the guard above fire on every buffered call and be turned off again.
  expect(timeline.missingStages).toEqual([]);
});

it('does NOT finalize a post-200 cli-exec SSE failure as ok', async () => {
  resetGovernorRegistry();
  // `stream:true` commits the 200 (and the SSE headers) BEFORE the nested CLI run, so a run that
  // then fails can only report in-band. `classifyGatewayTelemetryOutcome` reads res.statusCode,
  // which is that committed 200 — so this request was finalized `ok` while the client received
  // nothing but `event: error`. That is the same records-success-from-a-partial-signal shape the
  // bridge's own `codexCliResponsesBody` comment documents, one layer up.
  const port = await bootCliBridge(async () => {
    throw new Error('codex exited 1: auth expired');
  });
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.4', input: 'hello', stream: true }),
  });
  expect(response.status).toBe(200); // already committed — this is the trap, not the bug
  const wire = await response.text();
  expect(wire).toMatch(/event: error\n/);
  expect(wire).toMatch(/codex-cli bridge failed/);

  const { stages, timeline } = await recentTimeline(port);
  expect(timeline.outcome).toBe('gateway-error');
  expect(timeline.streaming).toBe(true);
  expect(stages.outcomes.ok).toBe(0);
});
