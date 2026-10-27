/**
 * llmCall error-path: the un-governed CLI path yields `{ type:'error',
 * message:'<backend> exited 1', stderr }` with NO classified turn — the thrown
 * LlmCallError must carry the stderr tail, not just the bare exit line
 * (a bare `claude-code exited 1` is undiagnosable; su-S11's first scored run
 * died exactly this opaquely, coord-system-e2e-testing-2026-06-10 P-011).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StatelessRequestAttempt } from '../../agent-chat-stream';

import { isLlmCallError } from '@papercusp/testing-shell/llm';

const events: unknown[] = [];
const modelExpectations = vi.hoisted(() => ({ mark: vi.fn() }));
vi.mock('../../observability/runtime', () => ({ expectSuccessfulToolModelTrace: modelExpectations.mark }));
const diagnostics: Array<Record<string, unknown>> = [];
let streamFailure: Error | undefined;
// EI-315: captures the opts of the LAST runAgentChat call so a test can assert on the
// priority label threaded through (the anthropic-direct path has no HTTP layer to spy
// on the way the codex-gateway test spies on `fetch`).
let lastRunAgentChatOpts: Record<string, unknown> | undefined;

vi.mock('../../agent-chat-stream', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../agent-chat-stream')>();
  return {
    ...orig,
    runAgentChat: async function* (opts: Record<string, unknown>) {
      lastRunAgentChatOpts = opts;
      for (const diagnostic of diagnostics) {
        (opts.onTransportDiagnostic as ((value: unknown) => void) | undefined)?.(diagnostic);
      }
      yield* events as never[];
      if (streamFailure) throw streamFailure;
    },
  };
});

// These assertions pin the DEFAULT (no explicit-override) backend routing, which
// `backendForLlmCall` derives from `process.env.LLM_TEST_BACKEND` captured at
// llm-client module-init (the module-level `TEST_BACKEND` const). operator-core's
// vitest fork pool reuses a worker across test files, and several gym/ab-run CLI
// entry modules set `LLM_TEST_BACKEND='claude-code'` at module load — so whichever
// sibling file ran first could leak that value into this worker and flip
// `backendForLlmCall` to 'claude-code', reddening these pure routing tests
// ORDER-DEPENDENTLY (the operator-core "flaky gate" class; green-checkpoint
// 2026-07-02). Deleting the env BEFORE the first dynamic import makes llm-client
// capture a clean `TEST_BACKEND`. vitest isolates the module registry per file, so
// no `vi.resetModules()` is needed here — and it WOULD duplicate
// `@papercusp/testing-shell/llm`, breaking the `LlmCallError` class identity the
// subprocess tests below assert via `isLlmCallError` (instanceof).
let savedLlmTestBackend: string | undefined;
beforeAll(() => {
  savedLlmTestBackend = process.env.LLM_TEST_BACKEND;
  delete process.env.LLM_TEST_BACKEND;
});
afterAll(() => {
  if (savedLlmTestBackend === undefined) delete process.env.LLM_TEST_BACKEND;
  else process.env.LLM_TEST_BACKEND = savedLlmTestBackend;
});

describe('llmCall backend selection', () => {
  it('forwards a copied per-call gateway through the Anthropic transport', async () => {
    const { llmCall } = await import('../llm-client');
    const statelessGateway = { baseURL: 'http://127.0.0.1:32123', token: 'cycle-fixture' };
    events.splice(0, events.length, { type: 'result', finalText: 'scoped', tokensIn: 1, tokensOut: 1, costUsd: 0.1 });
    try {
      await llmCall({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'fixture' }], statelessGateway });
      expect(lastRunAgentChatOpts?.statelessGateway).toEqual(statelessGateway);
      expect(lastRunAgentChatOpts?.statelessGateway).not.toBe(statelessGateway);
      expect(Object.isFrozen(lastRunAgentChatOpts?.statelessGateway)).toBe(true);
    } finally { events.length = 0; }
  });

  it.each([
    { baseURL: 'https://example.invalid', token: 'fixture' },
    { baseURL: 'file:///tmp/fixture', token: 'fixture' },
    { baseURL: 'http://user:private@127.0.0.1:32123', token: 'fixture' },
    { baseURL: 'http://127.0.0.1:32123?private=token', token: 'fixture' },
    { baseURL: 'http://127.0.0.1:32123#private', token: 'fixture' },
    { baseURL: 'http://127.0.0.1:32123', token: '' },
    { baseURL: 'http://127.0.0.1:32123', token: 'private\nheader' },
  ])('refuses an invalid per-call gateway before Codex sends', async statelessGateway => {
    const { llmCall } = await import('../llm-client');
    const send = vi.fn(); vi.stubGlobal('fetch', send);
    try {
      await expect(llmCall({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'fixture' }],
        statelessGateway })).rejects.toMatchObject({ message: 'Invalid stateless gateway binding', costUsd: 0 });
      expect(send).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('isolates concurrent Codex gateways and snapshots route/token before authorization', async () => {
    const { llmCall } = await import('../llm-client');
    const received: Array<{ arm: number; url: string; authorization: string | undefined; body: string }> = [];
    const servers = [0, 1].map(arm => createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received.push({ arm, url: req.url!, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ output_text: 'arm-' + arm, usage: { input_tokens: 1, output_tokens: 1 } }));
    }));
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))));
    const gateways = servers.map((server, arm) => ({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/cycle-${arm}`,
      token: 'private-arm-' + arm }));
    const allowed = gateways.map(gateway => gateway.baseURL + '/');
    const savedEnv = { port: process.env.PAPERCUSP_GATEWAY_PORT, url: process.env.PAPERCUSP_ANTHROPIC_URL };
    const originalFetch = globalThis.fetch;
    // An ignored binding must never reach the shared gateway, including in the failing baseline.
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!allowed.some(prefix => url.startsWith(prefix))) return Promise.resolve(new Response(JSON.stringify({
        output_text: 'wrong-route', usage: { input_tokens: 1, output_tokens: 1 },
      })));
      return originalFetch(input, init);
    });
    const attempts: StatelessRequestAttempt[] = [];
    try {
      const results = await Promise.all(gateways.map((gateway, arm) => llmCall({ model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'arm-' + arm }], maxTokens: 8, requireOutputTokenLimit: true,
        statelessGateway: gateway, authorizeStatelessRequest: async attempt => {
          attempts.push(attempt); gateway.token = 'mutated'; gateway.baseURL = 'http://127.0.0.1:1'; return () => {};
        } })));
      expect(results.map(result => result.text)).toEqual(['arm-0', 'arm-1']);
      expect(received.sort((a, b) => a.arm - b.arm).map(value => [value.arm, value.url, value.authorization]))
        .toEqual([[0, '/cycle-0/v1/responses', 'Bearer private-arm-0'], [1, '/cycle-1/v1/responses', 'Bearer private-arm-1']]);
      for (const value of received) {
        const attempt = attempts.find(candidate => JSON.parse(candidate.body).input === 'arm-' + value.arm)!;
        expect(value.body).toBe(attempt.body);
        expect(attempt.credentialSha256).toBe(createHash('sha256').update(JSON.stringify({
          authorization: 'Bearer private-arm-' + value.arm, apiKey: null,
        })).digest('hex'));
      }
      expect({ port: process.env.PAPERCUSP_GATEWAY_PORT, url: process.env.PAPERCUSP_ANTHROPIC_URL }).toEqual(savedEnv);
    } finally {
      vi.unstubAllGlobals();
      await Promise.all(servers.map(server => {
        server.closeAllConnections();
        return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }));
    }
  });

  it('forwards trusted-host stateless authorization without changing the frozen judge policy', async () => {
    const { llmCall } = await import('../llm-client');
    const authorizeStatelessRequest = vi.fn(async () => () => {});
    events.splice(0, events.length, { type: 'result', finalText: 'authorized', tokensIn: 1, tokensOut: 1, costUsd: 0.1 });
    try {
      await llmCall({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'fixture' }],
        maxTokens: 2048, thinkingBudgetTokens: 1024, authorizeStatelessRequest });
      expect(lastRunAgentChatOpts).toMatchObject({ authorizeStatelessRequest, model: 'claude-opus-4-8',
        maxTokens: 2048, thinkingBudgetTokens: 1024 });
    } finally { events.length = 0; }
  });

  it('authorizes the exact Codex request and retains the dispatcher after caller mutation', async () => {
    const { llmCall } = await import('../llm-client');
    const attempts: StatelessRequestAttempt[] = [];
    const request = { model: 'gpt-6.1-sol', messages: [{ role: 'user' as const, content: 'fixture' }],
      system: 'frozen system', maxTokens: 8, requireOutputTokenLimit: true,
      authorizeStatelessRequest: async (attempt: StatelessRequestAttempt) => {
        attempts.push(attempt);
        request.messages[0]!.content = 'mutated'; request.model = 'changed'; request.maxTokens = 999;
        return () => {};
      } };
    const send = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBeInstanceOf(Request);
      const sent = input as Request;
      expect(await sent.clone().text()).toBe(attempts[0]!.body);
      expect(sent.redirect).toBe('error');
      expect((init as RequestInit & { dispatcher?: unknown }).dispatcher).toBeDefined();
      return new Response(JSON.stringify({ output_text: 'authorized', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    vi.stubGlobal('fetch', send);
    try {
      await expect(llmCall(request)).resolves.toMatchObject({ text: 'authorized' });
      expect(send).toHaveBeenCalledTimes(1);
      expect(attempts).toHaveLength(1);
      expect(Object.isFrozen(attempts[0])).toBe(true);
      expect(JSON.parse(attempts[0]!.body)).toMatchObject({ model: 'gpt-6.1-sol', input: 'fixture',
        instructions: 'frozen system', max_output_tokens: 8 });
      expect(attempts[0]!.bodySha256).toBe(createHash('sha256').update(attempts[0]!.body).digest('hex'));
      expect(attempts[0]!.credentialSha256).toBe(createHash('sha256').update(JSON.stringify({
        authorization: 'Bearer papercusp-gateway', apiKey: null,
      })).digest('hex'));
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['missing', 'throw', 'aborted', 'revoked', 'async-validator'] as const)(
    'refuses %s Codex authorization before any gateway send', async kind => {
      const { llmCall } = await import('../llm-client');
      const controller = new AbortController();
      const send = vi.fn(); vi.stubGlobal('fetch', send);
      try {
        await expect(llmCall({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'fixture' }],
          signal: controller.signal,
          authorizeStatelessRequest: async () => {
            if (kind === 'missing') return null;
            if (kind === 'throw') throw new Error('private controller failure');
            if (kind === 'aborted') controller.abort();
            if (kind === 'async-validator') return (async () => {}) as never;
            return () => { if (kind === 'revoked') throw new Error('private revoked grant'); };
          } })).rejects.toMatchObject({ message: 'Stateless request authorization refused', costUsd: 0 });
        expect(send).not.toHaveBeenCalled();
      } finally { vi.unstubAllGlobals(); }
    });

  it('sends only authorized bytes to a private Codex HTTP fixture', async () => {
    const { llmCall } = await import('../llm-client');
    const received: string[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received.push(Buffer.concat(chunks).toString('utf8'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ output_text: 'private fixture', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    const savedPort = process.env.PAPERCUSP_GATEWAY_PORT;
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.PAPERCUSP_GATEWAY_PORT = String((server.address() as AddressInfo).port);
    let authorizedBody: string | undefined;
    try {
      await expect(llmCall({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'isolated fixture' }],
        maxTokens: 8, requireOutputTokenLimit: true,
        authorizeStatelessRequest: async attempt => { authorizedBody = attempt.body; return () => {}; },
      })).resolves.toMatchObject({ text: 'private fixture' });
      await expect(llmCall({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'refused fixture' }],
        authorizeStatelessRequest: async () => null,
      })).rejects.toMatchObject({ costUsd: 0 });
      expect(received).toEqual([authorizedBody]);
    } finally {
      if (savedPort === undefined) delete process.env.PAPERCUSP_GATEWAY_PORT;
      else process.env.PAPERCUSP_GATEWAY_PORT = savedPort;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('threads a required output limit without changing the model or output bound', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-papercusp-require-output-token-limit')).toBe('true');
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-6.1-sol', max_output_tokens: 8 });
      return new Response(JSON.stringify({ output_text: 'bounded', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { llmCall } = await import('../llm-client');
      expect(await llmCall({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'fixture' }],
        maxTokens: 8, requireOutputTokenLimit: true })).toMatchObject({ text: 'bounded' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([undefined, 0, -1, 1.5, Infinity, NaN])('refuses invalid required maxTokens=%s locally', async maxTokens => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    try {
      const { llmCall } = await import('../llm-client');
      await expect(llmCall({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'fixture' }],
        maxTokens, requireOutputTokenLimit: true })).rejects.toMatchObject({ costUsd: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('preserves known-zero spend for a gateway refusal, without fabricating zero on other failures', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ gateway: true,
      error: { code: 'output_token_limit_unsupported', message: 'Selected transport cannot enforce the required output token limit' } }), { status: 422 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { llmCall } = await import('../llm-client');
      const opts = { model: 'gpt-6.1-sol', messages: [{ role: 'user' as const, content: 'fixture' }],
        maxTokens: 8, requireOutputTokenLimit: true };
      await expect(llmCall(opts)).rejects.toMatchObject({ costUsd: 0, turn: { retryable: false } });
      fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: { message: 'upstream failed after possible spend' } }), { status: 500 }));
      const error = await llmCall(opts).catch(e => e);
      expect(error).not.toHaveProperty('costUsd');
    } finally { vi.unstubAllGlobals(); }
  });

  it('threads a required Anthropic output limit and preserves the frozen judge policy', async () => {
    const { llmCall } = await import('../llm-client');
    lastRunAgentChatOpts = undefined;
    events.splice(0, events.length, { type: 'result', finalText: 'bounded', tokensIn: 1, tokensOut: 1, costUsd: 0.1 });
    try {
      await expect(llmCall({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'fixture' }],
        maxTokens: 2048, thinkingBudgetTokens: 1024, temperature: 0, requireOutputTokenLimit: true }))
        .resolves.toMatchObject({ text: 'bounded', costUsd: 0.1 });
      expect(lastRunAgentChatOpts).toMatchObject({ backend: 'anthropic-direct', model: 'claude-opus-4-8',
        maxTokens: 2048, thinkingBudgetTokens: 1024, temperature: 0, requireOutputTokenLimit: true });
    } finally { events.length = 0; }
  });
  it('routes OpenAI-family model ids to Codex even when a stale backend override is set', async () => {
    const { backendForLlmCall, modelForLlmCall } = await import('../llm-client');

    expect(backendForLlmCall('chatgpt:5.5')).toBe('codex');
    expect(backendForLlmCall('gpt-5.5')).toBe('codex');
    expect(backendForLlmCall('openai-codex/gpt-5.5')).toBe('codex');
    expect(backendForLlmCall('claude-sonnet-4-6')).toBe('anthropic-direct');
    expect(backendForLlmCall('chatgpt:5.5', 'anthropic-direct')).toBe('codex');

    expect(modelForLlmCall('chatgpt:5.5', 'codex')).toBe('gpt-5.5');
    expect(modelForLlmCall('openai-codex/gpt-5.5', 'codex')).toBe('gpt-5.5');
    expect(modelForLlmCall('gpt-5.5', 'codex')).toBe('gpt-5.5');
    expect(modelForLlmCall('chatgpt:5.5', 'anthropic-direct')).toBe('chatgpt:5.5');
  });

  it('retains each successful response identity and never records a failed model request', async () => {
    modelExpectations.mark.mockClear();
    const ids = [1, 2].map(n => `11111111-1111-4111-8111-111111111111:${n}`);
    const fetchMock = vi.fn();
    for (const id of ids) fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ output_text: 'ok',
      usage: { input_tokens: 1, output_tokens: 1 } }),
      { status: 200, headers: { 'x-papercusp-model-request-id': id } }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'failed' } }), { status: 500 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ output_text: 'legacy',
      usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { llmCall } = await import('../llm-client');
      const opts = { model: 'chatgpt:5.5', messages: [{ role: 'user' as const, content: 'fixture' }] };
      await llmCall(opts); await llmCall(opts);
      await expect(llmCall(opts)).rejects.toBeDefined();
      expect(modelExpectations.mark.mock.calls).toEqual(ids.map(id => [id]));
      await llmCall(opts);
      // Missing identity remains observable so the trusted writer marks the
      // expectation incomplete instead of silently assuming no model ran.
      expect(modelExpectations.mark.mock.calls).toEqual([...ids.map(id => [id]), [null]]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('uses the local Codex gateway for OpenAI-family stateless calls', async () => {
    modelExpectations.mark.mockClear();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('gpt-5.5');
      expect(body.input).toBe('give json');
      expect(body.instructions).toBe('system');
      expect(body.text).toEqual({ format: { type: 'json_object' } });
      return new Response(
        JSON.stringify({
          output_text: '{"ok":true}',
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json',
          'x-papercusp-model-request-id': '11111111-1111-4111-8111-111111111111:1' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { llmCall } = await import('../llm-client');

    const res = await llmCall({
      system: 'system',
      messages: [{ role: 'user', content: 'give json' }],
      model: 'chatgpt:5.5',
      maxTokens: 8,
      responseFormat: 'json',
      ownerId: 'system:work-item-admission-bulk-dedup:run-1',
    });
    expect(modelExpectations.mark).toHaveBeenCalledOnce();
    expect(modelExpectations.mark).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111:1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8788/v1/responses',
      expect.objectContaining({
        method: 'POST',
        // OAuth non-stream aggregation intentionally emits no downstream headers
        // until response.completed, so this call must opt out of Undici's default
        // five-minute header cap via loopbackFetch's long-running dispatcher.
        dispatcher: expect.anything(),
        headers: expect.objectContaining({
          authorization: 'Bearer papercusp-gateway',
          'x-papercusp-priority': 'llm-testing',
          'x-papercusp-owner': 'system:work-item-admission-bulk-dedup:run-1',
        }),
      }),
    );
    expect(res.text).toBe('{"ok":true}');
    expect(res.json).toEqual({ ok: true });
    expect(res.inputTokens).toBe(10);
    expect(res.outputTokens).toBe(4);
    expect(res.costUsd).toBeGreaterThan(0);
    // Vite worker evaluation supplies no native original-load receipt. The
    // transport must retain unknown code identity even though source exists.
    expect(res.execution).toMatchObject({ codeHash: null, loadedCode: { llmClient: null } });

    vi.unstubAllGlobals();
  });

  it('makes the Codex JSON-mode input itself JSON-explicit even when only instructions mention JSON', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.instructions).toContain('JSON');
      expect(body.input).toBe('generate one idea\n\nRespond with valid json.');
      expect(body.text).toEqual({ format: { type: 'json_object' } });
      return new Response(JSON.stringify({ output_text: '{"ok":true}', usage: { input_tokens: 10, output_tokens: 4 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { llmCall } = await import('../llm-client');

    await llmCall({
      system: 'Return JSON only.',
      messages: [{ role: 'user', content: 'generate one idea' }],
      model: 'chatgpt:5.5',
      responseFormat: 'json',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it.each([
    { model: 'gpt-5.6-sol', temperature: 0 },
    { model: 'gpt-5.6-sol', temperature: 0.4 },
    { model: 'gpt-6-astra', temperature: 0.4 },
  ])('completes $model calls when the caller supplies temperature=$temperature', async ({ model, temperature }) => {
    // Reproduce the gateway refusal that stopped the live SU canary before
    // its first turn (WI-2144435), rather than accepting any request body.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (Object.hasOwn(body, 'temperature')) {
        return new Response(JSON.stringify({ error: { message: 'Unsupported parameter: temperature' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      expect(body).toMatchObject({ model, instructions: 'Return JSON.', text: { format: { type: 'json_object' } } });
      return new Response(JSON.stringify({ output_text: '{"ok":true}', usage: { input_tokens: 10, output_tokens: 4 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { llmCall } = await import('../llm-client');
      const result = await llmCall({
        model,
        temperature,
        system: 'Return JSON.',
        messages: [{ role: 'user', content: 'give json' }],
        responseFormat: 'json',
      });
      expect(result.json).toEqual({ ok: true });
      expect(result.execution).toMatchObject({ model, codeHash: null,
        loadedCode: { llmClient: null },
        unresolved: expect.arrayContaining(['gateway-runtime']) });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['gpt-5.6-luna:medium', (688 * 0.2 + 1922 * 1.2 + 3840 * 0.02) / 1_000_000],
    ['gpt-5.6-sol:xhigh', (688 * 4 + 1922 * 20 + 3840 * 0.4) / 1_000_000],
  ])('accounts for %s nonzero gateway usage through canonical model pricing', async (model, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ output_text: '{}',
      usage: { input_tokens: 4528, output_tokens: 1922, input_tokens_details: { cached_tokens: 3840 } },
    }), { status: 200 })));
    try {
      const { llmCall } = await import('../llm-client');
      const result = await llmCall({ model, messages: [{ role: 'user', content: 'json' }] });
      expect(result.costUsd).toBeCloseTo(expected, 8);
      expect(result.inputTokens).toBe(4528);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['gpt-5.4:medium', 'gpt-6-sol:high', 'gpt-6.1-sol:xhigh'])(
    'prices completed tiered %s usage instead of reporting a free response', async model => {
      const { priceFor } = await import('@papercusp/model-pricing');
      const price = priceFor(model)!;
      expect(price.longContext).toBeDefined();
      const expected = (688 * price.in + 1922 * price.out + 3840 * (price.cacheRead ?? price.in * 0.1)) / 1_000_000;
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ output_text: '{}',
        usage: { input_tokens: 4528, output_tokens: 1922, input_tokens_details: { cached_tokens: 3840 } },
      }))));
      try {
        const { llmCall } = await import('../llm-client');
        const result = await llmCall({ model, messages: [{ role: 'user', content: 'fixture' }] });
        expect(result.costUsd).toBeGreaterThan(0);
        expect(result.costUsd).toBeCloseTo(expected, 8);
      } finally { vi.unstubAllGlobals(); }
    },
  );

  it('counts cached input toward the completed request long-context tier', async () => {
    const model = 'gpt-6.1-sol:xhigh';
    const { priceFor, costFromTokens } = await import('@papercusp/model-pricing');
    const price = priceFor(model)!;
    const cached = price.longContext!.above;
    const input = cached + 1000;
    const baseCost = (1000 * price.in + cached * (price.cacheRead ?? price.in * 0.1) + 100 * price.out) / 1_000_000;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ output_text: '{}',
      usage: { input_tokens: input, output_tokens: 100, input_tokens_details: { cached_tokens: cached } },
    }))));
    try {
      const { llmCall } = await import('../llm-client');
      const result = await llmCall({ model, messages: [{ role: 'user', content: 'fixture' }] });
      expect(result.costUsd).toBeGreaterThan(baseCost);
      expect(result.costUsd).toBeCloseTo(costFromTokens(model, {
        requestInputTokens: input, inputTokens: 1000, cacheReadTokens: cached, outputTokens: 100,
      }).usd, 8);
    } finally { vi.unstubAllGlobals(); }
  });

  it('retains unknown cost when completed Codex usage cannot be priced', async () => {
    const pricing = await import('@papercusp/model-pricing');
    const unpriced = vi.spyOn(pricing, 'costFromTokens').mockReturnValue({ usd: 0, priced: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ output_text: '{}',
      usage: { input_tokens: 10, output_tokens: 4 },
    }))));
    try {
      const { llmCall } = await import('../llm-client');
      const error = await llmCall({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'fixture' }] })
        .then(() => null, error => error);
      expect(error).toMatchObject({ message: expect.stringMatching(/cannot be priced.*retain the admitted cost reservation/) });
      expect(error).not.toHaveProperty('costUsd');
    } finally { unpriced.mockRestore(); vi.unstubAllGlobals(); }
  });

  it('refuses an unpriced model before sending a request', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    try {
      const { llmCall } = await import('../llm-client');
      await expect(llmCall({ model: 'gpt-99-unknown', messages: [{ role: 'user', content: 'hello' }] })).rejects.toThrow(/no registered usage price/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([undefined, { input_tokens: 10 }, { input_tokens: -1, output_tokens: 3 }])('does not turn incomplete usage %j into a free response', async usage => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ output_text: '{}', usage }), { status: 200 })));
    try {
      const { llmCall } = await import('../llm-client');
      await expect(llmCall({ model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'hello' }] })).rejects.toThrow(/missing or invalid usage/);
    } finally { vi.unstubAllGlobals(); }
  });

  it('preserves caller temperature on the Anthropic transport', async () => {
    events.length = 0;
    events.push({ type: 'result', finalText: 'ok', tokensIn: 1, tokensOut: 1, costUsd: 0 });
    lastRunAgentChatOpts = undefined;
    const { llmCall } = await import('../llm-client');
    await llmCall({
      model: 'claude-haiku-4-5',
      temperature: 0.4,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect((lastRunAgentChatOpts as Record<string, unknown> | undefined)?.temperature).toBe(0.4);
  });
});

describe('llmCall successful usage completeness', () => {
  it.each([
    { label: 'absent', usage: {}, subtotal: 0, missing: true },
    { label: 'NaN', usage: { costUsd: NaN }, subtotal: 0, missing: true },
    { label: 'infinite', usage: { costUsd: Infinity }, subtotal: 0, missing: true },
    { label: 'negative', usage: { costUsd: -1 }, subtotal: 0, missing: true },
    { label: 'partial', usage: { costUsd: 0.42, unreportedFrames: 1 }, subtotal: 0.42, missing: true },
    { label: 'zero', usage: { costUsd: 0 }, subtotal: 0, missing: false },
    { label: 'positive', usage: { costUsd: 0.42, unreportedFrames: 0 }, subtotal: 0.42, missing: false },
  ])('retains $label usage without changing the successful response', async ({ usage, subtotal, missing }) => {
    events.length = 0;
    events.push({ type: 'result', finalText: '{"ok":true}', tokensIn: 12, tokensOut: 4, ...usage });
    try {
      const { llmCall } = await import('../llm-client');
      const result = await llmCall({ model: 'claude-sonnet-4-6', responseFormat: 'json',
        messages: [{ role: 'user', content: 'unchanged' }] });
      expect(result).toMatchObject({ text: '{"ok":true}', json: { ok: true },
        inputTokens: 12, outputTokens: 4, costUsd: subtotal });
      if (missing) expect(result).toMatchObject({ costUsdMeasurementMissing: true });
      else expect(result).not.toHaveProperty('costUsdMeasurementMissing');
      if ('unreportedFrames' in usage) expect(result).toMatchObject({ unreportedFrames: usage.unreportedFrames });
    } finally { events.length = 0; }
  });

  it('keeps the last known subtotal when a later result has invalid usage', async () => {
    events.length = 0;
    events.push({ type: 'result', finalText: 'partial', tokensIn: 12, tokensOut: 4, costUsd: 0.42 },
      { type: 'result', finalText: 'finished', tokensIn: 13, tokensOut: 5, costUsd: NaN });
    try {
      const { llmCall } = await import('../llm-client');
      expect(await llmCall({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'unchanged' }] }))
        .toMatchObject({ text: 'finished', costUsd: 0.42, costUsdMeasurementMissing: true });
    } finally { events.length = 0; }
  });

  it.each(['event', 'iterator'])('retains invalid-frame missingness when the %s then fails', async failureKind => {
    events.length = 0;
    events.push({ type: 'result', finalText: 'partial', tokensIn: 12, tokensOut: 4, costUsd: 0.42 },
      { type: 'result', finalText: 'finished', tokensIn: 13, tokensOut: 5, costUsd: NaN });
    if (failureKind === 'event') events.push({ type: 'error', message: 'failed after result' });
    else streamFailure = new Error('failed after result');
    try {
      const { llmCall } = await import('../llm-client');
      await expect(llmCall({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'unchanged' }] }))
        .rejects.toMatchObject({ costUsd: 0.42, costUsdMeasurementMissing: true });
    } finally { events.length = 0; streamFailure = undefined; }
  });
});

describe('llmCall subprocess error surfacing', () => {
  it.each([0, 0.42])('preserves reported failure spend $%s on the classified exception', async costUsd => {
    events.length = 0;
    const turn = { class: 'permanent', message: 'tool failed after inference', retryable: false };
    events.push({ type: 'error', message: turn.message, turn, costUsd });
    try {
      const { llmCall } = await import('../llm-client');
      const err = await llmCall({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'unchanged' }] }).catch(e => e);
      expect(isLlmCallError(err)).toBe(true);
      expect(err.turn).toBe(turn);
      expect(err).toMatchObject({ costUsd });
    } finally { events.length = 0; }
  });

  it('preserves already-reported result spend when an error follows it', async () => {
    events.length = 0;
    events.push({ type: 'result', finalText: 'partial', tokensIn: 12, tokensOut: 4, costUsd: 0.42 },
      { type: 'error', message: 'stream failed after its usage frame' });
    try {
      const { llmCall } = await import('../llm-client');
      const err = await llmCall({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'unchanged' }] }).catch(e => e);
      expect(err).toMatchObject({ costUsd: 0.42 });
    } finally { events.length = 0; }
  });

  it('preserves reported spend and original exception when the event iterator throws', async () => {
    events.length = 0;
    events.push({ type: 'result', finalText: 'partial', tokensIn: 12, tokensOut: 4, costUsd: 0.42 });
    const failure = new Error('iterator failed after reporting usage');
    streamFailure = failure;
    try {
      const { llmCall } = await import('../llm-client');
      const err = await llmCall({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'unchanged' }] }).catch(e => e);
      expect(err).toBe(failure);
      expect(err).toMatchObject({ costUsd: 0.42 });
    } finally { events.length = 0; streamFailure = undefined; }
  });

  it.each([undefined, -1, NaN, Infinity])('keeps unreported/invalid failure spend %s unknown', async costUsd => {
    events.length = 0;
    events.push({ type: 'error', message: 'failure before usage', costUsd, unreportedFrames: 1 });
    try {
      const { llmCall } = await import('../llm-client');
      const err = await llmCall({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'unchanged' }] }).catch(e => e);
      expect(err).not.toHaveProperty('costUsd');
      expect(err).toMatchObject({ unreportedFrames: 1 });
    } finally { events.length = 0; }
  });

  it('folds the stderr tail into the thrown LlmCallError message (un-governed path)', async () => {
    events.length = 0;
    events.push({
      type: 'error',
      message: 'claude-code exited 1',
      stderr: 'Error: some real diagnostic from the CLI\n  at spawn',
    });
    const { llmCall } = await import('../llm-client');
    const err = await llmCall({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 8,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isLlmCallError(err)).toBe(true);
    expect((err as Error).message).toContain('claude-code exited 1');
    expect((err as Error).message).toContain('some real diagnostic from the CLI');
  });

  it('still classifies a rate-limit printed only to stderr', async () => {
    events.length = 0;
    events.push({
      type: 'error',
      message: 'claude-code exited 1',
      stderr: 'API Error: 429 rate limit exceeded, try again in 30 seconds',
    });
    const { llmCall } = await import('../llm-client');
    const err = await llmCall({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 8,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isLlmCallError(err)).toBe(true);
    if (isLlmCallError(err)) expect(err.turn.class).toBe('rate_limited');
  });
});

describe('llmCall transport evidence (WI-10005738)', () => {
  const diagnostic = { callId: 'local-call', attempt: 2, phase: 'response', observedAt: '2026-10-03T01:00:00Z',
    label: 'anthropic-direct', endpointOrigin: 'http://127.0.0.1:8788', loopback: true,
    requestedAccount: null, servedAccount: 'actual-serving-account', providerRequestId: 'req_bound', status: 429 };

  it('keeps resolved egress in the thrown error without changing the classified turn', async () => {
    diagnostics.push(diagnostic);
    const turn = { class: 'rate_limited', message: '429 upstream refusal', retryable: true, retryAfterMs: 12000 };
    events.length = 0;
    events.push({ type: 'error', message: turn.message, turn });
    try {
      const { llmCall } = await import('../llm-client');
      const onDiagnostic = vi.fn();
      const err = await llmCall({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'secret-prompt' }], onDiagnostic }).catch(e => e);
      expect(isLlmCallError(err)).toBe(true);
      expect(err.turn).toBe(turn);
      expect(err.message).toBe(turn.message);
      expect(err.transportDiagnostics).toEqual([diagnostic]);
      expect(onDiagnostic).toHaveBeenCalledWith(diagnostic);
      expect(err.promptSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(err)).not.toContain('secret-prompt');
    } finally { diagnostics.length = 0; events.length = 0; }
  });

  it('retains sanitized attempts on successful-call receipts', async () => {
    diagnostics.push({ ...diagnostic, phase: 'request', status: null, servedAccount: null, providerRequestId: null },
      { ...diagnostic, status: 200 });
    events.length = 0;
    events.push({ type: 'result', finalText: 'ok', tokensIn: 1, tokensOut: 1, costUsd: 0 });
    try {
      const { llmCall } = await import('../llm-client');
      const result = await llmCall({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'unchanged prompt' }] });
      expect(result.raw).toMatchObject({ transportDiagnostics: diagnostics, promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(result.text).toBe('ok');
      expect(result.execution).toMatchObject({ model: 'claude-sonnet-4-6', codeHash: null,
        loadedCode: { llmClient: null },
        unresolved: expect.arrayContaining(['agent-chat-runtime', 'transport-runtime']) });
    } finally { diagnostics.length = 0; events.length = 0; }
  });
});

describe('llmCall priority default (EI-315: llm-testing lane starvation)', () => {
  it('preserves capped generation deltas and surfaces the provider stop reason', async () => {
    events.length = 0;
    events.push(
      { type: 'delta', text: '{"partial":' },
      { type: 'delta', text: 'true' },
      {
        type: 'result',
        finalText: '',
        tokensIn: 12,
        tokensOut: 300,
        costUsd: 0.01,
        stopReason: 'max_tokens',
      },
    );
    const { llmCall } = await import('../llm-client');

    const result = await llmCall({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 300,
      responseFormat: 'json',
    });

    expect(result.text).toBe('{"partial":true');
    expect(result.json).toBeNull();
    expect(result.outputTokens).toBe(300);
    expect(result.stopReason).toBe('max_tokens');
    expect(result.execution).toMatchObject({ codeHash: null, loadedCode: { llmClient: null } });
  });

  it('defaults the anthropic-direct path to the "llm-testing" priority label when the caller sets none', async () => {
    events.length = 0;
    events.push({ type: 'result', finalText: 'ok', tokensIn: 1, tokensOut: 1, costUsd: 0 });
    lastRunAgentChatOpts = undefined;
    const { llmCall } = await import('../llm-client');
    await llmCall({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 8,
    });
    // Before this fix, an unset priority rode `undefined` through to the gateway's
    // `tierOf()`, which falls back to the bottom `default` band (tier 5) — the most
    // aggressively AIMD-shed lane, and the literal root cause of this item's
    // "17/17 attempts 429-capped over 7h". It must now land in the shared gym/benchmark
    // batch band (tier 4) instead.
    // WI-5217: `lastRunAgentChatOpts` is narrowed to the LITERAL `undefined` here (the
    // preceding `= undefined` reset, with no call TS's CFA can see reassigning it before
    // this read — the mock's own reassignment lives in a separately-registered vi.mock
    // factory, invisible to this function's flow analysis) — `?.priority` on a value
    // narrowed to exactly `undefined` then errors TS2339 on the `never` non-nullable arm.
    // Re-assert the declared type to read the real (runtime-populated) value.
    expect((lastRunAgentChatOpts as Record<string, unknown> | undefined)?.priority).toBe('llm-testing');
  });

  it('an explicit caller priority still wins over the llm-testing default', async () => {
    events.length = 0;
    events.push({ type: 'result', finalText: 'ok', tokensIn: 1, tokensOut: 1, costUsd: 0 });
    lastRunAgentChatOpts = undefined;
    const { llmCall } = await import('../llm-client');
    await llmCall({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 8,
      priority: 'gym',
    });
    // WI-5217: see the comment on the sibling assertion above — same narrowed-to-`undefined` quirk.
    expect((lastRunAgentChatOpts as Record<string, unknown> | undefined)?.priority).toBe('gym');
  });

  it('forwards a stable owner id to runAgentChat for gateway attribution', async () => {
    events.length = 0;
    events.push({ type: 'result', finalText: 'ok', tokensIn: 1, tokensOut: 1, costUsd: 0 });
    lastRunAgentChatOpts = undefined;
    const { llmCall } = await import('../llm-client');
    await llmCall({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      model: 'claude-haiku-4-5-20251001',
      ownerId: 'system:work-item-admission-bulk-dedup:run-1',
    });
    expect((lastRunAgentChatOpts as Record<string, unknown> | undefined)?.ownerId).toBe(
      'system:work-item-admission-bulk-dedup:run-1',
    );
  });

  // WI-2144763. This is THE chokepoint for headers-source spend attribution: every
  // `source:'headers'` usage row gets its identity from the single `usageAttribution`
  // object built here, so if this forwarding regresses, all 18,228 such rows (~$755)
  // silently go back to harness_slug NULL / '(unattributed)' with nothing failing.
  // Asserted at runAgentChat's boundary for the same reason the priority tests above are:
  // the anthropic-direct path has no HTTP layer to spy on. The `role` half is pinned
  // alongside so a future edit cannot drop one while keeping the other.
  it('WI-2144763: forwards the caller harness into usageAttribution alongside the role label', async () => {
    events.length = 0;
    events.push({ type: 'result', finalText: 'ok', tokensIn: 1, tokensOut: 1, costUsd: 0 });
    lastRunAgentChatOpts = undefined;
    const { llmCall } = await import('../llm-client');
    await llmCall({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      model: 'claude-haiku-4-5-20251001',
      priority: 'scout',
      harnessSlug: 'papercusp-public-site-pot',
    });
    expect((lastRunAgentChatOpts as Record<string, unknown> | undefined)?.usageAttribution).toEqual({
      role: 'scout',
      harnessSlug: 'papercusp-public-site-pot',
    });
  });

  // The other side of the contract: a caller that genuinely does not know its harness
  // (workspace-global work) must leave the field undefined so the host records an honest
  // NULL. A fix that fabricated a slug here would be worse than the gap it closed.
  it('WI-2144763: leaves usageAttribution.harnessSlug undefined when the caller does not supply one', async () => {
    events.length = 0;
    events.push({ type: 'result', finalText: 'ok', tokensIn: 1, tokensOut: 1, costUsd: 0 });
    lastRunAgentChatOpts = undefined;
    const { llmCall } = await import('../llm-client');
    await llmCall({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      model: 'claude-haiku-4-5-20251001',
    });
    const attribution = (lastRunAgentChatOpts as Record<string, unknown> | undefined)
      ?.usageAttribution as Record<string, unknown> | undefined;
    expect(attribution?.role).toBe('llm-testing');
    expect(attribution?.harnessSlug).toBeUndefined();
  });
});
